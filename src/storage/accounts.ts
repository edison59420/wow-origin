import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { RawMusicAccount } from '../accounts';
export interface AccountStore {
  readonly location: string;
  list(): RawMusicAccount[];
  insert(account: RawMusicAccount): void;
  delete(apiAccessKey: string): void;
  update(apiAccessKey: string, changes: Partial<RawMusicAccount>): void;
  checkpoint?: () => void;
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
function encode(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    throw new Error('帳號欄位無法序列化為 JSON');
  }
}
function decode(value: string | null): unknown {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    // 舊版本可能直接以文字儲存欄位，保留原始值。
    return value;
  }
}
function normalizePlatform(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  switch (value.trim().toLowerCase()) {
    case 'qqmusic':
    case 'qq-music':
      return 'qq';
    case 'netease-cloud-music':
    case '163':
      return 'netease';
    case 'youtube-music':
      return 'ytmusic';
    default:
      return value.trim().toLowerCase();
  }
}
function accountValues(account: RawMusicAccount): Array<string | null> {
  return [
    encode(normalizePlatform(account.platform)),
    encode(account.name),
    encode(account.cookie),
    typeof account.api_access_key === 'string'
      ? account.api_access_key
      : account.api_access_key == null
        ? null
        : String(account.api_access_key),
    encode(account.stateless),
    encode(account.useLuoxue),
    encode(account.lxSource),
    encode(account.deviceId),
    encode(account.deviceState)
  ];
}
function rowToAccount(row: StoredAccountRow): RawMusicAccount {
  return {
    platform: normalizePlatform(decode(row.platform)) as RawMusicAccount['platform'],
    name: decode(row.name) as RawMusicAccount['name'],
    cookie: decode(row.cookie) as RawMusicAccount['cookie'],
    api_access_key: row.api_access_key ?? undefined,
    stateless: decode(row.stateless) as RawMusicAccount['stateless'],
    useLuoxue: decode(row.use_luoxue) as RawMusicAccount['useLuoxue'],
    lxSource: decode(row.lx_source) as RawMusicAccount['lxSource'],
    deviceId: decode(row.device_id) as RawMusicAccount['deviceId'],
    deviceState: decode(row.device_state) as RawMusicAccount['deviceState']
  };
}
export function sqliteAccountsFilePath(
  workDir: string = process.cwd()
): string {
  return path.join(workDir, 'data', 'data.db');
}
function migrateLegacySqliteFile(
  workDir: string,
  destination: string
): void {
  // 已有主資料庫時絕不覆蓋。
  if (fs.existsSync(destination)) return;
  const legacy = path.join(workDir, 'data', 'wow-origin.sqlite');
  if (!fs.existsSync(legacy)) return;
  // 舊資料庫可能使用 WAL。先確認來源存在，再搬移資料庫檔案。
  for (const suffix of ['-wal', '-shm']) {
    const source = `${legacy}${suffix}`;
    if (fs.existsSync(source)) {
      fs.renameSync(source, `${destination}${suffix}`);
    }
  }
  fs.renameSync(legacy, destination);
  console.log('[accounts] 已遷移舊 SQLite 資料庫檔案');
}
export class SqliteAccountStore implements AccountStore {
  readonly location: string;
  private readonly database: DatabaseSync;
  private readonly insertStatement: StatementSync;
  constructor(workDir: string = process.cwd()) {
    this.location = sqliteAccountsFilePath(workDir);
    fs.mkdirSync(path.dirname(this.location), {
      recursive: true
    });
    migrateLegacySqliteFile(workDir, this.location);
    this.database = new DatabaseSync(this.location);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
    this.database.exec(SCHEMA);
    this.ensureColumn('deviceId', 'TEXT');
    this.ensureColumn('device_state', 'TEXT');
    this.insertStatement = this.database.prepare(`
      INSERT INTO accounts (
        platform,
        name,
        cookie,
        api_access_key,
        stateless,
        use_luoxue,
        lx_source,
        deviceId,
        device_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS account_migrations (
        name TEXT PRIMARY KEY
      )
    `);
    this.migrateLegacyAccountsSafely(workDir);
  }
  private ensureColumn(name: string, type: string): void {
    // 欄位名稱來自程式固定常數，不接受外部輸入。
    const allowed = new Set(['deviceId', 'device_state']);
    if (!allowed.has(name)) {
      throw new Error(`不允許的資料庫欄位：${name}`);
    }
    const columns = this.database
      .prepare('PRAGMA table_info(accounts)')
      .all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === name)) {
      this.database.exec(
        `ALTER TABLE accounts ADD COLUMN "${name}" ${type}`
      );
    }
  }
  list(): RawMusicAccount[] {
    const rows = this.database.prepare(`
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
    `).all() as unknown as StoredAccountRow[];
    return rows.map(rowToAccount);
  }
  insert(account: RawMusicAccount): void {
    if (!account || typeof account !== 'object') {
      throw new Error('帳號資料格式錯誤');
    }
    this.insertStatement.run(...accountValues(account));
  }
  update(
    apiAccessKey: string,
    changes: Partial<RawMusicAccount>
  ): void {
    const row = this.database.prepare(`
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
      WHERE api_access_key = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(apiAccessKey) as unknown as StoredAccountRow | undefined;
    if (!row) {
      throw new Error('SQLite 中未找到对应 api_access_key');
    }
    const account: RawMusicAccount = {
      ...rowToAccount(row),
      ...changes,
      api_access_key: apiAccessKey
    };
    this.database.prepare(`
      UPDATE accounts
      SET
        platform = ?,
        name = ?,
        cookie = ?,
        api_access_key = ?,
        stateless = ?,
        use_luoxue = ?,
        lx_source = ?,
        deviceId = ?,
        device_state = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...accountValues(account), row.id);
  }
  delete(apiAccessKey: string): void {
    this.database.prepare(`
      DELETE FROM accounts
      WHERE api_access_key = ?
    `).run(apiAccessKey);
  }
  checkpoint(): void {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close(): void {
    this.database.close();
  }
  private getAccountCount(): number {
    const result = this.database
      .prepare('SELECT COUNT(*) AS count FROM accounts')
      .get() as { count: number };
    return Number(result.count);
  }
  private isMigrationDone(name: string): boolean {
    return Boolean(
      this.database
        .prepare('SELECT name FROM account_migrations WHERE name = ?')
        .get(name)
    );
  }
  private markMigrationDone(name: string): void {
    this.database.prepare(`
      INSERT OR REPLACE INTO account_migrations (name)
      VALUES (?)
    `).run(name);
  }
  private migrateLegacyAccountsSafely(workDir: string): void {
    const legacyPath = path.join(
      workDir,
      'data',
      'accounts.json'
    );
    const count = this.getAccountCount();
    // 有現存帳號時不從舊 JSON 匯入，避免重複或覆蓋。
    if (count > 0) {
      if (!this.isMigrationDone('legacy-json')) {
        this.markMigrationDone('legacy-json');
      }
      console.log(`[accounts] SQLite 現有帳號資料筆數：${count}`);
      return;
    }
    // 沒有舊檔案時不寫遷移標記；
    // 之後若舊檔案恢復到位，仍可重新檢查。
    if (!fs.existsSync(legacyPath)) {
      console.log('[accounts] 未找到舊 accounts.json，保留現有資料庫');
      return;
    }
    const content = fs.readFileSync(legacyPath, 'utf8');
    if (!content.trim()) {
      console.warn('[accounts] 舊 accounts.json 是空檔，保留原檔');
      return;
    }
    let accounts: unknown;
    try {
      accounts = JSON.parse(content);
    } catch (error) {
      console.error(
        '[accounts] 舊帳號 JSON 解析失敗，保留原檔',
        error
      );
      throw new Error('舊帳號檔案格式錯誤，停止遷移以保護資料', {
        cause: error
      });
    }
    if (!Array.isArray(accounts)) {
      throw new Error(
        '舊 accounts.json 必須是陣列；停止遷移以保護資料'
      );
    }
    const validAccounts = accounts.filter(
      (account): account is RawMusicAccount =>
        Boolean(account) &&
        typeof account === 'object' &&
        !Array.isArray(account)
    );
    if (validAccounts.length === 0) {
      console.warn(
        '[accounts] 舊 JSON 中沒有可遷移的帳號，保留原檔'
      );
      return;
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const account of validAccounts) {
        this.insert(account);
      }
      const countAfter = this.getAccountCount();
      if (countAfter < validAccounts.length) {
        throw new Error('遷移後帳號數量檢查失敗');
      }
      this.markMigrationDone('legacy-json');
      this.database.exec('COMMIT');
      console.log(
        `[accounts] 舊帳號 JSON 遷移成功：${validAccounts.length} 筆`
      );
      // 故意保留 accounts.json，不自動刪除備份檔案。
    } catch (error) {
      this.database.exec('ROLLBACK');
      console.error(
        '[accounts] 舊帳號遷移失敗，已回滾資料庫交易',
        error
      );
      throw error;
    }
  }
}
export function createLocalAccountStore(
  workDir: string = process.cwd()
): SqliteAccountStore {
  return new SqliteAccountStore(workDir);
}
