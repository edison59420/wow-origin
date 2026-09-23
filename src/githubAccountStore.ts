import type { RawMusicAccount } from './accounts';
import {
  createLocalAccountStore,
  type AccountStore
} from './storage/accounts';

const GITHUB_API = 'https://api.github.com';
const DATA_FILE = 'accounts.json';

type GitHubFileResponse = {
  content?: string;
  sha?: string;
};

function getConfig(): { token: string; repo: string } | null {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  const repo = String(process.env.GITHUB_DATA_REPO || '').trim();

  if (!token || !repo) {
    console.warn(
      '[github-sync] 未設定 GITHUB_TOKEN 或 GITHUB_DATA_REPO，GitHub 備份停用'
    );
    return null;
  }

  return { token, repo };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
}

async function githubGetAccounts(): Promise<{
  exists: boolean;
  accounts: RawMusicAccount[];
  sha?: string;
}> {
  const config = getConfig();

  if (!config) {
    return {
      exists: false,
      accounts: []
    };
  }

  const response = await fetch(
    `${GITHUB_API}/repos/${config.repo}/contents/${DATA_FILE}`,
    {
      method: 'GET',
      headers: githubHeaders(config.token)
    }
  );

  if (response.status === 404) {
    return {
      exists: false,
      accounts: []
    };
  }

  if (!response.ok) {
    throw new Error(
      `GitHub 讀取 accounts.json 失敗: ${response.status} ${await response.text()}`
    );
  }

  const data = await response.json() as GitHubFileResponse;

  if (!data.content) {
    return {
      exists: true,
      accounts: [],
      sha: data.sha
    };
  }

  const content = Buffer.from(
    data.content.replace(/\n/g, ''),
    'base64'
  ).toString('utf8');

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('GitHub accounts.json 不是有效 JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('GitHub accounts.json 必須是陣列');
  }

  return {
    exists: true,
    accounts: parsed as RawMusicAccount[],
    sha: data.sha
  };
}

async function githubWriteAccounts(
  accounts: RawMusicAccount[]
): Promise<void> {
  const config = getConfig();

  if (!config) {
    return;
  }

  const existing = await githubGetAccounts();

  const content = JSON.stringify(accounts, null, 2) + '\n';

  const body: Record<string, unknown> = {
    message: 'auto: save music accounts',
    content: Buffer.from(content, 'utf8').toString('base64')
  };

  if (existing.sha) {
    body.sha = existing.sha;
  }

  const response = await fetch(
    `${GITHUB_API}/repos/${config.repo}/contents/${DATA_FILE}`,
    {
      method: 'PUT',
      headers: githubHeaders(config.token),
      body: JSON.stringify(body)
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub 寫入 accounts.json 失敗: ${response.status} ${await response.text()}`
    );
  }

  console.log(
    `[github-sync] 已保存 ${accounts.length} 個帳號到 GitHub`
  );
}

export class GitHubAccountStore implements AccountStore {
  readonly location: string;

  private readonly localStore: AccountStore;
  private syncQueue: Promise<void> = Promise.resolve();

  constructor(
    localStore: AccountStore = createLocalAccountStore()
  ) {
    this.localStore = localStore;
    this.location = localStore.location;
  }

  list(): RawMusicAccount[] {
    return this.localStore.list();
  }

  insert(account: RawMusicAccount): void {
    this.localStore.insert(account);
    this.scheduleSync();
  }

  update(
    apiAccessKey: string,
    changes: Partial<RawMusicAccount>
  ): void {
    this.localStore.update(apiAccessKey, changes);
    this.scheduleSync();
  }

  private scheduleSync(): void {
    this.syncQueue = this.syncQueue
      .then(async () => {
        try {
          await githubWriteAccounts(this.localStore.list());
        } catch (error) {
          console.error(
            '[github-sync] 自動保存失敗:',
            error
          );
        }
      })
      .catch((error) => {
        console.error(
          '[github-sync] 同步佇列錯誤:',
          error
        );
      });
  }
}

export async function createGitHubAccountStore(): Promise<GitHubAccountStore> {
  const localStore = createLocalAccountStore();
  const store = new GitHubAccountStore(localStore);
  const config = getConfig();

  if (!config) {
    return store;
  }

  try {
    const remote = await githubGetAccounts();
    const localAccounts = localStore.list();

    /*
     * GitHub 有帳號，而且 Render 本地 SQLite 是空的：
     * 從 GitHub 恢復。
     */
    if (
      remote.exists &&
      remote.accounts.length > 0 &&
      localAccounts.length === 0
    ) {
      for (const account of remote.accounts) {
        if (account && typeof account === 'object') {
          localStore.insert(account);
        }
      }

      console.log(
        `[github-sync] 已從 GitHub 恢復 ${remote.accounts.length} 個帳號`
      );

      return store;
    }

    /*
     * GitHub 還沒有帳號，但 Render 本地已經有帳號：
     * 第一次啟用 GitHub 備份時，把現有帳號保存上去。
     */
    if (
      (!remote.exists || remote.accounts.length === 0) &&
      localAccounts.length > 0
    ) {
      await githubWriteAccounts(localAccounts);

      console.log(
        `[github-sync] 已將本地 ${localAccounts.length} 個帳號首次備份到 GitHub`
      );
    }

    return store;
  } catch (error) {
    console.error(
      '[github-sync] 啟動恢復失敗，繼續使用本地 SQLite:',
      error
    );

    return store;
  }
}
