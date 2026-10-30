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
  if (!Array.isArray(value)) throw new Error('GitHub 帐号备份格式错误：accounts 必须是数组');
  const seen = new Set<string>();
  return value.filter((item): item is RawMusicAccount => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const key = String((item as RawMusicAccount).api_access_key || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeAccounts(remote: RawMusicAccount[], local: RawMusicAccount[]): RawMusicAccount[] {
  const merged = new Map<string, RawMusicAccount>();
  remote.forEach((account) => merged.set(String(account.api_access_key), account));
  // 如果本机仍有持久磁盘资料，以本机同 key 的较新值为准，同时保留远端缺少的账号。
  local.forEach((account) => merged.set(String(account.api_access_key), account));
  return [...merged.values()];
}

function encryptPayload(payload: BackupPayload, key: Buffer): string {
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

function decryptPayload(envelopeText: string, keys: Buffer[]): { payload: BackupPayload; keyIndex: number } {
  let envelope: any;
  try {
    envelope = JSON.parse(envelopeText);
  } catch (error) {
    throw new Error('GitHub 帳號備份不是有效的加密 JSON', { cause: error });
  }
  if (envelope?.format !== 'wow-origin-encrypted-backup' || envelope?.version !== 1) {
    throw new Error('GitHub 帳號備份版本不受支援');
  }

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        keys[keyIndex],
        Buffer.from(String(envelope.iv || ''), 'base64')
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(String(envelope.ciphertext || ''), 'base64')),
        decipher.final()
      ]).toString('utf8');
      const payload = JSON.parse(plaintext) as BackupPayload;
      if (payload?.format !== 'wow-origin-account-backup' || payload?.version !== 1) {
        throw new Error('備份資料版本不受支援');
      }
      payload.accounts = validateAccounts(payload.accounts);
      return { payload, keyIndex };
    } catch {
      // 嘗試下一把仍有效於遷移期的舊密鑰；不輸出任何密鑰或解密內容。
    }
  }
  throw new Error('GitHub 帳號備份解密失敗；請確認 ACCOUNT_SYNC_KEY 或 ACCOUNT_SYNC_PREVIOUS_KEY');
}

function statusOf(error: unknown): number | undefined {
  return (error as AxiosError | undefined)?.response?.status;
}


function decodeStoredField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function accountsFromLegacySqlite(databaseBytes: Buffer): RawMusicAccount[] {
  if (!databaseBytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
    throw new Error('Not a SQLite database');
  }
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wow-origin-account-restore-'));
  const filename = path.join(temporaryDirectory, 'legacy.db');
  let database: DatabaseSync | undefined;
  try {
    fs.writeFileSync(filename, databaseBytes);
    database = new DatabaseSync(filename);
    const columns = (database.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    if (!columns.length || !columns.includes('api_access_key')) throw new Error('SQLite backup has no accounts table');
    const optional = (name: string, alias = name) => columns.includes(name) ? `${name} AS ${alias}` : `NULL AS ${alias}`;
    const sql = `SELECT ${[
      optional('platform'), optional('name'), optional('cookie'), optional('api_access_key'),
      optional('stateless'), optional('use_luoxue'), optional('lx_source'),
      optional('deviceId', 'device_id'), optional('device_state')
    ].join(', ')} FROM accounts ORDER BY id ASC`;
    const rows = database.prepare(sql).all() as Array<Record<string, unknown>>;
    return validateAccounts(rows.map((row) => ({
      platform: decodeStoredField(row.platform),
      name: decodeStoredField(row.name),
      cookie: decodeStoredField(row.cookie),
      api_access_key: String(row.api_access_key || ''),
      stateless: decodeStoredField(row.stateless),
      useLuoxue: decodeStoredField(row.use_luoxue),
      lxSource: decodeStoredField(row.lx_source),
      deviceId: decodeStoredField(row.device_id),
      deviceState: decodeStoredField(row.device_state)
    })));
  } finally {
    database?.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function decodeRemoteFile(fileBytes: Buffer, keys: Buffer[]): { accounts: RawMusicAccount[]; encrypted: boolean; encryptedWithCurrentKey: boolean } {
  const text = fileBytes.toString('utf8').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (parsed?.format === 'wow-origin-encrypted-backup') {
      const decrypted = decryptPayload(text, keys);
      return {
        accounts: decrypted.payload.accounts,
        encrypted: true,
        encryptedWithCurrentKey: decrypted.keyIndex === 0
      };
    }
    if (Array.isArray(parsed)) return { accounts: validateAccounts(parsed), encrypted: false, encryptedWithCurrentKey: false };
    if (Array.isArray(parsed?.accounts)) return { accounts: validateAccounts(parsed.accounts), encrypted: false, encryptedWithCurrentKey: false };
  }
  if (fileBytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
    return { accounts: accountsFromLegacySqlite(fileBytes), encrypted: false, encryptedWithCurrentKey: false };
  }
  // Previous versions stored the SQLite file as base64 text at accounts/data.db.b64.
  try {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
      return { accounts: accountsFromLegacySqlite(decoded), encrypted: false, encryptedWithCurrentKey: false };
    }
    const decodedText = decoded.toString('utf8').trim();
    if (decodedText.startsWith('{') || decodedText.startsWith('[')) {
      const parsed = JSON.parse(decodedText);
      if (Array.isArray(parsed)) return { accounts: validateAccounts(parsed), encrypted: false, encryptedWithCurrentKey: false };
      if (Array.isArray(parsed?.accounts)) return { accounts: validateAccounts(parsed.accounts), encrypted: false, encryptedWithCurrentKey: false };
    }
  } catch { /* handled by the clear format error below */ }
  throw new Error('GitHub 备份格式无法识别；旧资料未被覆盖');
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
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo.trim())) {
      throw new Error('GITHUB_DATA_REPO 格式必须是 owner/repository');
    }
    if (!options.token.trim()) throw new Error('GITHUB_TOKEN 不可为空');
    if (options.encryptionKey.length < 32) {
      throw new Error('ACCOUNT_SYNC_KEY 至少需要 32 个字符，请使用新的随机长密钥');
    }
    const filePath = (options.filePath || DEFAULT_FILE_PATH).replace(/^\/+/, '');
    const legacyFilePath = (options.legacyFilePath || DEFAULT_LEGACY_FILE_PATH).replace(/^\/+/, '');
    const invalidPath = (value: string) => !value || value.split('/').some((part) => !part || part === '.' || part === '..');
    if (invalidPath(filePath)) throw new Error('ACCOUNT_SYNC_PATH 路径無效');
    if (invalidPath(legacyFilePath)) throw new Error('ACCOUNT_SYNC_LEGACY_PATH 路徑無效');
    if (!options.store.replaceAll) {
      throw new Error('账号储存层不支持 replaceAll，无法安全还原 GitHub 备份');
    }

    this.store = options.store;
    this.repo = options.repo.trim();
    this.token = options.token.trim();
    this.key = crypto.scryptSync(options.encryptionKey, 'wow-origin-account-backup-v1', 32);
    const previousKeys = [...new Set((options.previousEncryptionKeys || []).map((value) => value.trim()).filter((value) => value && value !== options.encryptionKey))];
    this.readKeys = [this.key, ...previousKeys.map((value) => crypto.scryptSync(value, 'wow-origin-account-backup-v1', 32))];
    this.branch = options.branch?.trim() || 'main';
    this.filePath = filePath;
    this.legacyFilePath = legacyFilePath;
    this.intervalMs = Math.max(1000, Math.min(60_000, options.intervalMs || DEFAULT_INTERVAL_MS));
    const encodedPath = this.filePath.split('/').map(encodeURIComponent).join('/');
    this.apiUrl = `https://api.github.com/repos/${this.repo}/contents/${encodedPath}`;
  }

  /** 必须在 loadAccountSessions 之前调用，确保新实例先拿到云端账号。 */
  async restore(): Promise<void> {
    const remote = await this.readRemote();
    const local = validateAccounts(this.store.list());
    if (!remote) {
      this.currentSha = undefined;
      this.lastDigest = '';
      this.initialized = true;
      console.info('[account-backup] GitHub 尚无备份，将以本机账号建立第一份加密备份');
      return;
    }

    this.currentSha = remote.path === this.filePath ? remote.sha : undefined;
    const merged = local.length > 0 ? mergeAccounts(remote.accounts, local) : remote.accounts;
    if (digest(serializeAccounts(local)) !== digest(serializeAccounts(merged))) {
      this.store.replaceAll!(merged);
    }
    this.lastDigest = remote.path === this.filePath && remote.encryptedWithCurrentKey
      ? digest(serializeAccounts(remote.accounts))
      : '';
    this.initialized = true;
    if (digest(serializeAccounts(merged)) !== this.lastDigest) await this.flush();
    console.info(`[account-backup] 已从 GitHub 还原 ${merged.length} 个账号`);
  }

  async start(): Promise<void> {
    if (!this.initialized) await this.restore();
    if (this.timer || this.stopped) return;
    this.store.setChangeListener?.(() => {
      void this.flush().catch((error) => {
        console.error('[account-backup] 账号变更同步失败，将在下次同步重试', this.safeMessage(error));
      });
    });
    await this.flush();
    this.timer = setInterval(() => {
      void this.flush().catch((error) => {
        console.error('[account-backup] 定时同步失败', this.safeMessage(error));
      });
    }, this.intervalMs);
    this.timer.unref?.();
    console.info(`[account-backup] GitHub 加密备份已启动，间隔 ${this.intervalMs}ms`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.store.setChangeListener?.(undefined);
    try {
      await this.flush();
    } catch (error) {
      console.error('[account-backup] 關閉前最後一次同步失敗', this.safeMessage(error));
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

    this.inFlight = this.writeSnapshot(accounts, snapshotDigest);
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async readRemote(): Promise<(RemoteBackup & { path: string; encrypted: boolean }) | null> {
    const paths = this.filePath === this.legacyFilePath
      ? [this.filePath]
      : [this.filePath, this.legacyFilePath];
    for (const remotePath of paths) {
      const encodedPath = remotePath.split('/').map(encodeURIComponent).join('/');
      const url = `https://api.github.com/repos/${this.repo}/contents/${encodedPath}`;
      try {
        const response = await axios.get(url, {
          params: { ref: this.branch },
          headers: this.headers(),
          timeout: 15_000
        });
        const content = String(response.data?.content || '').replace(/\s/g, '');
        if (!content) throw new Error('GitHub 备份文件为空或超过 Contents API 可读取限制');
        const fileBytes = Buffer.from(content, 'base64');
        const decoded = decodeRemoteFile(fileBytes, this.readKeys);
        const sha = String(response.data?.sha || '');
        if (!sha) throw new Error('GitHub 备份缺少文件 SHA，无法安全更新');
        return { ...decoded, sha, path: remotePath };
      } catch (error) {
        if (statusOf(error) === 404) continue;
        throw new Error(`读取 GitHub 帐号备份失败：${this.safeMessage(error)}`, { cause: error });
      }
    }
    return null;
  }

  private async writeSnapshot(accounts: RawMusicAccount[], snapshotDigest: string): Promise<void> {
    const payload: BackupPayload = {
      format: 'wow-origin-account-backup',
      version: 1,
      updatedAt: new Date().toISOString(),
      accounts
    };
    const encrypted = encryptPayload(payload, this.key);
    const requestBody: Record<string, string> = {
      message: 'chore: update encrypted wow-origin account backup',
      content: Buffer.from(encrypted, 'utf8').toString('base64'),
      branch: this.branch
    };
    if (this.currentSha) requestBody.sha = this.currentSha;

    try {
      const response = await axios.put(this.apiUrl, requestBody, {
        headers: this.headers(),
        timeout: 15_000
      });
      this.currentSha = String(response.data?.content?.sha || this.currentSha || '');
      this.lastDigest = snapshotDigest;
      console.info(`[account-backup] 已将 ${accounts.length} 个账号加密同步到 GitHub`);
    } catch (error) {
      if (statusOf(error) !== 409 && statusOf(error) !== 422) {
        throw new Error(`写入 GitHub 帐号备份失败：${this.safeMessage(error)}`, { cause: error });
      }
      // SHA 冲突时重新读取当前版本，再以最新 SHA 重试一次。
      const latest = await this.readRemote();
      if (latest?.path === this.filePath && digest(serializeAccounts(latest.accounts)) === snapshotDigest) {
        this.currentSha = latest.sha;
        this.lastDigest = snapshotDigest;
        return;
      }
      // If the file found is the legacy path, its SHA cannot be used when creating
      // the new canonical path. Only reuse SHA when retrying the same path.
      this.currentSha = latest?.path === this.filePath ? latest.sha : undefined;
      const retryBody = { ...requestBody, ...(this.currentSha ? { sha: this.currentSha } : {}) };
      const response = await axios.put(this.apiUrl, retryBody, {
        headers: this.headers(),
        timeout: 15_000
      });
      this.currentSha = String(response.data?.content?.sha || this.currentSha || '');
      this.lastDigest = snapshotDigest;
      console.info(`[account-backup] SHA 衝突後重試成功，已同步 ${accounts.length} 个账号`);
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
      return status ? `HTTP ${status}` : (error.code || 'network error');
    }
    return error instanceof Error ? error.message.slice(0, 300) : 'unknown error';
  }
}
