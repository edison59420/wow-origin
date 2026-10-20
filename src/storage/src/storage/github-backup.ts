
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

interface EncryptedBackup {
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
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`[backup] 缺少環境變數 ${name}`);
  }
  return value;
}

function decryptBackup(input: Buffer): Buffer {
  const keyText = requiredEnv('ACCOUNT_SYNC_KEY');

  let envelope: EncryptedBackup;
  try {
    envelope = JSON.parse(input.toString('utf8')) as EncryptedBackup;
  } catch {
    throw new Error('[backup] 備份外層不是有效 JSON');
  }

  if (
    envelope.version !== 2 ||
    envelope.algorithm !== 'aes-256-gcm' ||
    envelope.kdf !== 'pbkdf2-sha256' ||
    envelope.iterations !== 210000
  ) {
    throw new Error('[backup] 加密格式與預期不符，停止還原');
  }

  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const encrypted = Buffer.from(envelope.data, 'base64');

  if (
    salt.length < 8 ||
    iv.length !== 12 ||
    tag.length !== 16 ||
    encrypted.length === 0 ||
    encrypted.length > MAX_BACKUP_BYTES
  ) {
    throw new Error('[backup] 加密備份欄位無效');
  }

  const key = crypto.pbkdf2Sync(
    keyText,
    salt,
    210000,
    32,
    'sha256'
  );

  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      iv
    );

    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
  } catch {
    throw new Error(
      '[backup] 解密驗證失敗；請確認 ACCOUNT_SYNC_KEY 與備份配對'
    );
  } finally {
    key.fill(0);
  }
}

async function downloadBackup(): Promise<Buffer> {
  const token = requiredEnv('GITHUB_TOKEN');
  const repo = requiredEnv('GITHUB_DATA_REPO');
  const branch = process.env.GITHUB_DATA_BRANCH?.trim() || 'main';

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('[backup] GITHUB_DATA_REPO 格式錯誤');
  }

  const url =
    `https://api.github.com/repos/${repo}/contents/` +
    `${BACKUP_PATH}?ref=${encodeURIComponent(branch)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'wow-origin-account-restore'
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(
      `[backup] GitHub 讀取失敗：HTTP ${response.status}`
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length === 0 || bytes.length > MAX_BACKUP_BYTES) {
    throw new Error('[backup] 備份大小不合理，停止還原');
  }

  return bytes;
}

function isSqliteDatabase(bytes: Buffer): boolean {
  return bytes.length >= 100 &&
    bytes.subarray(0, 16).toString('binary') ===
      'SQLite format 3\u0000';
}

function readAccountJson(bytes: Buffer): unknown[] | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) return parsed;

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'accounts' in parsed &&
    Array.isArray((parsed as { accounts: unknown }).accounts)
  ) {
    return (parsed as { accounts: unknown[] }).accounts;
  }

  return null;
}

function countAccounts(databasePath: string): number {
  if (!fs.existsSync(databasePath)) return 0;

  const db = new DatabaseSync(databasePath, {
    readOnly: true
  });

  try {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'accounts'
    `).all();

    if (tables.length === 0) return 0;

    const row = db.prepare(
      'SELECT COUNT(*) AS count FROM accounts'
    ).get() as { count: number };

    return Number(row.count);
  } finally {
    db.close();
  }
}

/**
 * 僅在本機帳號資料庫沒有帳號時還原。
 * 已有帳號時不覆蓋，避免覆蓋使用者目前資料。
 */
export async function restoreAccountsFromGitHub(
  workDir: string = process.cwd()
): Promise<void> {
  const dataDir = path.join(workDir, 'data');
  const databasePath = path.join(dataDir, 'data.db');

  fs.mkdirSync(dataDir, { recursive: true });

  // 已有帳號就不碰本機資料庫。
  if (countAccounts(databasePath) > 0) {
    console.log('[backup] 本機已有帳號，略過 GitHub 還原');
    return;
  }

  // 避免 GitHub 尚未設定時阻止一般服務啟動。
  if (
    !process.env.GITHUB_TOKEN ||
    !process.env.GITHUB_DATA_REPO ||
    !process.env.ACCOUNT_SYNC_KEY
  ) {
    console.warn('[backup] GitHub 備份環境變數未完整設定，略過還原');
    return;
  }

  const encrypted = await downloadBackup();
  const decrypted = decryptBackup(encrypted);

  if (isSqliteDatabase(decrypted)) {
    // 先以唯讀模式驗證備份資料庫，絕不直接覆蓋非空資料庫。
    const tempPath = path.join(
      dataDir,
      `.restore-${process.pid}-${Date.now()}.db`
    );

    try {
      fs.writeFileSync(tempPath, decrypted, { flag: 'wx' });

      const count = countAccounts(tempPath);

      if (count <= 0) {
        throw new Error('[backup] SQLite 備份沒有帳號，拒絕安裝');
      }

      // 再次確認目標沒有帳號，降低啟動時的競爭風險。
      if (countAccounts(databasePath) > 0) {
        console.log('[backup] 本機帳號已出現，取消還原');
        return;
      }

      // 保留現有空資料庫副本，不直接刪除。
      if (fs.existsSync(databasePath)) {
        const preserved = `${databasePath}.before-restore`;
        if (!fs.existsSync(preserved)) {
          fs.copyFileSync(databasePath, preserved);
        }
      }

      fs.renameSync(tempPath, databasePath);

      console.log(`[backup] SQLite 備份還原完成：${count} 個帳號`);
      return;
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { force: true });
      }
    }
  }

  const accounts = readAccountJson(decrypted);

  if (!accounts || accounts.length === 0) {
    throw new Error(
      '[backup] 解密成功，但內容既不是 SQLite 資料庫，也不是有效帳號 JSON'
    );
  }

  const validAccounts = accounts.filter(
    (item): item is Record<string, unknown> =>
      item !== null &&
      typeof item === 'object' &&
      !Array.isArray(item)
  );

  if (
    validAccounts.length !== accounts.length ||
    !validAccounts.every(
      account =>
        typeof account.api_access_key === 'string' &&
        account.api_access_key.trim().length > 0
    )
  ) {
    throw new Error('[backup] JSON 帳號欄位驗證失敗，拒絕還原');
  }

  // 寫入舊 JSON，讓現有 SqliteAccountStore 的遷移機制匯入。
  const jsonPath = path.join(dataDir, 'accounts.json');

  if (fs.existsSync(jsonPath)) {
    throw new Error(
      '[backup] 已有 accounts.json；為避免覆蓋，取消 JSON 還原'
    );
  }

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(validAccounts, null, 2),
    { flag: 'wx', mode: 0o600 }
  );

  console.log(
    `[backup] 已恢復 ${validAccounts.length} 個 JSON 帳號，等待 SQLite 遷移`
  );
}
