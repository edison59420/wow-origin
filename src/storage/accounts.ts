import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { RawMusicAccount } from '../accounts';
export interface AccountStore {
  readonly location: string;
  list(): RawMusicAccount[];
  insert(account: RawMusicAccount): void;
  delete(apiAccessKey: string): void;
  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void;
}
type StoredAccountRow = {
  id: number;
  platform: string | null;
  name: string | null;
  cookie: string | null;
  api_access_key: string | null;
  stateless: string | null;
  use_luoxue: string | null;
  lx_source: string | null;
  device_id: string | null;
  device_state: string | null;
};
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT,
    name TEXT,
    cookie TEXT,
    api_access_key TEXT,
    stateless TEXT,
    use_luoxue TEXT,
    lx_source TEXT,
    deviceId TEXT,
    device_state TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS accounts_access_key_idx
    ON accounts(api_access_key);
  PRAGMA user_version = 2;
`;
const ENCRYPTED_FILE = path.join(
  process.cwd(),
  'data',
  'accounts.enc'
);
const GITHUB_REPO =
  process.env.GITHUB_DATA_REPO ||
  'edison59420/wow-origin-data';
const GITHUB_PATH =
  process.env.ACCOUNT_SYNC_PATH ||
  'accounts/accounts.enc';
const GITHUB_LEGACY_PATH = 'data.db.b64';
const ENCRYPTION_VERSION = 2;
const PBKDF2_ITERATIONS = 210000;
const AES_KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
let syncQueue: Promise<void> = Promise.resolve();
function encode(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
function decode(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
function accountValues(
  account: RawMusicAccount
): Array<string | null> {
  return [
    encode(account.platform),
    encode(account.name),
    encode(account.cookie),
    typeof account.api_access_key === 'string'
      ? account.api_access_key
      : account.api_access_key === undefined
        ? null
        : String(account.api_access_key),
    encode(account.stateless),
    encode(account.useLuoxue),
    encode(account.lxSource),
    encode(account.deviceId),
    encode(account.deviceState)
  ];
}
function rowToAccount(
  row: StoredAccountRow
): RawMusicAccount {
  return {
    platform: decode(row.platform),
    name: decode(row.name),
    cookie: decode(row.cookie),
    api_access_key:
      row.api_access_key ?? undefined,
    stateless: decode(row.stateless),
    useLuoxue: decode(row.use_luoxue),
    lxSource: decode(row.lx_source),
    deviceId: decode(row.device_id),
    deviceState: decode(row.device_state)
  };
}
/**
 * 保留原本專案對 data/data.db 的相容路徑。
 */
export function sqliteAccountsFilePath(
  workDir: string = process.cwd()
): string {
  return path.join(workDir, 'data', 'data.db');
}
/**
 * AES-256-GCM 的加密金鑰由 Render 的
 * ACCOUNT_SYNC_KEY 派生。
 *
 * 注意：
 * ACCOUNT_SYNC_KEY 絕對不能更換，
 * 否則以前的 accounts.enc 無法解密。
 */
function getEncryptionKey(salt: Buffer): Buffer {
  const secret = process.env.ACCOUNT_SYNC_KEY;
  if (!secret) {
    throw new Error(
      '缺少 ACCOUNT_SYNC_KEY，无法读取或保存加密账号资料'
    );
  }
  return crypto.pbkdf2Sync(
    secret,
    salt,
    PBKDF2_ITERATIONS,
    AES_KEY_LENGTH,
    'sha256'
  );
}
type EncryptedPayload = {
  version: number;
  algorithm: 'aes-256-gcm';
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
};
function encryptAccounts(
  accounts: RawMusicAccount[]
): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey(salt);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    key,
    iv
  );
  const plaintext = JSON.stringify({
    accounts
  });
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  const payload: EncryptedPayload = {
    version: ENCRYPTION_VERSION,
    algorithm: 'aes-256-gcm',
    kdf: 'pbkdf2-sha256',
    iterations: PBKDF2_ITERATIONS,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
  return JSON.stringify(payload, null, 2);
}
function decryptAccounts(
  content: string
): RawMusicAccount[] {
  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    throw new Error(
      'accounts.enc 不是有效的 JSON 加密文件',
      { cause: error }
    );
  }
  if (
    payload.algorithm !== 'aes-256-gcm' ||
    payload.kdf !== 'pbkdf2-sha256'
  ) {
    throw new Error(
      'accounts.enc 使用了不受支持的加密格式'
    );
  }
  const salt = Buffer.from(
    payload.salt,
    'base64'
  );
  const iv = Buffer.from(
    payload.iv,
    'base64'
  );
  const tag = Buffer.from(
    payload.tag,
    'base64'
  );
  const encrypted = Buffer.from(
    payload.data,
    'base64'
  );
  const key = getEncryptionKey(salt);
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      iv
    );
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    if (
      !parsed ||
      !Array.isArray(parsed.accounts)
    ) {
      throw new Error(
        '加密账号资料格式错误'
      );
    }
    return parsed.accounts as RawMusicAccount[];
  } catch (error) {
    throw new Error(
      '账号加密资料无法解密，请检查 ACCOUNT_SYNC_KEY 是否正确',
      { cause: error }
    );
  }
}
function atomicWrite(
  filename: string,
  content: string
): void {
  fs.mkdirSync(
    path.dirname(filename),
    { recursive: true }
  );
  const temporary =
    `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(
    temporary,
    content,
    {
      encoding: 'utf8',
      mode: 0o600
    }
  );
  fs.renameSync(
    temporary,
    filename
  );
  try {
    fs.chmodSync(filename, 0o600);
  } catch {
    // 某些平台可能不支持 chmod，忽略即可。
  }
}
async function githubRequest(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      '缺少 GITHUB_TOKEN，无法同步账号资料'
    );
  }
  return fetch(url, {
    ...init,
    headers: {
      Accept:
        'application/vnd.github+json',
      Authorization:
        `Bearer ${token}`,
      'X-GitHub-Api-Version':
        '2022-11-28',
      ...(init.headers || {})
    }
  });
}
function githubContentsUrl(
  repo: string,
  filePath: string
): string {
  return (
    `https://api.github.com/repos/${repo}/contents/` +
    filePath
  );
}
async function downloadGithubFile(
  filePath: string
): Promise<{
  content: Buffer;
  sha?: string;
} | null> {
  const response = await githubRequest(
    githubContentsUrl(
      GITHUB_REPO,
      filePath
    )
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub 读取 ${filePath} 失败: ` +
      `${response.status} ${text}`
    );
  }
  const json = await response.json() as {
    content?: string;
    encoding?: string;
    sha?: string;
  };
  if (
    !json.content ||
    json.encoding !== 'base64'
  ) {
    throw new Error(
      `GitHub 文件 ${filePath} 没有有效的 base64 内容`
    );
  }
  return {
    content: Buffer.from(
      json.content.replace(/\s/g, ''),
      'base64'
    ),
    sha: json.sha
  };
}
async function uploadGithubFile(
  filePath: string,
  content: Buffer,
  message: string
): Promise<void> {
  const existing =
    await downloadGithubFile(filePath);
  const body: {
    message: string;
    content: string;
    branch?: string;
    sha?: string;
  } = {
    message,
    content: content.toString('base64')
  };
  if (existing?.sha) {
    body.sha = existing.sha;
  }
  const response = await githubRequest(
    githubContentsUrl(
      GITHUB_REPO,
      filePath
    ),
    {
      method: 'PUT',
      headers: {
        'Content-Type':
          'application/json'
      },
      body: JSON.stringify(body)
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub 写入 ${filePath} 失败: ` +
      `${response.status} ${text}`
    );
  }
}
/**
 * 将当前账号资料写入：
 *
 * data/accounts.enc
 *
 * 然后同步：
 *
 * wow-origin-data/accounts/accounts.enc
 */
async function syncAccountsToGitHub(
  accounts: RawMusicAccount[]
): Promise<void> {
  const encrypted =
    encryptAccounts(accounts);
  atomicWrite(
    ENCRYPTED_FILE,
    encrypted
  );
  await uploadGithubFile(
    GITHUB_PATH,
    Buffer.from(
      encrypted,
      'utf8'
    ),
    'chore: sync encrypted account data'
  );
  console.log(
    `[account-sync] 已加密同步 ${accounts.length} 个账号到 GitHub`
  );
}
function queueSync(
  accounts: RawMusicAccount[]
): void {
  const snapshot =
    accounts.map(account => ({
      ...account
    }));
  syncQueue = syncQueue
    .then(() =>
      syncAccountsToGitHub(snapshot)
    )
    .catch(error => {
      console.error(
        '[account-sync] GitHub 同步失败:',
        error
      );
    });
}
/**
 * 启动时恢复账号。
 *
 * 优先：
 *   accounts/accounts.enc
 *
 * 如果新加密文件不存在，则自动寻找旧的：
 *   data.db.b64
 *
 * 旧 data.db.b64 会被读取、转换成账号数组，
 * 再加密为 accounts.enc。
 */
export async function restoreAccountsFromGitHub():
  Promise<void> {
  fs.mkdirSync(
    path.dirname(ENCRYPTED_FILE),
    { recursive: true }
  );
  try {
    const encrypted =
      await downloadGithubFile(
        GITHUB_PATH
      );
    if (encrypted) {
      const encryptedText =
        encrypted.content.toString('utf8');
      const accounts =
        decryptAccounts(encryptedText);
      atomicWrite(
        ENCRYPTED_FILE,
        encryptedText
      );
      console.log(
        `[account-sync] 已从 GitHub 恢复 ${accounts.length} 个加密账号`
      );
      return;
    }
    console.log(
      '[account-sync] GitHub 尚无 accounts.enc，尝试恢复旧 data.db.b64'
    );
    const legacy =
      await downloadGithubFile(
        GITHUB_LEGACY_PATH
      );
    if (!legacy) {
      console.log(
        '[account-sync] GitHub 也没有旧 data.db.b64'
      );
      return;
    }
    const workDir =
      fs.mkdtempSync(
        path.join(
          process.cwd(),
          'account-migration-'
        )
      );
    const legacyDb =
      path.join(
        workDir,
        'data.db'
      );
    try {
      fs.writeFileSync(
        legacyDb,
        legacy.content,
        {
          mode: 0o600
        }
      );
      const database =
        new DatabaseSync(legacyDb);
      try {
        const columns =
          database
            .prepare(
              'PRAGMA table_info(accounts)'
            )
            .all() as Array<{
              name: string;
            }>;
        if (
          !columns.some(
            column =>
              column.name ===
              'api_access_key'
          )
        ) {
          throw new Error(
            '旧 data.db.b64 中没有 accounts 表的 api_access_key 字段'
          );
        }
        const rows =
          database
            .prepare(`
              SELECT
                id,
                platform,
                name,
                cookie,
                api_access_key,
                stateless,
                use_luoxue,
                lx_source,
                deviceId AS device_id,
                device_state
              FROM accounts
              ORDER BY id ASC
            `)
            .all() as unknown as StoredAccountRow[];
        const accounts =
          rows.map(rowToAccount);
        console.log(
          `[account-sync] 从旧 data.db.b64 读取到 ${accounts.length} 个账号`
        );
        const encrypted =
          encryptAccounts(accounts);
        atomicWrite(
          ENCRYPTED_FILE,
          encrypted
        );
        await uploadGithubFile(
          GITHUB_PATH,
          Buffer.from(
            encrypted,
            'utf8'
          ),
          'chore: migrate legacy account database to encrypted storage'
        );
        console.log(
          `[account-sync] 已将 ${accounts.length} 个旧账号转换为加密存储`
        );
      } finally {
        database.close();
      }
    } finally {
      fs.rmSync(
        workDir,
        {
          recursive: true,
          force: true
        }
      );
    }
  } catch (error) {
    console.error(
      '[account-sync] 恢复账号失败:',
      error
    );
    throw error;
  }
}
export class EncryptedAccountStore
  implements AccountStore {
  readonly location =
    ENCRYPTED_FILE;
  private accounts: RawMusicAccount[];
  constructor(
    workDir: string = process.cwd()
  ) {
    this.accounts = [];
    fs.mkdirSync(
      path.join(
        workDir,
        'data'
      ),
      {
        recursive: true
      }
    );
    if (
      fs.existsSync(
        this.location
      )
    ) {
      const content =
        fs.readFileSync(
          this.location,
          'utf8'
        );
      this.accounts =
        decryptAccounts(content);
    }
    console.log(
      `[accounts] 独立加密存储已启用: ${this.location}`
    );
  }
  list(): RawMusicAccount[] {
    return this.accounts.map(
      account => ({
        ...account
      })
    );
  }
  insert(
    account: RawMusicAccount
  ): void {
    this.accounts.push({
      ...account
    });
    this.persist();
  }
  update(
    apiAccessKey: string,
    changes: Partial<RawMusicAccount>
  ): void {
    const index =
      this.accounts.findIndex(
        account =>
          account.api_access_key ===
          apiAccessKey
      );
    if (index < 0) {
      throw new Error(
        '加密账号存储中未找到对应 api_access_key'
      );
    }
    this.accounts[index] = {
      ...this.accounts[index],
      ...changes,
      api_access_key:
        apiAccessKey
    };
    this.persist();
  }
  delete(
    apiAccessKey: string
  ): void {
    this.accounts =
      this.accounts.filter(
        account =>
          account.api_access_key !==
          apiAccessKey
      );
    this.persist();
  }
  private persist(): void {
    const encrypted =
      encryptAccounts(
        this.accounts
      );
    atomicWrite(
      this.location,
      encrypted
    );
    queueSync(
      this.accounts
    );
  }
}
/**
 * 兼容项目现有 createLocalAccountStore()
 */
export function createLocalAccountStore(
  workDir: string = process.cwd()
): EncryptedAccountStore {
  return new EncryptedAccountStore(
    workDir
  );
}
/**
 * 保留旧类名称，避免其他代码如果仍然引用
 * SqliteAccountStore 时发生编译问题。
 *
 * 实际新的本地账号存储已经改为加密文件。
 */
export class SqliteAccountStore
  extends EncryptedAccountStore {
  constructor(
    workDir: string = process.cwd()
  ) {
    super(workDir);
  }
}
