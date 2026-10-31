
import crypto from 'node:crypto';
import axios from 'axios';
import type { RawMusicAccount } from '../accounts';
import type { AccountStore } from './accounts';

type BackupStore = AccountStore & {
  replaceAll?: (accounts: RawMusicAccount[]) => void;
  setChangeListener?: (listener?: () => void) => void;
};

type BackupMode = 'encrypted-scrypt' | 'encrypted-pbkdf2' | 'plaintext';

type RemoteFile = {
  path: string;
  sha: string;
  accounts: RawMusicAccount[];
  mode: BackupMode;
};

const ENC_PATH = 'accounts/accounts.enc';
const JSON_PATH = 'accounts/accounts.json';
const AAD = Buffer.from('wow-origin-account-backup:v1');

function validateAccounts(value: unknown): RawMusicAccount[] {
  if (!Array.isArray(value)) {
    throw new Error('帳號備份格式錯誤：accounts 必須是陣列');
  }

  const result: RawMusicAccount[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const account = item as RawMusicAccount;
    const key = String(account.api_access_key || '').trim();

    if (!key || seen.has(key)) continue;

    seen.add(key);

    result.push({
      platform: account.platform,
      name: account.name,
      cookie: account.cookie,
      api_access_key: key,
      stateless: account.stateless,
      useLuoxue: account.useLuoxue,
      lxSource: account.lxSource,
      deviceId: account.deviceId,
      deviceState: account.deviceState
    });
  }

  return result;
}

function parsePlaintext(text: string): RawMusicAccount[] {
  const parsed = JSON.parse(text);

  if (Array.isArray(parsed)) {
    return validateAccounts(parsed);
  }

  if (parsed && Array.isArray(parsed.accounts)) {
    return validateAccounts(parsed.accounts);
  }

  throw new Error('accounts.json 格式錯誤');
}

function deriveScrypt(key: string): Buffer {
  return crypto.scryptSync(key, 'wow-origin-account-backup-v1', 32);
}

function encryptScrypt(accounts: RawMusicAccount[], password: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveScrypt(password), iv);

  cipher.setAAD(AAD);

  const payload = {
    format: 'wow-origin-account-backup',
    version: 1,
    updatedAt: new Date().toISOString(),
    accounts
  };

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);

  return JSON.stringify({
    format: 'wow-origin-encrypted-backup',
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64')
  }, null, 2);
}

function decryptScrypt(text: string, password: string): RawMusicAccount[] {
  const envelope = JSON.parse(text);

  if (
    envelope?.format !== 'wow-origin-encrypted-backup' ||
    envelope?.version !== 1
  ) {
    throw new Error('不支援的 Scrypt 備份格式');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveScrypt(password),
    Buffer.from(envelope.iv, 'base64')
  );

  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');

  const payload = JSON.parse(decrypted);

  if (
    payload?.format !== 'wow-origin-account-backup' ||
    payload?.version !== 1
  ) {
    throw new Error('Scrypt 備份內容格式錯誤');
  }

  return validateAccounts(payload.accounts);
}

function derivePbkdf2(password: string, salt: Buffer, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
}

function encryptPbkdf2(accounts: RawMusicAccount[], password: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const iterations = 210000;

  const key = derivePbkdf2(password, salt, iterations);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    accounts
  };

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);

  return JSON.stringify({
    version: 2,
    algorithm: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  }, null, 2);
}

function decryptPbkdf2(text: string, password: string): RawMusicAccount[] {
  const envelope = JSON.parse(text);

  if (
    envelope?.version !== 2 ||
    envelope?.algorithm !== 'aes-256-gcm' ||
    envelope?.kdf !== 'pbkdf2-sha256'
  ) {
    throw new Error('不支援的 PBKDF2 備份格式');
  }

  const iterations = Number(envelope.iterations);

  if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 1000000) {
    throw new Error('PBKDF2 迭代次數無效');
  }

  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const data = Buffer.from(envelope.data, 'base64');

  if (salt.length < 8 || iv.length !== 12 || tag.length !== 16 || !data.length) {
    throw new Error('PBKDF2 備份資料不完整');
  }

  const key = derivePbkdf2(password, salt, iterations);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final()
  ]).toString('utf8');

  return parsePlaintext(decrypted);
}

function decodeEncrypted(
  text: string,
  password: string
): { accounts: RawMusicAccount[]; mode: BackupMode } {
  const parsed = JSON.parse(text);

  if (parsed?.format === 'wow-origin-encrypted-backup') {
    return {
      accounts: decryptScrypt(text, password),
      mode: 'encrypted-scrypt'
    };
  }

  if (
    parsed?.version === 2 &&
    parsed?.algorithm === 'aes-256-gcm' &&
    parsed?.kdf === 'pbkdf2-sha256'
  ) {
    return {
      accounts: decryptPbkdf2(text, password),
      mode: 'encrypted-pbkdf2'
    };
  }

  throw new Error('無法識別 accounts.enc 加密格式');
}

export class GitHubAccountBackup {
  private readonly store: BackupStore;
  private readonly repo: string;
  private readonly token: string;
  private readonly password: string;
  private readonly branch: string;
  private readonly intervalMs: number;

  private mode: BackupMode = 'encrypted-scrypt';
  private targetPath = ENC_PATH;
  private currentSha?: string;
  private lastSnapshot = '';
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private initialized = false;
  private stopped = false;

  constructor(options: {
    store: BackupStore;
    repo: string;
    token: string;
    encryptionKey: string;
    branch?: string;
    intervalMs?: number;
  }) {
    if (!options.store.replaceAll) {
      throw new Error('AccountStore 不支援 replaceAll');
    }

    if (!options.repo || !options.token) {
      throw new Error('GitHub 備份設定不完整');
    }

    if (options.encryptionKey.length < 32) {
      throw new Error('ACCOUNT_SYNC_KEY 至少需要 32 個字元');
    }

    this.store = options.store;
    this.repo = options.repo.trim();
    this.token = options.token.trim();
    this.password = options.encryptionKey;
    this.branch = options.branch || 'main';
    this.intervalMs = Math.max(
      5000,
      Math.min(60000, options.intervalMs || 5000)
    );
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wow-origin-account-backup'
    };
  }

  private fileUrl(filePath: string): string {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    return `https://api.github.com/repos/${this.repo}/contents/${encoded}`;
  }

  private async readFile(filePath: string): Promise<RemoteFile | null> {
    try {
      const response = await axios.get(this.fileUrl(filePath), {
        params: { ref: this.branch },
        headers: this.headers(),
        timeout: 20000
      });

      const content = String(response.data?.content || '').replace(/\s/g, '');

      if (!content) {
        throw new Error(`GitHub 備份檔案為空：${filePath}`);
      }

      const text = Buffer.from(content, 'base64').toString('utf8');
      let accounts: RawMusicAccount[];
      let mode: BackupMode;

      if (filePath === JSON_PATH) {
        accounts = parsePlaintext(text);
        mode = 'plaintext';
      } else {
        const decoded = decodeEncrypted(text, this.password);
        accounts = decoded.accounts;
        mode = decoded.mode;
      }

      const sha = String(response.data?.sha || '');

      if (!sha) {
        throw new Error('GitHub 備份缺少 SHA');
      }

      return { path: filePath, sha, accounts, mode };
    } catch (error: any) {
      if (error?.response?.status === 404) return null;

      throw error;
    }
  }

  private async readRemote(): Promise<RemoteFile | null> {
    // 優先使用加密檔案。
    const encrypted = await this.readFile(ENC_PATH);

    if (encrypted) return encrypted;

    // 沒有加密檔案才讀取明文檔案。
    return this.readFile(JSON_PATH);
  }

  async restore(): Promise<void> {
    const remote = await this.readRemote();
    const local = validateAccounts(this.store.list());

    if (!remote) {
      this.initialized = true;
      this.lastSnapshot = JSON.stringify(local);

      console.info('[account-backup] GitHub 尚無帳號備份');

      return;
    }

    this.mode = remote.mode;
    this.targetPath = remote.path;
    this.currentSha = remote.sha;

    // 遠端帳號優先；保留遠端沒有的本機帳號。
    const merged = new Map<string, RawMusicAccount>();

    for (const account of local) {
      merged.set(String(account.api_access_key), account);
    }

    for (const account of remote.accounts) {
      merged.set(String(account.api_access_key), account);
    }

    const accounts = [...merged.values()];

    if (accounts.length > 0) {
      this.store.replaceAll!(accounts);
    }

    this.lastSnapshot = JSON.stringify(accounts);
    this.initialized = true;

    if (JSON.stringify(accounts) !== JSON.stringify(remote.accounts)) {
      await this.flush();
    }

    console.info(
      `[account-backup] 已從 GitHub 還原 ${remote.accounts.length} 個帳號，模式：${this.mode}`
    );
  }

  async start(): Promise<void> {
    if (!this.initialized) {
      await this.restore();
    }

    if (this.timer || this.stopped) return;

    this.store.setChangeListener?.(() => {
      void this.flush().catch(error => {
        console.error('[account-backup] 帳號變更同步失敗', this.safeMessage(error));
      });
    });

    await this.flush();

    this.timer = setInterval(() => {
      void this.flush().catch(error => {
        console.error('[account-backup] 定時同步失敗', this.safeMessage(error));
      });
    }, this.intervalMs);

    this.timer.unref?.();

    console.info(`[account-backup] GitHub 備份已啟動，模式：${this.mode}`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);

    this.timer = undefined;
    this.store.setChangeListener?.(undefined);

    try {
      await this.flush();
    } finally {
      this.stopped = true;
    }
  }

  async flush(): Promise<void> {
    if (!this.initialized || this.stopped) return;

    if (this.inFlight) {
      await this.inFlight;
      return this.flush();
    }

    const accounts = validateAccounts(this.store.list());

    // 空資料不得覆蓋 GitHub 上的有效備份。
    if (accounts.length === 0) {
      console.warn('[account-backup] 本機帳號為空，取消同步以保護遠端備份');
      return;
    }

    const snapshot = JSON.stringify(accounts);

    if (snapshot === this.lastSnapshot) return;

    this.inFlight = this.write(accounts);

    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async write(accounts: RawMusicAccount[]): Promise<void> {
    const plaintext = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      accounts
    }, null, 2);

    let content: string;

    if (this.mode === 'plaintext') {
      content = plaintext;
    } else if (this.mode === 'encrypted-pbkdf2') {
      content = encryptPbkdf2(accounts, this.password);
    } else {
      content = encryptScrypt(accounts, this.password);
    }

    const body: Record<string, string> = {
      message: 'chore: update wow-origin account backup',
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: this.branch
    };

    if (this.currentSha) {
      body.sha = this.currentSha;
    }

    const url = this.fileUrl(this.targetPath);

    try {
      const response = await axios.put(url, body, {
        headers: this.headers(),
        timeout: 20000
      });

      this.currentSha = response.data?.content?.sha;
      this.lastSnapshot = JSON.stringify(accounts);

      console.info(
        `[account-backup] 已同步 ${accounts.length} 個帳號，模式：${this.mode}`
      );
    } catch (error: any) {
      if (![409, 422].includes(error?.response?.status)) {
        throw error;
      }

      const latest = await this.readFile(this.targetPath);

      if (latest) {
        if (JSON.stringify(latest.accounts) === JSON.stringify(accounts)) {
          this.currentSha = latest.sha;
          this.lastSnapshot = JSON.stringify(accounts);
          return;
        }

        this.currentSha = latest.sha;
        body.sha = latest.sha;
      } else {
        this.currentSha = undefined;
        delete body.sha;
      }

      const response = await axios.put(url, body, {
        headers: this.headers(),
        timeout: 20000
      });

      this.currentSha = response.data?.content?.sha;
      this.lastSnapshot = JSON.stringify(accounts);
    }
  }

  private safeMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      return error.response?.status
        ? `HTTP ${error.response.status}`
        : error.code || 'network error';
    }

    return error instanceof Error ? error.message : 'unknown error';
  }
}

export function createGitHubAccountBackup(
  store: AccountStore
): GitHubAccountBackup | null {
  const repo = process.env.GITHUB_DATA_REPO || '';
  const token = process.env.GITHUB_TOKEN || '';
  const encryptionKey = process.env.ACCOUNT_SYNC_KEY || '';

  // 沒有設定備份環境變數時，不影響原本專案啟動。
  if (!repo || !token || !encryptionKey) {
    console.warn('[account-backup] GitHub 備份環境變數未完整設定，略過雲端同步');
    return null;
  }

  return new GitHubAccountBackup({
    store: store as BackupStore,
    repo,
    token,
    encryptionKey,
    branch: process.env.ACCOUNT_SYNC_BRANCH || 'main',
    intervalMs: Number(process.env.ACCOUNT_SYNC_INTERVAL_MS || 5000)
  });
}
