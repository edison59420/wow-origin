import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RawMusicAccount } from '../accounts';
export interface AccountStore {
  readonly location: string;
  list(): RawMusicAccount[];
  insert(account: RawMusicAccount): void;
  delete(apiAccessKey: string): void;
  update(
    apiAccessKey: string,
    changes: Partial<RawMusicAccount>
  ): void;
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
const ENCRYPTION_VERSION = 2;
const PBKDF2_ITERATIONS = 210000;
const AES_KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
let syncQueue: Promise<void> = Promise.resolve();
/**
 * 將資料轉成 JSON 字串。
 */
function encode(value: unknown): string | null {
  return value === undefined
    ? null
    : JSON.stringify(value);
}
/**
 * 從 SQLite 舊格式相容的 JSON 字串還原。
 *
 * 現在新的 accounts.enc 不再使用 SQLite，
 * 但這個函式保留作為一般資料解碼工具。
 */
function decode(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
/**
 * 從 Render 環境變數 ACCOUNT_SYNC_KEY
 * 派生 AES-256-GCM 金鑰。
 *
 * 重要：
 * ACCOUNT_SYNC_KEY 一旦開始使用後不要更換。
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
/**
 * 將帳號資料加密成 accounts.enc。
 */
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
  return JSON.stringify(
    payload,
    null,
    2
  );
}
/**
 * 解密 accounts.enc。
 */
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
  if (
    !payload.salt ||
    !payload.iv ||
    !payload.tag ||
    !payload.data
  ) {
    throw new Error(
      'accounts.enc 缺少必要的加密字段'
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
  if (salt.length !== SALT_LENGTH) {
    throw new Error(
      'accounts.enc 的 salt 长度无效'
    );
  }
  if (iv.length !== IV_LENGTH) {
    throw new Error(
      'accounts.enc 的 iv 长度无效'
    );
  }
  if (tag.length !== 16) {
    throw new Error(
      'accounts.enc 的认证标签长度无效'
    );
  }
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
    const parsed = JSON.parse(
      plaintext
    );
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
/**
 * 安全写入文件。
 */
function atomicWrite(
  filename: string,
  content: string
): void {
  fs.mkdirSync(
    path.dirname(filename),
    {
      recursive: true
    }
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
    fs.chmodSync(
      filename,
      0o600
    );
  } catch {
    // 某些平台可能不支持 chmod。
  }
}
/**
 * GitHub API。
 */
async function githubRequest(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const token =
    process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      '缺少 GITHUB_TOKEN，无法同步账号资料'
    );
  }
  return fetch(
    url,
    {
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
    }
  );
}
/**
 * GitHub Contents API URL。
 */
function githubContentsUrl(
  repo: string,
  filePath: string
): string {
  return (
    `https://api.github.com/repos/${repo}/contents/` +
    filePath
  );
}
/**
 * 從 GitHub 下載 accounts.enc。
 */
async function downloadGithubFile(
  filePath: string
): Promise<{
  content: Buffer;
  sha?: string;
} | null> {
  const response =
    await githubRequest(
      githubContentsUrl(
        GITHUB_REPO,
        filePath
      )
    );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const text =
      await response.text();
    throw new Error(
      `GitHub 读取 ${filePath} 失败: ` +
      `${response.status} ${text}`
    );
  }
  const json =
    await response.json() as {
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
/**
 * 上傳 accounts.enc 到 GitHub。
 */
async function uploadGithubFile(
  filePath: string,
  content: Buffer,
  message: string
): Promise<void> {
  const existing =
    await downloadGithubFile(
      filePath
    );
  const body: {
    message: string;
    content: string;
    sha?: string;
  } = {
    message,
    content:
      content.toString('base64')
  };
  if (existing?.sha) {
    body.sha = existing.sha;
  }
  const response =
    await githubRequest(
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
        body:
          JSON.stringify(body)
      }
    );
  if (!response.ok) {
    const text =
      await response.text();
    throw new Error(
      `GitHub 写入 ${filePath} 失败: ` +
      `${response.status} ${text}`
    );
  }
}
/**
 * 將目前帳號資料：
 *
 * 1. 加密到 Render 本機 data/accounts.enc
 * 2. 上傳到 GitHub：
 *
 *    wow-origin-data/accounts/accounts.enc
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
/**
 * 將同步工作排隊。
 *
 * 避免連續登入／更新帳號時同時寫 GitHub，
 * 導致 GitHub SHA 衝突。
 */
function queueSync(
  accounts: RawMusicAccount[]
): void {
  const snapshot =
    accounts.map(
      account => ({
        ...account
      })
    );
  syncQueue =
    syncQueue
      .then(
        () =>
          syncAccountsToGitHub(
            snapshot
          )
      )
      .catch(
        error => {
          console.error(
            '[account-sync] GitHub 同步失败:',
            error
          );
        }
      );
}
/**
 * 啟動時從 GitHub 恢復帳號。
 *
 * 只讀：
 *
 *   accounts/accounts.enc
 *
 * 不再讀：
 *
 *   data.db.b64
 */
export async function restoreAccountsFromGitHub():
  Promise<void> {
  fs.mkdirSync(
    path.dirname(
      ENCRYPTED_FILE
    ),
    {
      recursive: true
    }
  );
  try {
    const remote =
      await downloadGithubFile(
        GITHUB_PATH
      );
    if (!remote) {
      console.log(
        '[account-sync] GitHub 尚无 accounts.enc，将使用新的账号存储'
      );
      return;
    }
    const encryptedText =
      remote.content.toString(
        'utf8'
      );
    const accounts =
      decryptAccounts(
        encryptedText
      );
    atomicWrite(
      ENCRYPTED_FILE,
      encryptedText
    );
    console.log(
      `[account-sync] 已从 GitHub 恢复 ${accounts.length} 个加密账号`
    );
  } catch (error) {
    console.error(
      '[account-sync] 恢复账号失败:',
      error
    );
    throw error;
  }
}
/**
 * 新的獨立加密帳號儲存。
 */
export class EncryptedAccountStore
  implements AccountStore {
  readonly location =
    ENCRYPTED_FILE;
  private accounts:
    RawMusicAccount[];
  constructor(
    workDir: string = process.cwd()
  ) {
    this.accounts = [];
    const file =
      path.join(
        workDir,
        'data',
        'accounts.enc'
      );
    fs.mkdirSync(
      path.dirname(file),
      {
        recursive: true
      }
    );
    if (
      fs.existsSync(file)
    ) {
      const content =
        fs.readFileSync(
          file,
          'utf8'
        );
      this.accounts =
        decryptAccounts(
          content
        );
    }
    console.log(
      `[accounts] 独立加密存储已启用: ${file}`
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
    const apiAccessKey =
      String(
        account.api_access_key || ''
      ).trim();
    if (!apiAccessKey) {
      throw new Error(
        '账号缺少 api_access_key'
      );
    }
    if (
      this.accounts.some(
        item =>
          String(
            item.api_access_key || ''
          ).trim() ===
          apiAccessKey
      )
    ) {
      throw new Error(
        'api_access_key 已存在'
      );
    }
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
          String(
            account.api_access_key || ''
          ).trim() ===
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
          String(
            account.api_access_key || ''
          ).trim() !==
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
 * 相容現有 accounts.ts：
 *
 * createLocalAccountStore()
 */
export function createLocalAccountStore(
  workDir: string = process.cwd()
): EncryptedAccountStore {
  return new EncryptedAccountStore(
    workDir
  );
}
/**
 * 保留舊名稱，避免其他程式碼仍引用
 * SqliteAccountStore 時編譯失敗。
 *
 * 實際上已經不再使用 SQLite。
 */
export class SqliteAccountStore
  extends EncryptedAccountStore {
  constructor(
    workDir: string = process.cwd()
  ) {
    super(workDir);
  }
}
