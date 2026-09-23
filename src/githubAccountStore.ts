import { createLocalAccountStore, type AccountStore } from './storage/accounts';
import type { RawMusicAccount } from './accounts';

const DEFAULT_DATA_FILE = 'accounts.json';

interface GitHubFileResponse {
  content?: string;
  sha?: string;
  encoding?: string;
}

function getConfig(): { token: string; repo: string } | null {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_DATA_REPO || '').trim();

  if (!token || !repo) {
    return null;
  }

  return { token, repo };
}

function githubUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/contents/${DEFAULT_DATA_FILE}`;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'wow-origin-render'
  };
}

function decodeGitHubContent(content: string): RawMusicAccount[] {
  const normalized = content.replace(/\n/g, '');
  const json = Buffer.from(normalized, 'base64').toString('utf8');
  const parsed: unknown = JSON.parse(json);

  if (!Array.isArray(parsed)) {
    throw new Error('GitHub accounts.json 必须是数组');
  }

  return parsed.filter(
    (item): item is RawMusicAccount =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item))
  );
}

async function readGitHubAccounts(
  config: { token: string; repo: string }
): Promise<{ exists: boolean; accounts: RawMusicAccount[]; sha?: string }> {
  const response = await fetch(githubUrl(config.repo), {
    method: 'GET',
    headers: githubHeaders(config.token)
  });

  if (response.status === 404) {
    return {
      exists: false,
      accounts: []
    };
  }

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`读取 GitHub accounts.json 失败: HTTP ${response.status} ${message}`);
  }

  const data = (await response.json()) as GitHubFileResponse;

  if (!data.content) {
    throw new Error('GitHub accounts.json 没有内容');
  }

  return {
    exists: true,
    accounts: decodeGitHubContent(data.content),
    sha: data.sha
  };
}

async function writeGitHubAccounts(
  config: { token: string; repo: string },
  accounts: RawMusicAccount[]
): Promise<void> {
  const first = await readGitHubAccounts(config);

  const content = Buffer.from(
    JSON.stringify(accounts, null, 2) + '\n',
    'utf8'
  ).toString('base64');

  const body: Record<string, unknown> = {
    message: 'chore: update music accounts',
    content
  };

  if (first.sha) {
    body.sha = first.sha;
  }

  const response = await fetch(githubUrl(config.repo), {
    method: 'PUT',
    headers: {
      ...githubHeaders(config.token),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`写入 GitHub accounts.json 失败: HTTP ${response.status} ${message}`);
  }
}

export async function restoreAccountsFromGitHub(
  store: AccountStore
): Promise<void> {
  const config = getConfig();

  if (!config) {
    console.log('[github-account] 未配置 GITHUB_TOKEN/GITHUB_DATA_REPO，跳过 GitHub 恢复');
    return;
  }

  try {
    const remote = await readGitHubAccounts(config);
    const localAccounts = store.list();

    if (!remote.exists) {
      console.log('[github-account] GitHub 尚无 accounts.json，正在创建初始备份');
      if (localAccounts.length > 0) {
        await writeGitHubAccounts(config, localAccounts);
      } else {
        await writeGitHubAccounts(config, []);
      }
      return;
    }

    if (remote.accounts.length > 0) {
      store.replaceAll(remote.accounts);
      console.log(
        `[github-account] 已从 GitHub 恢复 ${remote.accounts.length} 个账号`
      );
      return;
    }

    if (localAccounts.length > 0) {
      await writeGitHubAccounts(config, localAccounts);
      console.log(
        `[github-account] GitHub 账号为空，已保留本地 ${localAccounts.length} 个账号并上传`
      );
      return;
    }

    console.log('[github-account] GitHub 与本地都没有账号');
  } catch (error) {
    console.error('[github-account] 恢复失败，继续使用本地账号数据', error);
  }
}

export function createGitHubAccountStore(
  workDir: string = process.cwd()
): AccountStore {
  const localStore = createLocalAccountStore(workDir);
  const config = getConfig();

  return {
    get location() {
      return localStore.location;
    },

    list() {
      return localStore.list();
    },

    insert(account: RawMusicAccount) {
      localStore.insert(account);

      if (config) {
        void writeGitHubAccounts(config, localStore.list()).catch((error) => {
          console.error('[github-account] 新增账号同步失败', error);
        });
      }
    },

    update(apiAccessKey: string, changes: Partial<RawMusicAccount>) {
      localStore.update(apiAccessKey, changes);

      if (config) {
        void writeGitHubAccounts(config, localStore.list()).catch((error) => {
          console.error('[github-account] 更新账号同步失败', error);
        });
      }
    },

    replaceAll(accounts: RawMusicAccount[]) {
      localStore.replaceAll(accounts);
    }
  } as AccountStore;
}
