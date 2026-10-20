
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDecipheriv,
  pbkdf2Sync
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export * from './accounts';

interface EncryptedAccountBackup {
  version: number;
  algorithm: string;
  kdf: string;
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const BACKUP_PATH = 'accounts/accounts.enc';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`缺少環境變數：${name}`);
  }
  return value;
}

function githubRepository(): string {
  return requiredEnv('GITHUB_DATA_REPO')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

async function downloadBackup(): Promise<Buffer> {
  const token = requiredEnv('GITHUB_TOKEN');
  const repo = githubRepository();
  const branch = process.env.GITHUB_DATA_BRANCH?.trim() || 'main';
  const url =
    `https://api.github.com/repos/${repo}/contents/` +
    `${BACKUP_PATH}?ref=${encodeURIComponent(branch)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wow-origin-account-restore'
    },
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`GitHub 備份下載失敗：HTTP ${response.status}`);
  }

  const file = await response.json() as {
    type?: string;
    encoding?: string;
    content?: string;
  };

  if (file.type !== 'file' || file.encoding !== 'base64' || !file.content) {
    throw new Error('GitHub 備份檔格式不正確或沒有 content');
  }

  return Buffer.from(file.content.replace(/\s/g, ''), 'base64');
}

function decryptBackup(file: Buffer): Buffer {
  const key = requiredEnv('ACCOUNT_SYNC_KEY');
  const envelope = JSON.parse(file.toString('utf8')) as EncryptedAccountBackup;

  if (
    envelope.version !== 2 ||
    envelope.algorithm !== 'aes-256-gcm' ||
    envelope.kdf !== 'pbkdf2-sha256' ||
    envelope.iterations !== 210000
  ) {
    throw new Error('加密備份版本或演算法不符合預期');
  }

  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.data, 'base64');

  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
    throw new Error('加密備份的 salt、iv 或 tag 長度不正確');
  }

  const derivedKey = pbkdf2Sync(
    key,
    salt,
    210000,
    32,
    'sha256'
  );

  const decipher = createDecipheriv(
    'aes-256-gcm',
    derivedKey,
    iv
  );

  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
}

function inspectSqlite(filePath: string): number | null {
  let db: DatabaseSync | undefined;

  try {
    db = new DatabaseSync(filePath);

    const check = db.prepare('PRAGMA quick_check').get() as
      | { quick_check?: string }
      | undefined;

    if (check?.quick_check !== 'ok') return null;

    const table = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'accounts'
    `).get();

    if (!table) return null;

    const result = db.prepare(
      'SELECT COUNT(*) AS count FROM accounts'
    ).get() as { count: number | bigint };

    return Number(result.count);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function makeTemporaryDatabase(plain: Buffer, tempRoot: string): string {
  const dbDir = path.join(tempRoot, 'data');
  fs.mkdirSync(dbDir, { recursive: true });

  const tempDbPath = path.join(dbDir, 'data.db');

  // 主要格式：解密後直接得到 SQLite 資料庫。
  if (plain.subarray(0, 16).toString('binary') === 'SQLite format 3\0') {
    fs.writeFileSync(tempDbPath, plain, { flag: 'wx' });

    const count = inspectSqlite(tempDbPath);
    if (count === null || count < 1) {
      throw new Error('解密結果不是有效且含有帳號的 SQLite 資料庫');
    }

    return tempDbPath;
  }

  // 相容舊備份：解密後是 JSON 帳號陣列。
  let parsed: unknown;

  try {
    parsed = JSON.parse(plain.toString('utf8'));
  } catch {
    // 也嘗試處理以 Base64 文字包裝的 SQLite。
    const text = plain.toString('utf8').trim();

    if (/^[A-Za-z0-9+/=\r\n]+$/.test(text)) {
      const decoded = Buffer.from(text, 'base64');

      if (
        decoded.subarray(0, 16).toString('binary') ===
        'SQLite format 3\0'
      ) {
        fs.writeFileSync(tempDbPath, decoded, { flag: 'wx' });

        const count = inspectSqlite(tempDbPath);
        if (count !== null && count > 0) return tempDbPath;
      }
    }

    throw new Error('解密成功，但備份內容不是可辨識的 SQLite 或 JSON');
  }

  const accounts = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' &&
        Array.isArray((parsed as { accounts?: unknown }).accounts)
      ? (parsed as { accounts: unknown[] }).accounts
      : null;

  if (!accounts || accounts.length === 0) {
    throw new Error('JSON 備份沒有可還原的帳號');
  }

  const { createLocalAccountStore } = awaitlessStorageImport();
  const store = createLocalAccountStore(tempRoot);

  try {
    for (const item of accounts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('JSON 備份包含無效的帳號項目');
      }

      store.insert(item as import('../accounts').RawMusicAccount);
    }

    store.checkpoint?.();
  } finally {
    store.close();
  }

  const count = inspectSqlite(tempDbPath);
  if (count === null || count < 1) {
    throw new Error('JSON 帳號還原後的 SQLite 驗證失敗');
  }

  return tempDbPath;
}

function awaitlessStorageImport() {
  return {
    createLocalAccountStore: require('./accounts').createLocalAccountStore
      ? undefined
      : undefined
  };
}

export async function restoreAccountsFromGitHub(): Promise<boolean> {
  const destination = path.join(process.cwd(), 'data', 'data.db');
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'wow-origin-restore-')
  );

  try {
    const encrypted = await downloadBackup();
    const plain = decryptBackup(encrypted);
    const restoredDb = makeTemporaryDatabase(plain, tempRoot);

    // 有有效帳號的現有資料庫永遠不覆蓋。
    if (fs.existsSync(destination)) {
      const currentCount = inspectSqlite(destination);

      if (currentCount !== null && currentCount > 0) {
        console.log(
          `[accounts] 現有 SQLite 已有 ${currentCount} 個帳號，跳過備份還原`
        );
        return false;
      }
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });

    // 先保留原始檔，再安裝已驗證的備份。
    if (fs.existsSync(destination)) {
      const oldPath = `${destination}.before-restore-${Date.now()}`;
      fs.renameSync(destination, oldPath);
      console.log('[accounts] 已保留原始資料庫副本');
    }

    fs.copyFileSync(restoredDb, destination);

    const restoredCount = inspectSqlite(destination);
    if (restoredCount === null || restoredCount < 1) {
      throw new Error('安裝後的 SQLite 驗證失敗');
    }

    console.log(
      `[accounts] GitHub 加密備份還原成功，資料庫帳號數：${restoredCount}`
    );

    return true;
  } catch (error) {
    console.error(
      '[accounts] GitHub 加密備份還原失敗：',
      error instanceof Error ? error.message : '未知錯誤'
    );
    return false;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
