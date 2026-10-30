
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import axios, { type AxiosError } from 'axios';
import type { RawMusicAccount } from '../accounts';
import type { AccountStore } from './accounts';

type ReplaceableAccountStore = AccountStore & {
  replaceAll?: (accounts: RawMusicAccount[]) => void;
  setChangeListener?: (listener?: () => void) => void;
};

type BackupPayload = {
  format: 'wow-origin-account-backup';
  version: 1;
  updatedAt: string;
  accounts: RawMusicAccount[];
};

type RemoteBackup = {
  accounts: RawMusicAccount[];
  sha: string;
  encrypted: boolean;
  encryptedWithCurrentKey: boolean;
};

type GitHubAccountBackupOptions = {
  store: ReplaceableAccountStore;
  repo: string;
  token: string;
  encryptionKey: string;
  previousEncryptionKeys?: string[];
  branch?: string;
  filePath?: string;
  legacyFilePath?: string;
  intervalMs?: number;
};

const AAD = Buffer.from('wow-origin-account-backup:v1');
const KDF_SALT = 'wow-origin-account-backup-v1';
const DEFAULT_FILE_PATH = 'accounts/accounts.enc';
const DEFAULT_LEGACY_FILE_PATH = 'accounts/data.db.b64';
const DEFAULT_INTERVAL_MS = 5000;

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function serializeAccounts(accounts: RawMusicAccount[]): string {
  return JSON.stringify(accounts) ?? '[]';
}

function validateAccounts(value: unknown): RawMusicAccount[] {
  if (!Array.isArray(value)) {
    throw new Error('GitHub 帳號備份格式錯誤：accounts 必須是陣列');
  }

  const seen = new Set<string>();

  return value.filter((item): item is RawMusicAccount => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return false;
    }

    const key = String(
      (item as RawMusicAccount).api_access_key || ''
    ).trim();

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function mergeAccounts(
  remote: RawMusicAccount[],
  local: RawMusicAccount[]
): RawMusicAccount[] {
  const merged = new Map<string, RawMusicAccount>();

  remote.forEach((account) => {
    merged.set(String(account.api_access_key), account);
  });

  // 本機同 key 帳號優先，同時保留遠端缺少的帳號。
  local.forEach((account) => {
    merged.set(String(account.api_access_key), account);
  });

  return [...merged.values()];
}

function encryptPayload(
  payload: BackupPayload,
  key: Buffer
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  cipher.setAAD(AAD);

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);

  return JSON.stringify({
    format: 'wow-origin-encrypted-backup',
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
}

/**
 * 相容目前格式與舊版 accounts.enc。
 *
 * 目前格式：
 * {
 *   format: "wow-origin-encrypted-backup",
 *   version: 1,
 *   iv,
 *   tag,
 *   ciphertext
 * }
 *
 * 舊版格式：
 * {
 *   version: 1,
 *   algorithm: "aes-256-gcm",
 *   iv,
 *   tag,
 *   ciphertext
 * }
 *
 * 舊版可能沒有 format 欄位，也可能沒有使用 AAD。
 */
function decryptPayload(
  envelopeText: string,
  keys: Buffer[]
): {
  payload: BackupPayload;
  keyIndex: number;
  canonical: boolean;
} {
  let envelope: any;

  try {
    envelope = JSON.parse(envelopeText);
  } catch (error) {
    throw new Error(
      'GitHub 帳號備份不是有效的加密 JSON',
      { cause: error }
    );
  }

  const validFormat =
    !envelope?.format ||
    envelope.format === 'wow-origin-encrypted-backup';

  const validAlgorithm =
    !envelope?.algorithm ||
    envelope.algorithm === 'aes-256-gcm';

  if (
    envelope?.version !== 1 ||
    !validFormat ||
    !validAlgorithm ||
    typeof envelope?.iv !== 'string' ||
    typeof envelope?.tag !== 'string' ||
    typeof envelope?.ciphertext !== 'string'
  ) {
    throw new Error('GitHub 帳號備份版本或格式不受支援');
  }

  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  if (
    iv.length !== 12 ||
    tag.length !== 16 ||
    ciphertext.length === 0
  ) {
    throw new Error('GitHub 帳號備份加密欄位長度錯誤');
  }

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    // 先嘗試目前使用的 AAD 格式，再嘗試舊版無 AAD 格式。
    for (const useAad of [true, false]) {
      try {
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          keys[keyIndex],
          iv
        );

        if (useAad) {
          decipher.setAAD(AAD);
        }

        decipher.setAuthTag(tag);

        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final()
        ]).toString('utf8');

        const decoded = JSON.parse(plaintext);

        const accountsValue = Array.isArray(decoded)
          ? decoded
          : decoded?.accounts;

        if (
          decoded &&
          !Array.isArray(decoded) &&
          (
            (decoded.format &&
              decoded.format !== 'wow-origin-account-backup') ||
            (
              decoded.version !== undefined &&
              decoded.version !== 1
            )
          )
        ) {
          throw new Error('備份資料版本不受支援');
        }

        const accounts = validateAccounts(accountsValue);

        const payload: BackupPayload = {
          format: 'wow-origin-account-backup',
          version: 1,
          updatedAt:
            typeof decoded?.updatedAt === 'string'
              ? decoded.updatedAt
              : new Date(0).toISOString(),
          accounts
        };

        return {
          payload,
          keyIndex,
          canonical:
            envelope.format === 'wow-origin-encrypted-backup' &&
            useAad
        };
      } catch {
        // 不輸出密鑰或解密內容，繼續嘗試其他相容方式。
      }
    }
  }

  throw new Error(
    'GitHub 帳號備份解密失敗；請確認 ACCOUNT_SYNC_KEY 或舊備份密鑰'
  );
}

function statusOf(error: unknown): number | undefined {
  return (error as AxiosError | undefined)?.response?.status;
}

function decodeStoredField(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function accountsFromLegacySqlite(
  databaseBytes: Buffer
): RawMusicAccount[] {
  if (
    !databaseBytes
      .subarray(0, 16)
      .equals(Buffer.from('SQLite format 3\0'))
  ) {
    throw new Error('Not a SQLite database');
  }

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wow-origin-account-restore-')
  );

  const filename = path.join(temporaryDirectory, 'legacy.db');

  let database: DatabaseSync | undefined;

  try {
    fs.writeFileSync(filename, databaseBytes);

    database = new DatabaseSync(filename);

    const columns = (
      database.prepare('PRAGMA table_info(accounts)').all() as
        Array<{ name: string }>
    ).map((column) => column.name);

    if (!columns.length || !columns.includes('api_access_key')) {
      throw new Error('SQLite backup has no accounts table');
    }

    const optional = (name: string, alias = name) =>
      columns.includes(name)
        ? `${name} AS ${alias}`
        : `NULL AS ${alias}`;

    const sql = `SELECT ${[
      optional('platform'),
      optional('name'),
      optional('cookie'),
      optional('api_access_key'),
      optional('stateless'),
      optional('use_luoxue'),
      optional('lx_source'),
      optional('deviceId', 'device_id'),
      optional('device_state')
    ].join(', ')} FROM accounts ORDER BY id ASC`;

    const rows = database
      .prepare(sql)
      .all() as Array<Record<string, unknown>>;

    return validateAccounts(
      rows.map((row) => ({
        platform: decodeStoredField(row.platform),
        name: decodeStoredField(row.name),
        cookie: decodeStoredField(row.cookie),
        api_access_key: String(row.api_access_key || ''),
        stateless: decodeStoredField(row.stateless),
        useLuoxue: decodeStoredField(row.use_luoxue),
        lxSource: decodeStoredField(row.lx_source),
        deviceId: decodeStoredField(row.device_id),
        deviceState: decodeStoredField(row.device_state)
      }))
    );
  } finally {
    database?.close();

    fs.rmSync(temporaryDirectory, {
      recursive: true,
      force: true
    });
  }
}

function decodeRemoteFile(
  fileBytes: Buffer,
  keys: Buffer[]
): {
  accounts: RawMusicAccount[];
  encrypted: boolean;
  encryptedWithCurrentKey: boolean;
} {
  const text = fileBytes.toString('utf8').trim();

  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed: any;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    // 重要修正：
    // 舊版 accounts.enc 沒有 format 欄位，
    // 但仍然有 version、algorithm、iv、tag、ciphertext。
    const isEncryptedEnvelope =
      parsed?.version === 1 &&
      (
        parsed?.format === 'wow-origin-encrypted-backup' ||
        (
          parsed?.algorithm === 'aes-256-gcm' &&
          typeof parsed?.iv === 'string' &&
          typeof parsed?.tag === 'string' &&
          typeof parsed?.ciphertext === 'string'
        )
      );

    if (isEncryptedEnvelope) {
      const decrypted = decryptPayload(text, keys);

      return {
        accounts: decrypted.payload.accounts,
        encrypted: true,

        // 舊版沒有 format 或使用舊式無 AAD，
        // 必須重新寫成目前標準格式。
        encryptedWithCurrentKey:
          decrypted.keyIndex === 0 &&
          decrypted.canonical
      };
    }

    if (Array.isArray(parsed)) {
      return {
        accounts: validateAccounts(parsed),
        encrypted: false,
        encryptedWithCurrentKey: false
      };
    }

    if (Array.isArray(parsed?.accounts)) {
      return {
        accounts: validateAccounts(parsed.accounts),
        encrypted: false,
        encryptedWithCurrentKey: false
      };
    }
  }

  if (
    fileBytes
      .subarray(0, 16)
      .equals(Buffer.from('SQLite format 3\0'))
  ) {
    return {
      accounts: accountsFromLegacySqlite(fileBytes),
      encrypted: false,
      encryptedWithCurrentKey: false
    };
  }

  // 舊版本曾將 SQLite 檔案以 base64 文字儲存在
  // accounts/data.db.b64。
  try {
    const decoded = Buffer.from(text, 'base64');

    if (
      decoded
        .subarray(0, 16)
        .equals(Buffer.from('SQLite format 3\0'))
    ) {
      return {
        accounts: accountsFromLegacySqlite(decoded),
        encrypted: false,
        encryptedWithCurrentKey: false
      };
    }

    const decodedText = decoded.toString('utf8').trim();

    if (
      decodedText.startsWith('{') ||
      decodedText.startsWith('[')
    ) {
      const parsed = JSON.parse(decodedText);

      if (Array.isArray(parsed)) {
        return {
          accounts: validateAccounts(parsed),
          encrypted: false,
          encryptedWithCurrentKey: false
        };
      }

      if (Array.isArray(parsed?.accounts)) {
        return {
          accounts: validateAccounts(parsed.accounts),
          encrypted: false,
          encryptedWithCurrentKey: false
        };
      }
    }
  } catch {
    // 使用下方明確錯誤訊息。
  }

  throw new Error(
    'GitHub 備份格式無法識別；舊資料未被覆蓋'
  );
}

export class GitHubAccountBackup {
  private readonly store: ReplaceableAccountStore;
  private readonly repo: string;
  private readonly token: string;
  private readonly key: Buffer;
  private readonly readKeys: Buffer[];
  private readonly branch: string;
  private readonly filePath: string;
  private readonly legacyFilePath: string;
  private readonly intervalMs: number;
  private readonly apiUrl: string;

  private currentSha?: string;
  private lastDigest = '';
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private initialized = false;
  private stopped = false;

  constructor(options: GitHubAccountBackupOptions) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(
        options.repo.trim()
      )
    ) {
      throw new Error(
        'GITHUB_DATA_REPO 格式必須是 owner/repository'
      );
    }

    if (!options.token.trim()) {
      throw new Error('GITHUB_TOKEN 不可為空');
    }

    if (options.encryptionKey.length < 32) {
      throw new Error(
        'ACCOUNT_SYNC_KEY 至少需要 32 個字元，請使用新的隨機長密鑰'
      );
    }

    const filePath = (
      options.filePath || DEFAULT_FILE_PATH
    ).replace(/^\/+/, '');

    const legacyFilePath = (
      options.legacyFilePath || DEFAULT_LEGACY_FILE_PATH
    ).replace(/^\/+/, '');

    const invalidPath = (value: string) =>
      !value ||
      value.split('/').some(
        (part) => !part || part === '.' || part === '..'
      );

    if (invalidPath(filePath)) {
      throw new Error('ACCOUNT_SYNC_PATH 路徑無效');
    }

    if (invalidPath(legacyFilePath)) {
      throw new Error('ACCOUNT_SYNC_LEGACY_PATH 路徑無效');
    }

    if (!options.store.replaceAll) {
      throw new Error(
        '帳號儲存層不支援 replaceAll，無法安全還原 GitHub 備份'
      );
    }

    this.store = options.store;
    this.repo = options.repo.trim();
    this.token = options.token.trim();

    this.key = crypto.scryptSync(
      options.encryptionKey,
      KDF_SALT,
      32
    );

    // 讀取時相容舊版常見的密鑰衍生方式。
    // 寫入時仍固定使用目前的 scrypt 密鑰。
    const candidates: Buffer[] = [this.key];

    const addCandidate = (candidate: Buffer) => {
      if (candidate.length !== 32) return;

      if (
        !candidates.some((existing) =>
          existing.equals(candidate)
        )
      ) {
        candidates.push(candidate);
      }
    };

    const previousKeys = [
      ...new Set(
        (options.previousEncryptionKeys || [])
          .map((value) => value.trim())
          .filter(
            (value) =>
              value && value !== options.encryptionKey
          )
      )
    ];

    for (const value of [
      options.encryptionKey,
      ...previousKeys
    ]) {
      addCandidate(
        crypto
          .createHash('sha256')
          .update(value, 'utf8')
          .digest()
      );

      const raw = Buffer.from(value, 'utf8');

      if (raw.length === 32) {
        addCandidate(raw);
      }

      addCandidate(
        crypto.scryptSync(value, KDF_SALT, 32)
      );
    }

    this.readKeys = candidates;

    this.branch = options.branch?.trim() || 'main';
    this.filePath = filePath;
    this.legacyFilePath = legacyFilePath;

    this.intervalMs = Math.max(
      1000,
      Math.min(
        60_000,
        options.intervalMs || DEFAULT_INTERVAL_MS
      )
    );

    const encodedPath = this.filePath
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    this.apiUrl =
      `https://api.github.com/repos/${this.repo}/contents/${encodedPath}`;
  }

  /** 必須在 loadAccountSessions 之前呼叫，確保新實例先取得雲端帳號。 */
  async restore(): Promise<void> {
    const remote = await this.readRemote();
    const local = validateAccounts(this.store.list());

    if (!remote) {
      this.currentSha = undefined;
      this.lastDigest = '';
      this.initialized = true;

      console.info(
        '[account-backup] GitHub 尚無備份，將以本機帳號建立第一份加密備份'
      );

      return;
    }

    this.currentSha =
      remote.path === this.filePath
        ? remote.sha
        : undefined;

    const merged =
      local.length > 0
        ? mergeAccounts(remote.accounts, local)
        : remote.accounts;

    if (
      digest(serializeAccounts(local)) !==
      digest(serializeAccounts(merged))
    ) {
      this.store.replaceAll!(merged);
    }

    this.lastDigest =
      remote.path === this.filePath &&
      remote.encryptedWithCurrentKey
        ? digest(serializeAccounts(remote.accounts))
        : '';

    this.initialized = true;

    // 舊格式解密成功後，會在這裡重新寫成標準加密格式。
    if (
      digest(serializeAccounts(merged)) !==
      this.lastDigest
    ) {
      await this.flush();
    }

    console.info(
      `[account-backup] 已從 GitHub 還原 ${merged.length} 個帳號`
    );
  }

  async start(): Promise<void> {
    if (!this.initialized) {
      await this.restore();
    }

    if (this.timer || this.stopped) return;

    this.store.setChangeListener?.(() => {
      void this.flush().catch((error) => {
        console.error(
          '[account-backup] 帳號變更同步失敗，將在下次同步重試',
          this.safeMessage(error)
        );
      });
    });

    await this.flush();

    this.timer = setInterval(() => {
      void this.flush().catch((error) => {
        console.error(
          '[account-backup] 定時同步失敗',
          this.safeMessage(error)
        );
      });
    }, this.intervalMs);

    this.timer.unref?.();

    console.info(
      `[account-backup] GitHub 加密備份已啟動，間隔 ${this.intervalMs}ms`
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = undefined;
    this.store.setChangeListener?.(undefined);

    try {
      await this.flush();
    } catch (error) {
      console.error(
        '[account-backup] 關閉前最後一次同步失敗',
        this.safeMessage(error)
      );
    } finally {
      this.stopped = true;
    }
  }

  async flush(): Promise<void> {
    if (!this.initialized) return;

    if (this.inFlight) {
      await this.inFlight;
      return this.flush();
    }

    const accounts = validateAccounts(this.store.list());
    const snapshot = serializeAccounts(accounts);
    const snapshotDigest = digest(snapshot);

    if (snapshotDigest === this.lastDigest) return;

    this.inFlight = this.writeSnapshot(
      accounts,
      snapshotDigest
    );

    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async readRemote(): Promise<
    (RemoteBackup & {
      path: string;
      encrypted: boolean;
    }) | null
  > {
    const paths =
      this.filePath === this.legacyFilePath
        ? [this.filePath]
        : [this.filePath, this.legacyFilePath];

    for (const remotePath of paths) {
      const encodedPath = remotePath
        .split('/')
        .map(encodeURIComponent)
        .join('/');

      const url =
        `https://api.github.com/repos/${this.repo}/contents/${encodedPath}`;

      try {
        const response = await axios.get(url, {
          params: { ref: this.branch },
          headers: this.headers(),
          timeout: 15_000
        });

        const content = String(
          response.data?.content || ''
        ).replace(/\s/g, '');

        if (!content) {
          throw new Error(
            'GitHub 備份檔案為空或超過 Contents API 可讀取限制'
          );
        }

        const fileBytes = Buffer.from(content, 'base64');

        const decoded = decodeRemoteFile(
          fileBytes,
          this.readKeys
        );

        const sha = String(response.data?.sha || '');

        if (!sha) {
          throw new Error(
            'GitHub 備份缺少檔案 SHA，無法安全更新'
          );
        }

        return {
          ...decoded,
          sha,
          path: remotePath
        };
      } catch (error) {
        if (statusOf(error) === 404) {
          continue;
        }

        throw new Error(
          `讀取 GitHub 帳號備份失敗：${this.safeMessage(error)}`,
          { cause: error }
        );
      }
    }

    return null;
  }

  private async writeSnapshot(
    accounts: RawMusicAccount[],
    snapshotDigest: string
  ): Promise<void> {
    const payload: BackupPayload = {
      format: 'wow-origin-account-backup',
      version: 1,
      updatedAt: new Date().toISOString(),
      accounts
    };

    const encrypted = encryptPayload(
      payload,
      this.key
    );

    const requestBody: Record<string, string> = {
      message: 'chore: update encrypted wow-origin account backup',
      content: Buffer.from(
        encrypted,
        'utf8'
      ).toString('base64'),
      branch: this.branch
    };

    if (this.currentSha) {
      requestBody.sha = this.currentSha;
    }

    try {
      const response = await axios.put(
        this.apiUrl,
        requestBody,
        {
          headers: this.headers(),
          timeout: 15_000
        }
      );

      this.currentSha = String(
        response.data?.content?.sha ||
        this.currentSha ||
        ''
      );

      this.lastDigest = snapshotDigest;

      console.info(
        `[account-backup] 已將 ${accounts.length} 個帳號加密同步到 GitHub`
      );
    } catch (error) {
      if (
        statusOf(error) !== 409 &&
        statusOf(error) !== 422
      ) {
        throw new Error(
          `寫入 GitHub 帳號備份失敗：${this.safeMessage(error)}`,
          { cause: error }
        );
      }

      // SHA 衝突時重新讀取目前版本，再以最新 SHA 重試。
      const latest = await this.readRemote();

      if (
        latest?.path === this.filePath &&
        digest(serializeAccounts(latest.accounts)) ===
          snapshotDigest
      ) {
        this.currentSha = latest.sha;
        this.lastDigest = snapshotDigest;
        return;
      }

      // 舊路徑的 SHA 不能用於建立新的標準路徑。
      this.currentSha =
        latest?.path === this.filePath
          ? latest.sha
          : undefined;

      const retryBody = {
        ...requestBody,
        ...(this.currentSha
          ? { sha: this.currentSha }
          : {})
      };

      const response = await axios.put(
        this.apiUrl,
        retryBody,
        {
          headers: this.headers(),
          timeout: 15_000
        }
      );

      this.currentSha = String(
        response.data?.content?.sha ||
        this.currentSha ||
        ''
      );

      this.lastDigest = snapshotDigest;

      console.info(
        `[account-backup] SHA 衝突後重試成功，已同步 ${accounts.length} 個帳號`
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wow-origin-account-backup'
    };
  }

  private safeMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;

      return status
        ? `HTTP ${status}`
        : (error.code || 'network error');
    }

    return error instanceof Error
      ? error.message.slice(0, 300)
      : 'unknown error';
  }
}
