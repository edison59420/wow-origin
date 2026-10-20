
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteAccountsFilePath } from './storage/accounts';
import type { AccountStore } from './storage/accounts';

const DEFAULT_BACKUP_PATH = 'accounts/data.db.b64';
const GITHUB_API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 15000;

interface GithubContentResponse {
  content?: string;
  encoding?: string;
  sha?: string;
}

function getConfig(): {
  token: string;
  repo: string;
  filePath: string;
  enabled: boolean;
} {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_DATA_REPO || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const filePath = String(
    process.env.GITHUB_ACCOUNT_BACKUP_PATH || DEFAULT_BACKUP_PATH
  ).trim().replace(/^\/+/, '');

  return {
    token,
    repo,
    filePath,
    enabled: Boolean(token && repo && filePath)
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'wow-origin-account-backup'
  };
}

async function githubRequest(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function contentsUrl(repo: string, filePath: string): string {
  return `https://api.github.com/repos/${repo}/contents/${
    filePath.split('/').map(encodeURIComponent).join('/')
  }`;
}

async function getExistingFile(
  token: string,
  repo: string,
  filePath: string
): Promise<GithubContentResponse | null> {
  const response = await githubRequest(
    contentsUrl(repo, filePath),
    {
      method: 'GET',
      headers: githubHeaders(token)
    }
  );

  if (response.status === 404) return null;

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `GitHub 读取备份失败 (${response.status})${
        body ? `: ${body.slice(0, 300)}` : ''
      }`
    );
  }

  return await response.json() as GithubContentResponse;
}

function flushAccountStore(accountStore?: AccountStore): void {
  const store = accountStore as (
    AccountStore & { checkpoint?: () => void }
  ) | undefined;

  try {
    store?.checkpoint?.();
  } catch (error) {
    console.warn(
      `[account-backup] SQLite checkpoint 失败，将继续备份当前文件: ${
        (error as Error).message
      }`
    );
  }
}

export function accountBackupFilePath(
  workDir: string = process.cwd()
): string {
  return sqliteAccountsFilePath(workDir);
}

function localAccountDatabaseHasAccounts(
  localPath: string
): boolean {
  if (!fs.existsSync(localPath)) return false;

  let database: DatabaseSync | undefined;

  try {
    database = new DatabaseSync(localPath, { readOnly: true });

    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts' LIMIT 1"
    ).get() as { name?: string } | undefined;

    if (!table?.name) return false;

    const row = database.prepare(
      'SELECT COUNT(*) AS count FROM accounts'
    ).get() as { count?: number } | undefined;

    return Number(row?.count || 0) > 0;
  } catch (error) {
    console.warn(
      `[account-backup] 本地账号数据库无法正常读取，将尝试 GitHub 恢复: ${
        (error as Error).message
      }`
    );
    return false;
  } finally {
    try {
      database?.close();
    } catch {}
  }
}

/**
 * Render 启动时只在本地账号数据库不存在、损坏
 * 或账号表为空时恢复 GitHub 备份。
 * 本地已有有效账号时绝不覆盖。
 */
export async function restoreAccountDatabaseIfMissing(
  workDir: string = process.cwd()
): Promise<boolean> {
  const localPath = accountBackupFilePath(workDir);

  if (localAccountDatabaseHasAccounts(localPath)) {
    return false;
  }

  const config = getConfig();

  if (!config.enabled) {
    console.log(
      '[account-backup] 未配置 GITHUB_TOKEN/GITHUB_DATA_REPO，跳过 GitHub 恢复'
    );
    return false;
  }

  try {
    const remote = await getExistingFile(
      config.token,
      config.repo,
      config.filePath
    );

    if (!remote?.content || remote.encoding !== 'base64') {
      console.log(
        '[account-backup] GitHub 尚无账号数据库备份，保留首次启动的本地数据库创建流程'
      );
      return false;
    }

    const normalized = remote.content.replace(/\s/g, '');
    const data = Buffer.from(normalized, 'base64');

    if (data.length < 16) {
      throw new Error('GitHub 备份文件过小，不像有效的 SQLite 数据库');
    }

    fs.mkdirSync(path.dirname(localPath), { recursive: true });

    const tempPath =
      `${localPath}.restore-${process.pid}-${Date.now()}.tmp`;

    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, localPath);

    console.log(
      `[account-backup] 已从 GitHub 恢复完整账号数据库: ${
        config.repo
      }/${config.filePath}`
    );

    return true;
  } catch (error) {
    console.error(
      `[account-backup] GitHub 恢复失败，继续使用本地/全新数据库: ${
        (error as Error).message
      }`
    );
    return false;
  }
}

/**
 * 把当前完整 data/data.db 上传到 GitHub。
 * 不会重新整理账号字段，也不会修改数据库内容。
 */
export async function backupAccountDatabase(
  workDir: string = process.cwd(),
  accountStore?: AccountStore
): Promise<boolean> {
  const config = getConfig();

  if (!config.enabled) return false;

  const localPath = accountBackupFilePath(workDir);

  if (!fs.existsSync(localPath)) {
    console.warn(
      `[account-backup] 本地账号数据库不存在，跳过备份: ${localPath}`
    );
    return false;
  }

  try {
    flushAccountStore(accountStore);

    const data = fs.readFileSync(localPath);
    const content = data.toString('base64');

    const existing = await getExistingFile(
      config.token,
      config.repo,
      config.filePath
    );

    const response = await githubRequest(
      contentsUrl(config.repo, config.filePath),
      {
        method: 'PUT',
        headers: {
          ...githubHeaders(config.token),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          message: `backup: account database ${new Date().toISOString()}`,
          content,
          ...(existing?.sha ? { sha: existing.sha } : {})
        })
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');

      throw new Error(
        `GitHub 写入备份失败 (${response.status})${
          body ? `: ${body.slice(0, 300)}` : ''
        }`
      );
    }

    console.log(
      `[account-backup] 已备份完整账号数据库到 GitHub: ${
        config.repo
      }/${config.filePath}`
    );

    return true;
  } catch (error) {
    console.error(
      `[account-backup] GitHub 备份失败，但不影响当前 Aduoer 运行: ${
        (error as Error).message
      }`
    );
    return false;
  }
}

export async function backupAccountDatabaseAfterChange(
  workDir: string,
  accountStore: AccountStore
): Promise<void> {
  await backupAccountDatabase(workDir, accountStore);
}
