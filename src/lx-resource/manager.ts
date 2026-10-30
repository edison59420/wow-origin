
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
  LxTrackUrlResolver
} from './types';

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const INITIALIZATION_TIMEOUT_MS = 10_000;
const SOURCE_REQUEST_TIMEOUT_MS = 5_000;
const SOURCE_CHAIN_TIMEOUT_MS = 15_000;

const MAX_BACKGROUND_RETRIES = 5;
const RETRY_DELAYS_MS = [
  1000,
  2000,
  4000,
  8000,
  15000
];

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
  return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex');
}

function validateAudioUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 2048
  ) {
    throw new Error(
      'LX source returned an invalid audio URL'
    );
  }

  const url = new URL(value);

  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'https:'
  ) {
    throw new Error(
      'LX source returned a non-HTTP audio URL'
    );
  }

  return value;
}

function safeErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;

    return status
      ? `${error.code || 'HTTP_ERROR'} (${status})`
      : (error.code || 'network error');
  }

  const message =
    error instanceof Error
      ? error.message
      : String(error);

  return message
    .replace(/https?:\/\/[^\s]+/g, '[url]')
    .slice(0, 1024);
}

export class LxSourceManager
  implements LxTrackUrlResolver, LxSourceLifecycle {

  private readonly globalConfigs: LxSourceConfig[];

  private configs: LxSourceConfig[];

  private readonly cacheDirectory: string;

  private readonly downloadSourceImpl:
    (url: string) => Promise<string>;

  private readonly sources =
    new Map<string, RegisteredSource>();

  private readonly operations =
    new Map<string, Promise<void>>();

  private readonly retryTimers =
    new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * 初次載入不計入重試次數。
   * 每條音源最多額外重試 5 次。
   */
  private readonly retryAttempts =
    new Map<string, number>();

  private initialLoad?: Promise<void>;

  private stopped = false;

  constructor(options: ManagerOptions) {
    this.globalConfigs = [...options.configs].sort(
      (left, right) => left.order - right.order
    );

    this.configs = [...this.globalConfigs];

    this.cacheDirectory =
      options.cacheDirectory ??
      getLxSourceCacheDirectory(options.workDir);

    this.downloadSourceImpl =
      options.downloadSource ??
      ((url) => this.downloadSource(url));
  }

  /**
   * 啟動音源管理器。
   */
  start(): void {
    if (this.initialLoad || this.stopped) return;

    this.initialLoad = Promise.all(
      this.configs.map((config) =>
        this.runExclusive(config, () =>
          this.loadWithBackgroundRecovery(config)
        )
      )
    )
      .then(() => undefined)
      .catch((error) => {
        console.warn(
          '[lx-source] initial background load failed',
          safeErrorMessage(error)
        );
      });
  }

  async waitForInitialLoad(): Promise<void> {
    await this.initialLoad;
  }

  /**
   * 全域音源與帳號專屬音源取並集。
   * 相同 URL 只註冊一次。
   */
  reconcileAccountSources(
    sourceGroups: readonly (readonly string[])[]
  ): void {
    const desired = new Map<string, LxSourceConfig>();

    this.globalConfigs.forEach((config) => {
      desired.set(config.hash, config);
    });

    sourceGroups.forEach((sources) => {
      createLxSourceConfigs(sources).forEach((config) => {
        desired.set(config.hash, config);
      });
    });

    const previousHashes = new Set(
      this.configs.map((config) => config.hash)
    );

    this.configs = [...desired.values()];

    // 移除已不需要的音源。
    for (const [hash, source] of this.sources.entries()) {
      if (desired.has(hash)) continue;

      this.sources.delete(hash);

      void source.runtime.drainAndTerminate();
    }

    // 清除已不需要的背景重試。
    for (const [hash, timer] of this.retryTimers.entries()) {
      if (desired.has(hash)) continue;

      clearTimeout(timer);
      this.retryTimers.delete(hash);
      this.retryAttempts.delete(hash);
    }

    if (!this.initialLoad || this.stopped) return;

    this.configs
      .filter((config) => !previousHashes.has(config.hash))
      .forEach((config) => {
        void this.runExclusive(config, () =>
          this.loadWithBackgroundRecovery(config)
        );
      });
  }

  /**
   * 取得歌曲播放網址。
   *
   * 同一音質最多 3 條音源並行。
   * 最快取得有效網址者勝出。
   * 勝出後取消其他尚未完成的請求。
   */
  async resolveTrackUrl(
    platform: MusicPlatform,
    id: string,
    quality?: string,
    accountSources: readonly string[] = [],
    options: { allowFallback?: boolean } = {}
  ): Promise<TrackUrl | undefined> {
    if (this.stopped || this.sources.size === 0) {
      return undefined;
    }

    const lxPlatform = mapMusicPlatformToLx(platform);

    const deadline =
      Date.now() + SOURCE_CHAIN_TIMEOUT_MS;

    const selectedConfigs =
      new Map<string, LxSourceConfig>();

    // 帳號專屬音源優先。
    createLxSourceConfigs(accountSources).forEach(
      (config) => {
        selectedConfigs.set(config.hash, config);
      }
    );

    // 全域音源補足。
    this.globalConfigs.forEach((config) => {
      if (!selectedConfigs.has(config.hash)) {
        selectedConfigs.set(config.hash, config);
      }
    });

    // 最多取 3 條符合平台能力的音源。
    const activeSources = [
      ...selectedConfigs.values()
    ]
      .map((config) => ({
        config,
        source: this.sources.get(config.hash)
      }))
      .filter(
        (
          item
        ): item is {
          config: LxSourceConfig;
          source: RegisteredSource;
        } => Boolean(
          item.source?.capabilities[lxPlatform]
        )
      )
      .slice(0, 3);

    if (activeSources.length === 0) {
      return undefined;
    }

    const availableQualities = [
      ...new Set(
        activeSources.flatMap(({ source }) =>
          source.capabilities[lxPlatform]?.qualities ?? []
        )
      )
    ];

    // 依照 App 要求的音質決定查詢順序。
    const qualityCandidates = getLxQualityPriority(
      platform,
      quality,
      availableQualities,
      options.allowFallback !== false
    );

    this.log(
      'info',
      'quality',
      'request',
      `App 音質要求=${quality || 'default'}，查詢順序=${qualityCandidates.join(' → ')}`
    );

    // 逐級嘗試音質。
    for (const lxQuality of qualityCandidates) {
      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        this.log(
          'warn',
          'quality',
          'timeout',
          '音源查詢超過總時間限制'
        );

        break;
      }

      const eligible = activeSources.filter(
        ({ source }) =>
          source.capabilities[lxPlatform]?.qualities.includes(
            lxQuality
          )
      );

      if (eligible.length === 0) continue;

      this.log(
        'info',
        'quality',
        'parallel',
        `開始查詢 ${lxQuality}，並發音源數=${eligible.length}`
      );

      // 同一音質共用一個取消控制器。
      const controller = new AbortController();

      const attempts = eligible.map(
        ({ config, source }) => {
          const startedAt = Date.now();

          return source.runtime.invoke(
            {
              source: lxPlatform,
              quality: lxQuality,
              timeoutMs: Math.min(
                SOURCE_REQUEST_TIMEOUT_MS,
                remaining
              ),
              musicInfo: {
                id,
                songmid: id,
                ...(lxPlatform === 'tx'
                  ? { strMediaMid: id }
                  : {}),
                source: lxPlatform,
                types: source.capabilities[
                  lxPlatform
                ]!.qualities.map((type) => ({
                  type,
                  size: null
                }))
              }
            },
            controller.signal
          )
            .then((result) => {
              const audioUrl = validateAudioUrl(result);

              const elapsed = Date.now() - startedAt;

              this.log(
                'info',
                source.name,
                config.hash,
                `${lxQuality} 有效網址取得成功，耗時 ${elapsed}ms`
              );

              return mapLxQualityToTrackUrl(
                audioUrl,
                lxQuality
              );
            })
            .catch((error: unknown) => {
              this.log(
                'warn',
                source.name,
                config.hash,
                `${lxQuality} 請求失敗：${safeErrorMessage(error)}`
              );

              throw error;
            });
        }
      );

      try {
        // 第一個成功的有效結果優先。
        const result = await Promise.any(attempts);

        this.log(
          'info',
          'quality',
          'winner',
          `${lxQuality} 已取得有效網址，取消其他未完成音源請求`
        );

        return result;
      } catch {
        this.log(
          'warn',
          'quality',
          'fallback',
          `${lxQuality} 所有可用音源都失敗，準備嘗試下一檔位`
        );
      } finally {
        // 無論成功或失敗，都清理同檔位其他請求。
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }
    }

    return undefined;
  }

  async updateAll(): Promise<void> {
    if (this.stopped) return;

    for (const config of this.configs) {
      await this.runExclusive(config, () =>
        this.updateSource(config)
      );
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;

    this.stopped = true;

    // 清除所有背景重試。
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }

    this.retryTimers.clear();
    this.retryAttempts.clear();

    await Promise.allSettled([
      ...this.operations.values()
    ]);

    const runtimes = [
      ...this.sources.values()
    ].map((source) => source.runtime);

    this.sources.clear();

    await Promise.allSettled(
      runtimes.map((runtime) => runtime.terminate())
    );
  }

  /**
   * 初次載入：
   * 先讀取本地快取。
   * 快取失敗才重新下載。
   */
  private async loadAtStartup(
    config: LxSourceConfig
  ): Promise<void> {
    if (this.stopped) return;

    await fs.mkdir(this.cacheDirectory, {
      recursive: true
    });

    const cachePath = getLxSourceCachePath(
      this.cacheDirectory,
      config.hash
    );

    let cachedName = '';

    try {
      const cachedScript = await fs.readFile(
        cachePath,
        'utf8'
      );

      cachedName = parseLxScriptInfo(
        cachedScript
      ).name;

      await this.registerScript(
        config,
        cachedScript,
        false
      );

      if (!this.sources.has(config.hash)) {
        throw new Error(
          '快取音源初始化後未成功註冊'
        );
      }

      return;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        this.log(
          'warn',
          cachedName,
          config.hash,
          `本地快取載入或註冊失敗，準備重新下載：${safeErrorMessage(error)}`
        );
      }
    }

    if (this.stopped) return;

    let downloadedName = '';

    try {
      const downloadedScript =
        await this.downloadSourceImpl(config.url);

      downloadedName = parseLxScriptInfo(
        downloadedScript
      ).name;

      await this.registerScript(
        config,
        downloadedScript,
        true
      );

      if (!this.sources.has(config.hash)) {
        throw new Error(
          '下載音源初始化後未成功註冊'
        );
      }
    } catch (error) {
      this.log(
        'error',
        downloadedName,
        config.hash,
        `下載或註冊失敗：${safeErrorMessage(error)}`
      );

      throw error;
    }
  }

  /**
   * 初次失敗不阻塞主程式。
   * 交由背景排程重試。
   */
  private async loadWithBackgroundRecovery(
    config: LxSourceConfig
  ): Promise<void> {
    try {
      await this.loadAtStartup(config);
    } catch (error) {
      this.log(
        'warn',
        '',
        config.hash,
        `首次初始化或註冊失敗：${safeErrorMessage(error)}`
      );

      this.scheduleRecovery(
        config,
        '首次初始化或註冊失敗'
      );
    }
  }

  /**
   * 背景恢復：
   * 初次失敗後最多額外重試 5 次。
   *
   * 延遲：1、2、4、8、15 秒。
   */
  private scheduleRecovery(
    config: LxSourceConfig,
    reason: string
  ): void {
    if (this.stopped) return;

    if (
      !this.configs.some(
        (candidate) => candidate.hash === config.hash
      )
    ) {
      return;
    }

    if (this.sources.has(config.hash)) return;

    if (this.retryTimers.has(config.hash)) return;

    const attempts =
      this.retryAttempts.get(config.hash) ?? 0;

    if (attempts >= MAX_BACKGROUND_RETRIES) {
      this.log(
        'error',
        '',
        config.hash,
        `背景恢復已達上限 ${MAX_BACKGROUND_RETRIES} 次，停止重試`
      );

      return;
    }

    const nextAttempt = attempts + 1;

    this.retryAttempts.set(
      config.hash,
      nextAttempt
    );

    const delay =
      RETRY_DELAYS_MS[nextAttempt - 1] ??
      RETRY_DELAYS_MS[
        RETRY_DELAYS_MS.length - 1
      ];

    this.log(
      'warn',
      '',
      config.hash,
      `${reason}，${delay}ms 後進行背景重新註冊 ${nextAttempt}/${MAX_BACKGROUND_RETRIES}`
    );

    const timer = setTimeout(() => {
      this.retryTimers.delete(config.hash);

      if (this.stopped) return;

      if (
        !this.configs.some(
          (candidate) => candidate.hash === config.hash
        )
      ) {
        return;
      }

      void this.runExclusive(config, async () => {
        if (this.stopped) return;

        if (this.sources.has(config.hash)) return;

        try {
          this.log(
            'info',
            '',
            config.hash,
            `開始背景重新下載及註冊 ${nextAttempt}/${MAX_BACKGROUND_RETRIES}`
          );

          await this.loadAtStartup(config);

          if (!this.sources.has(config.hash)) {
            throw new Error(
              '重新註冊後音源仍未啟用'
            );
          }

          this.log(
            'info',
            '',
            config.hash,
            `背景重新註冊成功，第 ${nextAttempt} 次恢復完成`
          );
        } catch (error) {
          this.log(
            'error',
            '',
            config.hash,
            `背景重新註冊失敗 ${nextAttempt}/${MAX_BACKGROUND_RETRIES}：${safeErrorMessage(error)}`
          );

          this.scheduleRecovery(
            config,
            '背景重新註冊失敗'
          );
        }
      });
    }, delay);

    timer.unref?.();

    this.retryTimers.set(
      config.hash,
      timer
    );
  }

  /**
   * 更新音源。
   * 更新失敗時保留原本正常運作的版本。
   */
  private async updateSource(
    config: LxSourceConfig
  ): Promise<void> {
    const current = this.sources.get(config.hash);

    try {
      const script = await this.downloadSourceImpl(
        config.url
      );

      const digest = contentDigest(script);

      if (
        current &&
        current.scriptDigest === digest
      ) {
        this.log(
          'info',
          current.name,
          config.hash,
          '源內容無變化'
        );

        return;
      }

      await this.registerScript(
        config,
        script,
        true
      );

      const updated = this.sources.get(config.hash);

      if (!updated) {
        throw new Error(
          '更新後音源未成功註冊'
        );
      }

      this.log(
        'info',
        updated.name,
        config.hash,
        '源更新成功'
      );
    } catch (error) {
      this.log(
        'error',
        current?.name ?? '',
        config.hash,
        `源更新失敗，保留當前版本：${safeErrorMessage(error)}`
      );
    }
  }

  /**
   * 初始化、驗證及註冊音源。
   */
  private async registerScript(
    config: LxSourceConfig,
    script: string,
    persist: boolean
  ): Promise<void> {
    if (!script.trim()) {
      throw new Error('LX source script is empty');
    }

    if (
      Buffer.byteLength(script) > MAX_SOURCE_BYTES
    ) {
      throw new Error(
        'LX source script exceeds 5 MiB'
      );
    }

    if (this.stopped) return;

    const sourceInfo = parseLxScriptInfo(script);

    let runtimeLogName = sourceInfo.name;
    let runtimeExited = false;

    const runtime = new LxSourceRuntime({
      script,
      sourceInfo,
      initializationTimeoutMs:
        INITIALIZATION_TIMEOUT_MS,

      onLog: (level, message) => {
        this.log(
          level,
          runtimeLogName,
          config.hash,
          message
        );
      },

      onExit: (event) => {
        if (event.expected) return;

        runtimeExited = true;

        const current = this.sources.get(config.hash);

        if (current?.runtime !== runtime) {
          return;
        }

        this.sources.delete(config.hash);

        this.log(
          'error',
          current.name,
          config.hash,
          `Worker 異常退出，退出代碼=${event.code}`
        );

        this.scheduleRecovery(
          config,
          'Worker 註冊後異常退出'
        );
      }
    });

    let initialization;

    try {
      initialization = await runtime.initialize();

      if (runtimeExited || runtime.isStopped) {
        throw new Error(
          'Worker 初始化後立即退出'
        );
      }

      runtimeLogName =
        initialization.sourceInfo.name;

      if (persist) {
        await this.persistScript(config, script);
      }

      if (runtimeExited || runtime.isStopped) {
        throw new Error(
          'Worker 在持久化期間異常退出'
        );
      }
    } catch (error) {
      await runtime.terminate();
      throw error;
    }

    if (this.stopped) {
      await runtime.terminate();
      return;
    }

    if (
      !this.configs.some(
        (candidate) => candidate.hash === config.hash
      )
    ) {
      await runtime.terminate();
      return;
    }

    if (runtimeExited || runtime.isStopped) {
      await runtime.terminate();

      throw new Error(
        'Worker 未能保持正常啟用狀態'
      );
    }

    const previous = this.sources.get(config.hash);

    const registered: RegisteredSource = {
      config,
      name: initialization.sourceInfo.name,
      scriptDigest: contentDigest(script),
      capabilities: initialization.capabilities,
      runtime
    };

    this.sources.set(
      config.hash,
      registered
    );

    if (
      this.sources.get(config.hash)?.runtime !== runtime ||
      runtimeExited ||
      runtime.isStopped
    ) {
      if (
        this.sources.get(config.hash)?.runtime === runtime
      ) {
        this.sources.delete(config.hash);
      }

      await runtime.terminate();

      throw new Error(
        '音源註冊後未能保持啟用'
      );
    }

    // 成功註冊後重置重試狀態。
    // 日後若 Worker 再次異常退出，可重新獲得 5 次重試。
    const existingTimer = this.retryTimers.get(config.hash);

    if (existingTimer) {
      clearTimeout(existingTimer);
      this.retryTimers.delete(config.hash);
    }

    this.retryAttempts.delete(config.hash);

    const platforms = Object.keys(
      initialization.capabilities
    );

    this.log(
      'info',
      registered.name,
      config.hash,
      `註冊成功，支持 ${platforms.join('/')}`
    );

    // 新版本成功後，才停止舊版本。
    if (previous && previous.runtime !== runtime) {
      void previous.runtime.drainAndTerminate();
    }
  }

  private async persistScript(
    config: LxSourceConfig,
    script: string
  ): Promise<void> {
    await fs.mkdir(this.cacheDirectory, {
      recursive: true
    });

    const target = getLxSourceCachePath(
      this.cacheDirectory,
      config.hash
    );

    const temporary = path.join(
      this.cacheDirectory,
      `.${config.hash}.${process.pid}.${Date.now()}.tmp`
    );

    try {
      await fs.writeFile(
        temporary,
        script,
        {
          encoding: 'utf8',
          flag: 'wx'
        }
      );

      await fs.rename(
        temporary,
        target
      );
    } catch (error) {
      await fs.unlink(temporary).catch(
        () => undefined
      );

      throw error;
    }
  }

  private async downloadSource(
    url: string
  ): Promise<string> {
    const response = await axios.get<ArrayBuffer>(
      url,
      {
        timeout: DOWNLOAD_TIMEOUT_MS,
        responseType: 'arraybuffer',
        maxContentLength: MAX_SOURCE_BYTES,
        maxBodyLength: MAX_SOURCE_BYTES,
        maxRedirects: 5,
        validateStatus: (status) =>
          status >= 200 && status < 300
      }
    );

    const buffer = Buffer.from(response.data);

    if (buffer.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(
        'LX source script exceeds 5 MiB'
      );
    }

    return buffer.toString('utf8');
  }

  /**
   * 同一音源的下載、初始化及更新操作依序執行。
   */
  private runExclusive(
    config: LxSourceConfig,
    operation: () => Promise<void>
  ): Promise<void> {
    const previous =
      this.operations.get(config.hash) ??
      Promise.resolve();

    const next = previous
      .catch(() => undefined)
      .then(operation);

    this.operations.set(
      config.hash,
      next
    );

    void next.then(
      () => {
        if (
          this.operations.get(config.hash) === next
        ) {
          this.operations.delete(config.hash);
        }
      },
      () => {
        if (
          this.operations.get(config.hash) === next
        ) {
          this.operations.delete(config.hash);
        }
      }
    );

    return next;
  }

  private log(
    level: LxLogLevel,
    name: string,
    hash: string,
    message: string
  ): void {
    const prefix =
      `[lx-source:${sourceLabel(name, hash)}]`;

    const output = `${prefix} ${message}`;

    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else if (level === 'debug') {
      console.debug(output);
    } else {
      console.info(output);
    }
  }
}
