import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { MusicPlatform } from './types';

export interface RawMusicAccount {
  platform?: unknown;
  name?: unknown;
  cookie?: unknown;
  api_access_key?: unknown;
  stateless?: unknown;
  useLuoxue?: unknown;
  lxSource?: unknown;
}

export interface MusicAccountSession {
  platform: MusicPlatform;
  name: string;
  cookie: string;
  apiAccessKey: string;
  stateless: boolean;
  useLuoxue: boolean;
  lxSource: string[];
  favoriteTrackIds: Set<string>;
}

export interface AccountSessionRegistry {
  sessions: MusicAccountSession[];
  byAccessKey: Map<string, MusicAccountSession>;
}

export interface UpdateAccountCookieResult {
  session: MusicAccountSession;
  filePath: string;
}

export interface CreateAccountResult {
  session: MusicAccountSession;
  filePath: string;
}

export interface UpdateAccountConfigInput {
  name: unknown;
  stateless: unknown;
  useLuoxue: unknown;
  lxSource: unknown;
}

export const sessionsTemplate: RawMusicAccount[] = [
  {
    platform: 'qq',
    name: 'QQ 音乐1',
    cookie: '',
    api_access_key: '',
    stateless: false,
    useLuoxue: true,
    lxSource: []
  },
  {
    platform: 'qq',
    name: 'QQ 音乐',
    cookie: '',
    api_access_key: '',
    stateless: false,
    useLuoxue: true,
    lxSource: []
  },
  {
    platform: 'netease',
    name: '网易云音乐',
    cookie: '',
    api_access_key: '',
    stateless: false,
    useLuoxue: true,
    lxSource: []
  }
];

export function normalizeAccountPlatform(value: unknown): MusicPlatform {
  const platform = String(value || '').trim().toLowerCase();
  if (platform === 'qq') return 'qq';
  if (platform === 'netease') return 'netease';
  throw new Error(`不支持的平台: ${platform || '<empty>'}`);
}

function normalizeAccountStateless(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new Error('stateless 必须是 boolean');
  }
  return value;
}

function normalizeAccountUseLuoxue(value: unknown): { value: boolean; invalid: boolean } {
  if (value === undefined) return { value: true, invalid: false };
  if (typeof value === 'boolean') return { value, invalid: false };
  return { value: false, invalid: true };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeAccountLxSources(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('lxSource 必须是数组');

  const sources: string[] = [];
  const seen = new Set<string>();

  value.forEach((item) => {
    if (typeof item !== 'string') {
      throw new Error('lxSource 中的地址必须是字符串');
    }

    const source = item.trim();
    if (!source) return;
    if (!isHttpUrl(source)) {
      throw new Error(`洛雪源地址无效: ${source}`);
    }

    if (seen.has(source)) return;
    seen.add(source);
    sources.push(source);
  });

  if (sources.length > 10) {
    throw new Error('lxSource 最多配置 10 个地址');
  }

  return sources;
}

function loadAccountLxSources(value: unknown, accountName: string): string[] {
  if (value === undefined) return [];

  if (!Array.isArray(value)) {
    console.warn(
      `[accounts] 账号 "${accountName}" 的 lxSource 必须是数组，已按空数组处理`
    );
    return [];
  }

  const valid: string[] = [];
  const seen = new Set<string>();

  value.forEach((item) => {
    const source = typeof item === 'string' ? item.trim() : '';

    if (!source || !isHttpUrl(source)) {
      console.warn(
        `[accounts] 账号 "${accountName}" 包含无效的 lxSource，已忽略`
      );
      return;
    }

    if (seen.has(source)) return;
    seen.add(source);

    if (valid.length < 10) {
      valid.push(source);
    }
  });

  if (seen.size > 10) {
    console.warn(
      `[accounts] 账号 "${accountName}" 的 lxSource 超过 10 个，仅使用前 10 个`
    );
  }

  return valid;
}

function printTemplate(): void {
  console.log('[accounts] accounts.json 配置模板:');
  console.log(JSON.stringify(sessionsTemplate, null, 2));
}

export function accountsFilePath(workDir: string = process.cwd()): string {
  return path.join(workDir, 'data', 'accounts.json');
}

/* =========================
   GitHub 持久化
   ========================= */

function getGitHubConfig(): { token: string; repo: string } | null {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_DATA_REPO || '').trim();

  if (!token || !repo) {
    return null;
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error('GITHUB_DATA_REPO 必须是 owner/repository 格式');
  }

  return { token, repo };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wow-origin'
  };
}

async function githubGetAccounts(
  token: string,
  repo: string
): Promise<{ exists: boolean; sha?: string; accounts?: RawMusicAccount[] }> {
  const url = `https://api.github.com/repos/${repo}/contents/accounts.json`;

  const response = await fetch(url, {
    method: 'GET',
    headers: githubHeaders(token)
  });

  if (response.status === 404) {
    return { exists: false };
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub 读取 accounts.json 失败 (${response.status}): ${text.slice(0, 500)}`
    );
  }

  const data = await response.json() as {
    content?: string;
    encoding?: string;
    sha?: string;
  };

  if (!data.content) {
    throw new Error('GitHub accounts.json 没有内容');
  }

  const decoded = Buffer.from(
    data.content.replace(/\n/g, ''),
    'base64'
  ).toString('utf8');

  const parsed: unknown = decoded.trim() ? JSON.parse(decoded) : [];

  if (!Array.isArray(parsed)) {
    throw new Error('GitHub accounts.json 必须是数组');
  }

  return {
    exists: true,
    sha: data.sha,
    accounts: parsed as RawMusicAccount[]
  };
}

async function githubWriteAccounts(
  token: string,
  repo: string,
  rawAccounts: RawMusicAccount[],
  sha?: string
): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/contents/accounts.json`;

  const content = `${JSON.stringify(rawAccounts, null, 2)}\n`;

  const body: {
    message: string;
    content: string;
    sha?: string;
  } = {
    message: 'Update accounts.json',
    content: Buffer.from(content, 'utf8').toString('base64')
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      ...githubHeaders(token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `GitHub 保存 accounts.json 失败 (${response.status}): ${text.slice(0, 500)}`
    );
  }

  console.log('[accounts] 已同步到 GitHub');
}

/**
 * Render 启动时恢复账号资料。
 *
 * GitHub 有 accounts.json：
 *   → 下载并覆盖本地 accounts.json
 *
 * GitHub 没有 accounts.json：
 *   → 如果本地有账号资料，则第一次上传到 GitHub
 */
export async function restoreAccountsFromGitHub(
  workDir: string = process.cwd()
): Promise<void> {
  const config = getGitHubConfig();

  if (!config) {
    console.log(
      '[accounts] 未设置 GITHUB_TOKEN / GITHUB_DATA_REPO，使用本地 accounts.json'
    );
    return;
  }

  try {
    const result = await githubGetAccounts(
      config.token,
      config.repo
    );

    const filePath = accountsFilePath(workDir);

    if (result.exists) {
      const rawAccounts = result.accounts || [];

      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      writeRawAccounts(filePath, rawAccounts);

      console.log(
        `[accounts] 已从 GitHub 恢复 ${rawAccounts.length} 个账号`
      );

      return;
    }

    if (fs.existsSync(filePath)) {
      const local = readRawAccountsForWrite(workDir, true);

      await githubWriteAccounts(
        config.token,
        config.repo,
        local.rawAccounts
      );

      console.log('[accounts] GitHub 尚无 accounts.json，已上传本地资料');
    } else {
      console.log('[accounts] GitHub 与本地均没有 accounts.json');
    }
  } catch (error) {
    console.error(
      '[accounts] GitHub 恢复失败，继续使用本地资料:',
      error
    );
  }
}

/**
 * 将当前本地 accounts.json 同步到 GitHub。
 */
export async function syncAccountsToGitHub(
  workDir: string = process.cwd()
): Promise<void> {
  const config = getGitHubConfig();

  if (!config) {
    return;
  }

  const { rawAccounts } = readRawAccountsForWrite(workDir, true);

  const result = await githubGetAccounts(
    config.token,
    config.repo
  );

  await githubWriteAccounts(
    config.token,
    config.repo,
    rawAccounts,
    result.sha
  );
}

/* =========================
   本地 accounts.json
   ========================= */

function readRawAccountsForWrite(
  workDir: string,
  allowMissing: boolean = false
): {
  filePath: string;
  rawAccounts: RawMusicAccount[];
} {
  const filePath = accountsFilePath(workDir);

  if (!fs.existsSync(filePath)) {
    if (!allowMissing) {
      throw new Error('accounts.json 不存在');
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    return {
      filePath,
      rawAccounts: []
    };
  }

  const content = fs.readFileSync(filePath, 'utf8');

  const rawAccounts: unknown =
    content.trim() ? JSON.parse(content) : [];

  if (!Array.isArray(rawAccounts)) {
    throw new Error('accounts.json 必须是数组');
  }

  return {
    filePath,
    rawAccounts: rawAccounts as RawMusicAccount[]
  };
}

function writeRawAccounts(
  filePath: string,
  rawAccounts: RawMusicAccount[]
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempFilePath = `${filePath}.tmp`;

  fs.writeFileSync(
    tempFilePath,
    `${JSON.stringify(rawAccounts, null, 2)}\n`,
    'utf8'
  );

  fs.renameSync(tempFilePath, filePath);
}

function collectAccountKeys(
  registry: AccountSessionRegistry,
  rawAccounts: RawMusicAccount[]
): Set<string> {
  const keys = new Set<string>(
    registry.byAccessKey.keys()
  );

  rawAccounts.forEach((raw) => {
    if (!raw || typeof raw !== 'object') return;

    const key = String(
      raw.api_access_key || ''
    ).trim();

    if (key) keys.add(key);
  });

  return keys;
}

export function generateAccountAccessKey(
  registry: AccountSessionRegistry,
  workDir: string = process.cwd()
): string {
  const { rawAccounts } =
    readRawAccountsForWrite(workDir, true);

  const existingKeys =
    collectAccountKeys(registry, rawAccounts);

  for (let index = 0; index < 10; index += 1) {
    const key = randomUUID().replace(/-/g, '');

    if (!existingKeys.has(key)) {
      return key;
    }
  }

  throw new Error('生成 api_access_key 失败，请重试');
}

export function extractAuthorizationToken(
  value: string | undefined
): string {
  const authorization =
    String(value || '').trim();

  if (!authorization) return '';

  const bearerMatch =
    authorization.match(/^Bearer\s+(.+)$/i);

  return (
    bearerMatch
      ? bearerMatch[1]
      : authorization
  ).trim();
}

export function loadAccountSessions(
  workDir: string = process.cwd()
): AccountSessionRegistry {
  const filePath = accountsFilePath(workDir);

  const emptyRegistry: AccountSessionRegistry = {
    sessions: [],
    byAccessKey: new Map()
  };

  if (!fs.existsSync(filePath)) {
    console.error(
      `[accounts] accounts.json 不存在: ${filePath}`
    );
    printTemplate();
    return emptyRegistry;
  }

  let content = '';

  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(
      `[accounts] 读取 accounts.json 失败: ${filePath}`,
      error
    );
    printTemplate();
    return emptyRegistry;
  }

  if (!content.trim()) {
    console.error(
      `[accounts] accounts.json 内容为空: ${filePath}`
    );
    printTemplate();
    return emptyRegistry;
  }

  let rawAccounts: unknown;

  try {
    rawAccounts = JSON.parse(content);
  } catch (error) {
    console.error(
      `[accounts] accounts.json JSON 解析失败: ${filePath}`,
      error
    );
    printTemplate();
    return emptyRegistry;
  }

  if (!Array.isArray(rawAccounts)) {
    console.error(
      `[accounts] accounts.json 必须是数组: ${filePath}`
    );
    printTemplate();
    return emptyRegistry;
  }

  const parsedSessions: MusicAccountSession[] = [];
  const keyCounts = new Map<string, number>();

  rawAccounts.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      console.warn(
        `[accounts] 忽略第 ${index + 1} 个账号：账号配置必须是对象`
      );
      return;
    }

    const account = raw as RawMusicAccount;

    const apiAccessKey =
      String(account.api_access_key || '').trim();

    if (!apiAccessKey) {
      console.warn(
        `[accounts] 忽略第 ${index + 1} 个账号：api_access_key 未填写或为空`
      );
      return;
    }

    try {
      const platform =
        normalizeAccountPlatform(account.platform);

      const accountName =
        String(
          account.name ||
          `${platform}-${index + 1}`
        ).trim();

      const stateless =
        normalizeAccountStateless(account.stateless);

      const useLuoxue =
        normalizeAccountUseLuoxue(account.useLuoxue);

      if (useLuoxue.invalid) {
        console.warn(
          `[accounts] 账号 "${accountName}" 的 useLuoxue 必须是 boolean，已按 false 处理`
        );
      }

      parsedSessions.push({
        platform,
        name: accountName,
        cookie: String(account.cookie || ''),
        apiAccessKey,
        stateless,
        useLuoxue: useLuoxue.value,
        lxSource: loadAccountLxSources(
          account.lxSource,
          accountName
        ),
        favoriteTrackIds: new Set<string>()
      });

      keyCounts.set(
        apiAccessKey,
        (keyCounts.get(apiAccessKey) || 0) + 1
      );
    } catch (error) {
      console.warn(
        `[accounts] 忽略第 ${index + 1} 个账号：${(error as Error).message}`
      );
    }
  });

  const sessions = parsedSessions.filter((session) => {
    if (
      (keyCounts.get(session.apiAccessKey) || 0) > 1
    ) {
      console.warn(
        `[accounts] 忽略账号 "${session.name}"：api_access_key 重复`
      );
      return false;
    }

    return true;
  });

  const byAccessKey =
    new Map<string, MusicAccountSession>();

  sessions.forEach((session) => {
    byAccessKey.set(
      session.apiAccessKey,
      session
    );
  });

  console.log(
    `[accounts] 已注册 ${sessions.length} 个账号`
  );

  return {
    sessions,
    byAccessKey
  };
}

export async function updateAccountCookieByAccessKey(
  apiAccessKey: string,
  platformValue: unknown,
  cookie: string,
  registry: AccountSessionRegistry,
  workDir: string = process.cwd()
): Promise<UpdateAccountCookieResult> {
  const token =
    String(apiAccessKey || '').trim();

  if (!token) {
    throw new Error('api_access_key 是必填参数');
  }

  const platform =
    normalizeAccountPlatform(platformValue);

  const session =
    registry.byAccessKey.get(token);

  if (!session) {
    throw new Error(
      'api_access_key 无效或未注册到 accounts.json'
    );
  }

  if (session.platform !== platform) {
    throw new Error(
      '更新已有账号时不能修改平台'
    );
  }

  const normalizedCookie =
    String(cookie || '').trim();

  if (!normalizedCookie) {
    throw new Error(
      '登录成功但未获取到有效 cookie'
    );
  }

  const {
    filePath,
    rawAccounts
  } = readRawAccountsForWrite(workDir);

  const target = rawAccounts.find((raw) => {
    if (!raw || typeof raw !== 'object') {
      return false;
    }

    const account =
      raw as RawMusicAccount;

    return (
      String(
        account.api_access_key || ''
      ).trim() === token
    );
  });

  if (!target || typeof target !== 'object') {
    throw new Error(
      'accounts.json 中未找到对应 api_access_key'
    );
  }

  const account =
    target as RawMusicAccount;

  const storedPlatform =
    normalizeAccountPlatform(account.platform);

  if (storedPlatform !== session.platform) {
    throw new Error(
      'accounts.json 中账号平台与当前会话不一致'
    );
  }

  account.cookie = normalizedCookie;

  writeRawAccounts(
    filePath,
    rawAccounts
  );

  session.cookie = normalizedCookie;

  registry.byAccessKey.set(
    token,
    session
  );

  await syncAccountsToGitHub(workDir);

  return {
    session,
    filePath
  };
}

export async function createAccountWithCookie(
  apiAccessKey: string,
  platformValue: unknown,
  cookie: string,
  registry: AccountSessionRegistry,
  workDir: string = process.cwd(),
  accountName?: string
): Promise<CreateAccountResult> {
  const token =
    String(apiAccessKey || '').trim();

  if (!token) {
    throw new Error(
      'api_access_key 是必填参数'
    );
  }

  if (registry.byAccessKey.has(token)) {
    throw new Error(
      'api_access_key 已存在'
    );
  }

  const platform =
    normalizeAccountPlatform(platformValue);

  const normalizedCookie =
    String(cookie || '').trim();

  if (!normalizedCookie) {
    throw new Error(
      '登录成功但未获取到有效 cookie'
    );
  }

  const {
    filePath,
    rawAccounts
  } = readRawAccountsForWrite(
    workDir,
    true
  );

  const existingKeys =
    collectAccountKeys(
      registry,
      rawAccounts
    );

  if (existingKeys.has(token)) {
    throw new Error(
      'api_access_key 已存在'
    );
  }

  const normalizedName =
    String(accountName || '').trim()
    || (
      platform === 'qq'
        ? 'QQ 音乐'
        : '网易云音乐'
    );

  const account: RawMusicAccount = {
    platform,
    name: normalizedName,
    cookie: normalizedCookie,
    api_access_key: token,
    stateless: false,
    useLuoxue: true,
    lxSource: []
  };

  rawAccounts.push(account);

  writeRawAccounts(
    filePath,
    rawAccounts
  );

  const session: MusicAccountSession = {
    platform,
    name: normalizedName,
    cookie: normalizedCookie,
    apiAccessKey: token,
    stateless: false,
    useLuoxue: true,
    lxSource: [],
    favoriteTrackIds: new Set<string>()
  };

  registry.sessions.push(session);

  registry.byAccessKey.set(
    token,
    session
  );

  await syncAccountsToGitHub(workDir);

  return {
    session,
    filePath
  };
}

export async function updateAccountConfigByAccessKey(
  apiAccessKey: string,
  input: UpdateAccountConfigInput,
  registry: AccountSessionRegistry,
  workDir: string = process.cwd()
): Promise<UpdateAccountCookieResult> {
  const token =
    String(apiAccessKey || '').trim();

  if (!token) {
    throw new Error(
      'api_access_key 是必填参数'
    );
  }

  const session =
    registry.byAccessKey.get(token);

  if (!session) {
    throw new Error(
      'api_access_key 无效或未注册到 accounts.json'
    );
  }

  if (typeof input.name !== 'string') {
    throw new Error(
      '名称必须是字符串'
    );
  }

  const name =
    input.name.trim();

  if (!name) {
    throw new Error(
      '名称不能为空'
    );
  }

  if (name.length > 100) {
    throw new Error(
      '名称不能超过 100 个字符'
    );
  }

  if (typeof input.stateless !== 'boolean') {
    throw new Error(
      'stateless 必须是 boolean'
    );
  }

  if (typeof input.useLuoxue !== 'boolean') {
    throw new Error(
      'useLuoxue 必须是 boolean'
    );
  }

  const lxSource =
    normalizeAccountLxSources(
      input.lxSource
    );

  const {
    filePath,
    rawAccounts
  } = readRawAccountsForWrite(
    workDir
  );

  const target = rawAccounts.find((raw) => (
    raw &&
    typeof raw === 'object' &&
    String(
      raw.api_access_key || ''
    ).trim() === token
  ));

  if (!target) {
    throw new Error(
      'accounts.json 中未找到对应 api_access_key'
    );
  }

  target.name = name;
  target.stateless = input.stateless;
  target.useLuoxue = input.useLuoxue;
  target.lxSource = lxSource;

  writeRawAccounts(
    filePath,
    rawAccounts
  );

  session.name = name;
  session.stateless =
    input.stateless;
  session.useLuoxue =
    input.useLuoxue;
  session.lxSource =
    lxSource;

  await syncAccountsToGitHub(workDir);

  return {
    session,
    filePath
  };
}
