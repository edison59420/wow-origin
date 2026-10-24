import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { RawMusicAccount } from '../accounts';
import type { AccountStore } from './accounts';

const API = 'https://api.github.com';
const ACCOUNT_FILE_PATH = 'accounts.enc';
let lastAccountBackupDigest = '';

type GithubContent = { sha?: string; content?: string };
type SyncSettings = { token: string; repo: string; key: Buffer };

function settings(): SyncSettings | null {
  const token = process.env.GITHUB_TOKEN || '';
  const repo = process.env.GITHUB_DATA_REPO || '';
  const key = process.env.ACCOUNT_SYNC_KEY || '';
  if (!token || !repo || !key || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { token, repo, key: createHash('sha256').update(key).digest() };
}

function encrypt(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('WOW1'), iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

function decrypt(value: string, key: Buffer): unknown {
  const data = Buffer.from(value, 'base64');
  if (data.length < 32 || data.subarray(0, 4).toString() !== 'WOW1') throw new Error('帳號備份格式無效');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
  decipher.setAuthTag(data.subarray(16, 32));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8'));
}

async function githubRequest(url: string, token: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wow-origin-account-sync',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers
    },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`GitHub 帳號同步失敗 (${response.status})`);
  return response.status === 204 ? null : response.json();
}

async function remoteFile(config: SyncSettings): Promise<GithubContent | null> {
  try {
    return await githubRequest(`${API}/repos/${config.repo}/contents/${ACCOUNT_FILE_PATH}`, config.token) as GithubContent;
  } catch (error) {
    if (String(error).includes('(404)')) return null;
    throw error;
  }
}

async function readEncryptedBackup(config: SyncSettings): Promise<unknown | null> {
  const file = await remoteFile(config);
  if (!file?.content) return null;
  const encoded = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
  return decrypt(encoded, config.key);
}

async function writeEncryptedBackup(accounts: RawMusicAccount[], config: SyncSettings): Promise<void> {
  const old = await remoteFile(config);
  const encrypted = encrypt(accounts, config.key);
  const body = {
    message: 'chore: encrypted Wow Origin account backup',
    content: Buffer.from(encrypted, 'utf8').toString('base64'),
    ...(old?.sha ? { sha: old.sha } : {})
  };
  await githubRequest(`${API}/repos/${config.repo}/contents/${ACCOUNT_FILE_PATH}`, config.token, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
}

/** Restore only on a new/empty deployment; never overwrite existing local accounts. */
export async function restoreAccountBackup(store: AccountStore): Promise<void> {
  const config = settings();
  if (!config) return;
  try {
    if (store.list().length > 0) return;
    const payload = await readEncryptedBackup(config);
    if (!Array.isArray(payload)) return;
    const accounts = payload.filter((value): value is RawMusicAccount =>
      Boolean(value && typeof value === 'object' && typeof (value as RawMusicAccount).api_access_key === 'string' && String((value as RawMusicAccount).api_access_key).trim())
    );
    for (const account of accounts) store.insert(account);
    const restored = store.list();
    lastAccountBackupDigest = createHash('sha256').update(JSON.stringify(restored)).digest('hex');
    console.log(`[account-sync] 已從 GitHub 還原 ${restored.length} 個帳號`);
  } catch (error) {
    console.error('[account-sync] 帳號還原失敗；保留本機資料：', error instanceof Error ? error.message : error);
  }
}

/** Upload an encrypted account snapshot when account data changes. */
export async function backupAccounts(store: AccountStore): Promise<void> {
  const config = settings();
  if (!config) return;
  const accounts = store.list();
  const digest = createHash('sha256').update(JSON.stringify(accounts)).digest('hex');
  if (digest === lastAccountBackupDigest) return;
  await writeEncryptedBackup(accounts, config);
  lastAccountBackupDigest = digest;
}
