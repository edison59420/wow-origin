import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import type { TrackUrl } from 'aduoer-wow-sdk';
import type { MusicPlatform } from '../types';
import {
  getLxSourceCacheDirectory,
  getLxSourceCachePath,
  createLxSourceConfigs,
  mapLxQualityToTrackUrl,
  mapMusicPlatformToLx,
  parseLxScriptInfo,
  sourceLabel
} from './config';
import { LxSourceRuntime } from './runtime';
import { getLxQualityPriority } from './quality';
import type {
  LxLogLevel,
  LxSourceCapabilities,
  LxSourceConfig,
  LxSourceLifecycle,
  LxTrackUrlResolver,
  LxQuality,
  LxWorkerInitialization
} from './types';

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const INITIALIZATION_TIMEOUT_MS = 10_000;
const SOURCE_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_SOURCES = 5;
const MAX_BACKGROUND_RETRIES = 5;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;

type RegisteredSource = {
  config: LxSourceConfig;
  name: string;
  scriptDigest: string;
  capabilities: LxSourceCapabilities;
  runtime: LxSourceRuntime;
};

type ManagerOptions = {
  configs: LxSourceConfig[];
  workDir?: string;
  cacheDirectory?: string;
  downloadSource?: (url: string) => Promise<string>;
};

function contentDigest(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 只接受非空 HTTP(S) URL。這是格式驗證，不會對音檔網址發 HEAD/GET 探測，
 * 避免部分音源拒絕 HEAD、一次性簽名網址或 Range 探測造成誤判。
 */
function validateAudioUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('LX source returned an empty or non-string audio URL');
  }

  const audioUrl = value.trim();
  if (
    audioUrl.length === 0 ||
    audioUrl.length > 2048 ||
    /^(?:null|undefined|false|0)$/i.test(audioUrl)
  ) {
    throw new Error('LX source returned an empty or invalid audio URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(audioUrl);
  } catch {
    throw new Error('LX source returned a malformed audio URL');
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error('LX source returned a non-HTTP or invalid audio URL');
  }

  return audioUrl;
}

function safeErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? `${error.code || 'HTTP_ERROR'} (${status})` : (error.code || 'network error');
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, '[url]').slice(0, 1024);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LxSourceManager implements LxTrackUrlResolver, LxSourceLifecycle {
  private readonly globalConfigs: LxSourceConfig[];
  private configs: LxSourceConfig[];
  private readonly cacheDirectory: string;
  private readonly downloadSourceImpl: (url: string) => Promise<string>;
  private readonly sources = new Map<string, RegisteredSource>();
  private readonly operations = new Map<string, Promise<void>>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly recoveryTimers = new Map<string, NodeJS.Timeout>();
  private initialLoad?: Promise<void>;
  private stopped = false;

  constructor(options: ManagerOptions) {
    this.globalConfigs = [...options.configs].sort((left, right) => left.order - right.order);
    this.configs = [...this.globalConfigs];
    this.cacheDirectory = options.cacheDirectory
      ?? getLxSourceCacheDirectory(options.workDir);
    this.downloadSourceImpl = options.downloadSource ?? ((url) => this.downloadSource(url));
  }

  start(): void {
    if (this.initialLoad || this.stopped) return;

    this.initialLoad = Promise.all(this.configs.map((config) => (
      this.runExclusive(config, () => this.loadAtStartup(config))
    ))).then(() => undefined).catch((error) => {
      console.warn('[lx-source] initial background load failed', safeErrorMessage(error));
    });
  }

  async waitForInitialLoad(): Promise<void> {
    await this.initialLoad;
  }

  /**
   * 管理器持有全域音源與所有帳號音源的並集。相同 URL 只註冊一次；
   * 每次請求仍依 accountSources 優先，再接全域音源。
   */
  reconcileAccountSources(sourceGroups: readonly (readonly string[])[]): void {
    const desired = new Map<string, LxSourceConfig>();
    this.globalConfigs.forEach((config) => desired.set(config.hash, config));
    sourceGroups.forEach((sources) => {
      createLxSourceConfigs(sources).forEach((config) => desired.set(config.hash, config));
    });

    const previousHashes = new Set(this.configs.map((config) => config.hash));
    this.configs = [...desired.values()];

    for (const [hash, source] of this.sources.entries()) {
      if (desired.has(hash)) continue;
      this.sources.delete(hash);
      void source.runtime.drainAndTerminate();
    }

    for (const [hash, timer] of this.recoveryTimers.entries()) {
      if (desired.has(hash)) continue;
      clearTimeout(timer);
      this.recoveryTimers.delete(hash);
      this.recoveryAttempts.delete(hash);
    }

    if (!this.initialLoad || this.stopped) return;

    this.configs
      .filter((config) => !previousHashes.has(config.hash))
      .forEach((config) => {
        void this.runExclusive(config, () => this.loadAtStartup(config));
      });
  }

  async resolveTrackUrl(
    platform: MusicPlatform,
    id: string,
    quality?: string,
    accountSources: readonly string[] = [],
    options: { allowFallback?: boolean } = {}
  ): Promise<TrackUrl | undefined> {
    if (this.stopped || this.sources.size === 0) return undefined;
    if (quality?.trim().toLowerCase() === 'jyeffect') return undefined;

    const lxPlatform = mapMusicPlatformToLx(platform);
    const selectedConfigs = new Map<string, LxSourceConfig>();

    createLxSourceConfigs(accountSources).forEach((config) => selectedConfigs.set(config.hash, config));
    this.globalConfigs.forEach((config) => selectedConfigs.set(config.hash, config));

    // 先依帳號音源順序，再依全域音源順序；最多挑選五條已註冊且支援該平台的音源。
    const selectedSources: RegisteredSource[] = [];
    for (const config of selectedConfigs.values()) {
      const source = this.sources.get(config.hash);
      if (!source?.capabilities[lxPlatform]) continue;
      selectedSources.push(source);
      if (selectedSources.length >= MAX_CONCURRENT_SOURCES) break;
    }

    if (selectedSources.length === 0) return undefined;

    const availableQualities = [...new Set(
      selectedSources.flatMap((source) => source.capabilities[lxPlatform]?.qualities ?? [])
    )] as LxQuality[];

    // 以 Aduoer App 指定音質為起點；只有 App 明確指定 max 才從平台最高音質開始。
    // fallback 只降到 320k；若 App 本身明確要求 128k，則仍尊重該明確要求。
    const requestedQuality = quality?.trim().toLowerCase() || 'exhigh';
    const requested128k = requestedQuality === '128k' || requestedQuality === 'standard';
    const qualityCandidates = getLxQualityPriority(
      platform,
      quality,
      availableQualities,
      options.allowFallback !== false
    ).filter((candidate) => requested128k || candidate !== '128k');

    if (qualityCandidates.length === 0) {
      this.log('warn', '', '', '沒有任何已註冊音源支援 320k 或更高音質');
      return undefined;
    }

    const controllers = selectedSources.map(() => new AbortController());
    const attempts = selectedSources.map((source, sourceIndex) => {
      const controller = controllers[sourceIndex];
      const capability = source.capabilities[lxPlatform];
      if (!capability) return Promise.reject(new Error('LX source platform capability disappeared'));

      // 每條音源各自循序嘗試音質；五條音源之間並發，但同一條音源絕不並發多個音質。
      const resolveFromSource = async (): Promise<TrackUrl> => {
        let lastError: unknown;

        for (const lxQuality of qualityCandidates) {
          if (controller.signal.aborted) {
            throw new Error('LX source request aborted after another source succeeded');
          }
          if (!capability.qualities.includes(lxQuality)) continue;

          try {
            const rawResult = await source.runtime.invoke({
              source: lxPlatform,
              quality: lxQuality,
              timeoutMs: SOURCE_REQUEST_TIMEOUT_MS,
              musicInfo: {
                id,
                songmid: id,
                ...(lxPlatform === 'tx' ? { strMediaMid: id } : {}),
                source: lxPlatform,
                types: capability.qualities.map((type) => ({ type, size: null }))
              }
            }, controller.signal);

            const audioUrl = validateAudioUrl(rawResult);
            const trackUrl = mapLxQualityToTrackUrl(audioUrl, lxQuality) as TrackUrl;
            this.log('info', source.name, source.config.hash, `取得 ${lxQuality} 有效播放網址，單源逐級流程成功`);
            return trackUrl;
          } catch (error) {
            lastError = error;
            if (controller.signal.aborted) {
              throw error instanceof Error ? error : new Error(String(error));
            }
            this.log(
              'warn',
              source.name,
              source.config.hash,
              `取得 ${lxQuality} 失敗（單次等待上限 ${SOURCE_REQUEST_TIMEOUT_MS}ms），嘗試下一級：${safeErrorMessage(error)}`
            );
          }
        }

        throw lastError instanceof Error
          ? lastError
          : new Error('LX source has no usable quality for the requested tier');
      };

      return resolveFromSource();
    });

    try {
      // 五條來源同時工作；每條來源內部音質請求仍是循序執行，第一條成功即勝出。
      return await Promise.any(attempts);
    } catch {
      this.log('warn', '', '', '五條並發音源均未取得符合 App 音質要求的有效播放網址');
      return undefined;
    } finally {
      // 不論成功或全部失敗，都取消尚未完成的音源請求，釋放 Worker 與網路資源。
      controllers.forEach((controller) => controller.abort());
    }
  }

  async updateAll(): Promise<void> {
    if (this.stopped) return;
    for (const config of this.configs) {
      await this.runExclusive(config, () => this.updateSource(config));
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.recoveryTimers.values()) clearTimeout(timer);
    this.recoveryTimers.clear();
    this.recoveryAttempts.clear();
    await Promise.allSettled([...this.operations.values()]);

    const runtimes = [...this.sources.values()].map((source) => source.runtime);
    this.sources.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.terminate()));
  }

  /** 首次載入失敗時，在背景最多重試 5 次（總計最多 6 次嘗試）。 */
  private async loadAtStartup(config: LxSourceConfig): Promise<void> {
    if (this.stopped || this.sources.has(config.hash)) return;

    for (let attempt = 0; attempt <= MAX_BACKGROUND_RETRIES; attempt += 1) {
      if (this.stopped || !this.configs.some((item) => item.hash === config.hash)) return;

      try {
        await this.loadAtStartupOnce(config);
        if (this.stopped || !this.configs.some((item) => item.hash === config.hash)) return;
        if (this.sources.has(config.hash)) return;
        throw new Error('LX source initialization completed without registering a runtime');
      } catch (error) {
        if (attempt >= MAX_BACKGROUND_RETRIES) {
          this.log('error', '', config.hash, `初始化重試 5 次後仍失敗: ${safeErrorMessage(error)}`);
          return;
        }

        const waitMs = RETRY_DELAYS_MS[attempt];
        this.log(
          'warn',
          '',
          config.hash,
          `初始化失敗，將於 ${waitMs}ms 後進行背景重試 ${attempt + 1}/${MAX_BACKGROUND_RETRIES}: ${safeErrorMessage(error)}`
        );
        await delay(waitMs);
      }
    }
  }

  private async loadAtStartupOnce(config: LxSourceConfig): Promise<void> {
    if (this.stopped) return;
    await fs.mkdir(this.cacheDirectory, { recursive: true });

    const cachePath = getLxSourceCachePath(this.cacheDirectory, config.hash);
    let cachedName = '';

    try {
      const cachedScript = await fs.readFile(cachePath, 'utf8');
      cachedName = parseLxScriptInfo(cachedScript).name;
      await this.registerScript(config, cachedScript, false);
      if (this.sources.has(config.hash) || this.stopped) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log('warn', cachedName, config.hash, `本地快取載入或初始化失敗，改為重新下載: ${safeErrorMessage(error)}`);
      }
    }

    if (this.stopped || !this.configs.some((item) => item.hash === config.hash)) return;

    const downloadedScript = await this.downloadSourceImpl(config.url);
    const downloadedName = parseLxScriptInfo(downloadedScript).name;
    await this.registerScript(config, downloadedScript, true);

    if (!this.sources.has(config.hash) && !this.stopped && this.configs.some((item) => item.hash === config.hash)) {
      throw new Error(`Downloaded source did not register: ${downloadedName || config.hash}`);
    }
  }

  private async updateSource(config: LxSourceConfig): Promise<void> {
    const current = this.sources.get(config.hash);
    try {
      const script = await this.downloadSourceImpl(config.url);
      const digest = contentDigest(script);
      if (current && current.scriptDigest === digest) {
        this.log('info', current.name, config.hash, '源內容無變化');
        return;
      }

      await this.registerScript(config, script, true);
      const updated = this.sources.get(config.hash);
      this.log('info', updated?.name ?? current?.name ?? '', config.hash, '源更新成功');
    } catch (error) {
      this.log('error', current?.name ?? '', config.hash, `源更新失敗，保留目前版本: ${safeErrorMessage(error)}`);
    }
  }

  /**
   * 先在獨立 Worker 中完成初始化校驗；需要持久化時，再寫入臨時檔並原子替換快取。
   * 只有以上步驟全部成功後才切換註冊表，避免半成品音源進入請求鏈。
   */
  private async registerScript(config: LxSourceConfig, script: string, persist: boolean): Promise<void> {
    if (!script.trim()) throw new Error('LX source script is empty');
    if (Buffer.byteLength(script) > MAX_SOURCE_BYTES) throw new Error('LX source script exceeds 5 MiB');

    const sourceInfo = parseLxScriptInfo(script);
    let runtimeLogName = sourceInfo.name;
    let runtime!: LxSourceRuntime;

    runtime = new LxSourceRuntime({
      script,
      sourceInfo,
      initializationTimeoutMs: INITIALIZATION_TIMEOUT_MS,
      onLog: (level, message) => this.log(level, runtimeLogName, config.hash, message),
      onExit: (event) => {
        if (event.expected) return;
        const current = this.sources.get(config.hash);
        if (current?.runtime !== runtime) return;
        this.sources.delete(config.hash);
        const exitError = event.error ?? new Error('LX source worker exited unexpectedly');
        this.log('error', current.name, config.hash, `Worker 異常退出: ${safeErrorMessage(exitError)}`);
        this.scheduleRegistrationRecovery(current.config, exitError);
      }
    });

    let initialization: LxWorkerInitialization;
    try {
      initialization = await runtime.initialize();
      runtimeLogName = initialization.sourceInfo.name;
      if (persist) await this.persistScript(config, script);
      if (!runtime.available) {
        throw new Error('LX source worker exited before registration completed');
      }
    } catch (error) {
      await runtime.terminate();
      throw error;
    }

    if (this.stopped) {
      await runtime.terminate();
      return;
    }
    if (!this.configs.some((candidate) => candidate.hash === config.hash)) {
      await runtime.terminate();
      return;
    }

    const previous = this.sources.get(config.hash);
    const registered: RegisteredSource = {
      config,
      name: initialization.sourceInfo.name,
      scriptDigest: contentDigest(script),
      capabilities: initialization.capabilities,
      runtime
    };

    this.sources.set(config.hash, registered);
    const platforms = Object.keys(initialization.capabilities).filter((key) => (
      initialization.capabilities[key as keyof LxSourceCapabilities]
    ));
    this.log('info', registered.name, config.hash, `註冊成功，支援 ${platforms.join('/')}`);

    if (previous) void previous.runtime.drainAndTerminate();
  }

  /**
   * 音源已註冊後 Worker 若異常退出，代表它已不再處於啟用狀態。
   * 此時在背景重新載入／註冊，最多額外重試 5 次；不影響其他音源。
   */
  private scheduleRegistrationRecovery(config: LxSourceConfig, reason: unknown): void {
    if (
      this.stopped ||
      !this.configs.some((item) => item.hash === config.hash) ||
      this.sources.has(config.hash) ||
      this.recoveryTimers.has(config.hash)
    ) {
      return;
    }

    const previousAttempts = this.recoveryAttempts.get(config.hash) ?? 0;
    if (previousAttempts >= MAX_BACKGROUND_RETRIES) {
      this.log('error', '', config.hash, `音源註冊／啟用背景重試已達上限 5 次，停止重試: ${safeErrorMessage(reason)}`);
      return;
    }

    const attempt = previousAttempts + 1;
    this.recoveryAttempts.set(config.hash, attempt);
    const waitMs = RETRY_DELAYS_MS[attempt - 1];
    this.log(
      'warn',
      '',
      config.hash,
      `音源未保持啟用，將於 ${waitMs}ms 後重新註冊 ${attempt}/${MAX_BACKGROUND_RETRIES}: ${safeErrorMessage(reason)}`
    );

    const timer = setTimeout(() => {
      this.recoveryTimers.delete(config.hash);
      if (
        this.stopped ||
        !this.configs.some((item) => item.hash === config.hash) ||
        this.sources.has(config.hash)
      ) {
        return;
      }

      void this.runExclusive(config, async () => {
        if (this.stopped || this.sources.has(config.hash)) return;
        try {
          await this.loadAtStartupOnce(config);
          if (!this.sources.has(config.hash) && !this.stopped) {
            throw new Error('LX source recovery completed without an active registration');
          }
          if (this.sources.has(config.hash)) {
            this.log('info', this.sources.get(config.hash)?.name ?? '', config.hash, '背景重新註冊成功，音源已恢復啟用');
          }
        } catch (error) {
          this.scheduleRegistrationRecovery(config, error);
        }
      }).catch((error) => {
        this.scheduleRegistrationRecovery(config, error);
      });
    }, waitMs);

    timer.unref?.();
    this.recoveryTimers.set(config.hash, timer);
  }

  private async persistScript(config: LxSourceConfig, script: string): Promise<void> {
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    const target = getLxSourceCachePath(this.cacheDirectory, config.hash);
    const temporary = path.join(
      this.cacheDirectory,
      `.${config.hash}.${process.pid}.${Date.now()}.tmp`
    );

    try {
      await fs.writeFile(temporary, script, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async downloadSource(url: string): Promise<string> {
    const response = await axios.get<ArrayBuffer>(url, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      responseType: 'arraybuffer',
      maxContentLength: MAX_SOURCE_BYTES,
      maxBodyLength: MAX_SOURCE_BYTES,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 300
    });

    const buffer = Buffer.from(response.data);
    if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error('LX source script exceeds 5 MiB');
    return buffer.toString('utf8');
  }

  private runExclusive(config: LxSourceConfig, operation: () => Promise<void>): Promise<void> {
    const previous = this.operations.get(config.hash) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.operations.set(config.hash, next);

    void next.then(() => {
      if (this.operations.get(config.hash) === next) this.operations.delete(config.hash);
    }, () => {
      if (this.operations.get(config.hash) === next) this.operations.delete(config.hash);
    });

    return next;
  }

  private log(level: LxLogLevel, name: string, hash: string, message: string): void {
    const prefix = `[lx-source:${sourceLabel(name, hash)}]`;
    const output = `${prefix} ${message}`;
    if (level === 'error') console.error(output);
    else if (level === 'warn') console.warn(output);
    else if (level === 'debug') console.debug(output);
    else console.info(output);
  }
}
