import fs from 'node:fs';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync
} from 'node:crypto';
import type { RawMusicAccount } from '../accounts';
export interface AccountStore {
  readonly location: string;
  list(): RawMusicAccount[];
  insert(account: RawMusicAccount): void;
  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void;
  delete(apiAccessKey: string): void;
}
const DATA_DIR_NAME = 'data';
const LOCAL_FILE_NAME = 'accounts.enc';
const GITHUB_FILE_PATH =
  process.env.ACCOUNT_SYNC_PATH?.trim() ||
  'accounts/accounts.enc';
const GITHUB_API = 'https://api.github.com';
interface EncryptedPayload {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}
function dataFilePath(workDir: string = process.cwd()): string {
  return path.join(workDir, DATA_DIR_NAME, LOCAL_FILE_NAME);
}
function getGitHubConfig(): {
  token: string;
  repo: string;
  path: string;
} | null {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_DATA_REPO || '').trim();
  if (!token || !repo) {
    return null;
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    console.warn(
      '[account-sync] GITHUB_DATA_REPO 格式错误，应为 owner/repository'
    );
    return null;
  }
  return {
    token,
    repo,
    path: GITHUB_FILE_PATH
  };
}
function getEncryptionKey(): Buffer {
  const secret = String(process.env.ACCOUNT_SYNC_KEY || '').trim();
  if (!secret) {
    throw new Error(
      'ACCOUNT_SYNC_KEY 未配置；账号加密存储已启用，请在 Render Environment 添加 ACCOUNT_SYNC_KEY'
    );
  }
  /*
   * 使用 scrypt 将用户提供的密钥稳定派生为 32 字节 AES-256 密钥。
   * 固定 salt 仅用于密钥派生；真正的数据安全由随机 IV + AES-GCM 提供。
   */
  return scryptSync(
    secret,
    'wow-origin-account-store-v1',
    32
  );
}
function encryptAccounts(accounts: RawMusicAccount[]): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    key,
    iv
  );
  const plaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      accounts
    }),
    'utf8'
  );
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  const payload: EncryptedPayload = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    data: encrypted.toString('base64url')
  };
  return JSON.stringify(payload);
}
function decryptAccounts(content: string): RawMusicAccount[] {
  const key = getEncryptionKey();
  let payload: EncryptedPayload;
  try {
    payload = JSON.parse(content);
  } catch {
    throw new Error('账号加密文件不是有效 JSON');
  }
  if (
    payload?.version !== 1 ||
    payload?.algorithm !== 'aes-256-gcm' ||
    typeof payload.iv !== 'string' ||
    typeof payload.tag !== 'string' ||
    typeof payload.data !== 'string'
  ) {
    throw new Error('账号加密文件格式无效');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'base64url')
  );
  decipher.setAuthTag(
    Buffer.from(payload.tag, 'base64url')
  );
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64url')),
    decipher.final()
  ]);
  const parsed = JSON.parse(
    decrypted.toString('utf8')
  );
  if (
    !parsed ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.accounts)
  ) {
    throw new Error('解密后的账号数据格式无效');
  }
  return parsed.accounts as RawMusicAccount[];
}
function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true
  });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
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
    filePath
  );
}
async function githubRequest(
  url: string,
  init: RequestInit
): Promise<Response> {
  const config = getGitHubConfig();
  if (!config) {
    throw new Error(
      'GITHUB_TOKEN 或 GITHUB_DATA_REPO 未配置'
    );
  }
  const headers = new Headers(init.headers);
  headers.set(
    'Authorization',
    `Bearer ${config.token}`
  );
  headers.set(
    'Accept',
    'application/vnd.github+json'
  );
  headers.set(
    'X-GitHub-Api-Version',
    '2022-11-28'
  );
  headers.set(
    'User-Agent',
    'wow-origin-account-sync'
  );
  return fetch(url, {
    ...init,
    headers
  });
}
function githubFileApiUrl(): string {
  const config = getGitHubConfig();
  if (!config) {
    throw new Error(
      'GitHub 同步未配置'
    );
  }
  return `${GITHUB_API}/repos/${config.repo}/contents/${config.path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}
async function downloadGitHubEncryptedAccounts(): Promise<string | null> {
  const config = getGitHubConfig();
  if (!config) {
    console.warn(
      '[account-sync] GitHub 未配置，跳过远程恢复'
    );
    return null;
  }
  const response = await githubRequest(
    githubFileApiUrl(),
    {
      method: 'GET'
    }
  );
  if (response.status === 404) {
    console.log(
      '[account-sync] GitHub 尚无账号加密文件，将使用新的账号存储'
    );
    return null;
  }
  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `GitHub 读取账号文件失败 (${response.status}): ${message.slice(0, 300)}`
    );
  }
  const body = await response.json() as {
    content?: string;
  };
  if (!body.content) {
    throw new Error(
      'GitHub 账号文件没有 content'
    );
  }
  return Buffer.from(
    body.content.replace(/\s/g, ''),
    'base64'
  ).toString('utf8');
}
async function uploadGitHubEncryptedAccounts(
  encryptedContent: string,
  message: string
): Promise<void> {
  const config = getGitHubConfig();
  if (!config) {
    return;
  }
  let sha: string | undefined;
  const existing = await githubRequest(
    githubFileApiUrl(),
    {
      method: 'GET'
    }
  );
  if (existing.ok) {
    const body = await existing.json() as {
      sha?: string;
    };
    sha = body.sha;
  } else if (existing.status !== 404) {
    const errorText = await existing.text();
    throw new Error(
      `GitHub 查询账号文件失败 (${existing.status}): ${errorText.slice(0, 300)}`
    );
  }
  const encoded = Buffer.from(
    encryptedContent,
    'utf8'
  ).toString('base64');
  const response = await githubRequest(
    githubFileApiUrl(),
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message,
        content: encoded,
        ...(sha ? { sha } : {})
      })
    }
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `GitHub 保存账号文件失败 (${response.status}): ${errorText.slice(0, 500)}`
    );
  }
}
let restorePromise: Promise<void> | null = null;
/**
 * 启动前恢复账号：
 *
 * GitHub encrypted file
 *        ↓
 * 解密
 *        ↓
 * data/accounts.enc
 */
export async function restoreAccountsFromGitHub(
  workDir: string = process.cwd()
): Promise<void> {
  if (restorePromise) {
    return restorePromise;
  }
  restorePromise = (async () => {
    const config = getGitHubConfig();
    if (!config) {
      console.warn(
        '[account-sync] 未配置 GITHUB_TOKEN / GITHUB_DATA_REPO，使用本地账号文件'
      );
      return;
    }
    try {
      const remote = await downloadGitHubEncryptedAccounts();
      if (!remote) {
        return;
      }
      /*
       * 先验证密文能否使用当前 ACCOUNT_SYNC_KEY 解密。
       * 如果密钥错误，绝不覆盖本地数据。
       */
      const accounts = decryptAccounts(remote);
      const localPath = dataFilePath(workDir);
      atomicWrite(
        localPath,
        remote
      );
      console.log(
        `[account-sync] 已从 GitHub 恢复 ${accounts.length} 个账号`
      );
    } catch (error) {
      console.error(
        '[account-sync] GitHub 恢复账号失败，保留当前本地账号文件:',
        error
      );
    }
  })();
  return restorePromise;
}
export class EncryptedAccountStore implements AccountStore {
  readonly location: string;
  private accounts: RawMusicAccount[] = [];
  private syncQueue: Promise<void> = Promise.resolve();
  constructor(
    workDir: string = process.cwd()
  ) {
    this.location = dataFilePath(workDir);
    fs.mkdirSync(
      path.dirname(this.location),
      {
        recursive: true
      }
    );
    if (fs.existsSync(this.location)) {
      try {
        const content = fs.readFileSync(
          this.location,
          'utf8'
        );
        if (content.trim()) {
          this.accounts = decryptAccounts(content);
        }
      } catch (error) {
        console.error(
          '[accounts] 读取加密账号文件失败:',
          error
        );
        /*
         * 不删除损坏文件。
         * 防止误操作导致账号永久丢失。
         */
        this.accounts = [];
      }
    }
    console.log(
      `[accounts] 独立加密存储已启用: ${this.location}`
    );
  }
  list(): RawMusicAccount[] {
    return this.accounts.map(account => ({
      ...account,
      lxSource: Array.isArray(account.lxSource)
        ? [...account.lxSource]
        : []
    }));
  }
  insert(account: RawMusicAccount): void {
    const key = String(
      account.api_access_key || ''
    ).trim();
    if (!key) {
      throw new Error(
        'api_access_key 不能为空'
      );
    }
    if (
      this.accounts.some(
        item =>
          String(item.api_access_key || '').trim() === key
      )
    ) {
      throw new Error(
        'api_access_key 已存在'
      );
    }
    this.accounts.push({
      ...account
    });
    this.persist(
      '新增账号'
    );
  }
  update(
    apiAccessKey: string,
    changes: Partial<RawMusicAccount>
  ): void {
    const key = String(
      apiAccessKey || ''
    ).trim();
    const index = this.accounts.findIndex(
      account =>
        String(account.api_access_key || '').trim() === key
    );
    if (index < 0) {
      throw new Error(
        '加密账号存储中未找到对应 api_access_key'
      );
    }
    this.accounts[index] = {
      ...this.accounts[index],
      ...changes,
      api_access_key: key
    };
    this.persist(
      '更新账号'
    );
  }
  delete(apiAccessKey: string): void {
    const key = String(
      apiAccessKey || ''
    ).trim();
    const before = this.accounts.length;
    this.accounts = this.accounts.filter(
      account =>
        String(account.api_access_key || '').trim() !== key
    );
    if (this.accounts.length === before) {
      throw new Error(
        '加密账号存储中未找到对应 api_access_key'
      );
    }
    this.persist(
      '删除账号'
    );
  }
  private persist(
    reason: string
  ): void {
    const encrypted = encryptAccounts(
      this.accounts
    );
    atomicWrite(
      this.location,
      encrypted
    );
    /*
     * 所有写入排队。
     * 避免 QQ 自动刷新 Cookie 与用户修改设置同时上传时
     * 后一次 PUT 覆盖前一次 PUT。
     */
    this.syncQueue = this.syncQueue
      .then(async () => {
        try {
          await uploadGitHubEncryptedAccounts(
            encrypted,
            `accounts: ${reason}`
          );
          console.log(
            `[account-sync] GitHub 同步成功: ${reason}`
          );
        } catch (error) {
          console.error(
            `[account-sync] GitHub 同步失败: ${reason}`,
            error
          );
        }
      })
      .catch(() => {
        // 永远不让同步错误阻断账号操作。
      });
  }
}
export function createLocalAccountStore(
  workDir: string = process.cwd()
): AccountStore {
  return new EncryptedAccountStore(workDir);
}
/**
 * 保留旧函数名称，避免其他代码调用时报错。
 */
export function sqliteAccountsFilePath(
  workDir: string = process.cwd()
): string {
  return dataFilePath(workDir);
}
