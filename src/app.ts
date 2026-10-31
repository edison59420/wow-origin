
import path from 'path';
import { Readable } from 'node:stream';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createWowRouter, openApiDocument } from 'aduoer-wow-sdk';
import { createWowContextResolver } from './adapter';
import { preloadData } from './onload';
import { APIError } from './errors';
import { AccountSessionRegistry, extractAuthorizationToken, loadAccountSessions } from './accounts';
import type { AccountStore } from './storage';
import { createLoginRouter } from './login';
import { createDashboardRouter } from './dashboard';
import { createLoginRefreshScheduler, ensureQQLoginFresh, clearAccountLoginRefresh } from './loginRefresh';
import { createLxSourceUpdateScheduler } from './lx-resource/scheduler';
import { clearYTMusicVisitorCache } from './ytmusic/api';
import { YTMusicClient, clearYTMusicTrackCache } from './clients/YTMusicClient';
import { verifyStreamRequest } from './ytmusic/stream';
import { normalizeFragmentedMp4Stream, rebaseMp4Range, sliceByteRange } from './ytmusic/mp4';
import type { LxSourceLifecycle, LxTrackUrlResolver } from './lx-resource/types';
import { createGitHubAccountBackup } from './storage/github-backup';

const Result = require('../core/Result');
const Logger = require('../core/Logger');

const platformFactory = require('../platforms/PlatformFactory');
const NeteasePlatform = require('../platforms/netease/NeteasePlatform');
const QQMusicPlatform = require('../platforms/qqmusic/QQMusicPlatform');

const INTERNAL_RESOURCE_ROUTES = new Set([
  'login/refresh',
  'login/check/expired',
  'login/phone/send',
  'login/phone/check',
  'login/cookie'
]);

class MultiPlatformServer {
  private app: Express | null = null;
  private initialized = false;
  private logger: any;
  private accountSessions: AccountSessionRegistry = {
    sessions: [],
    byAccessKey: new Map()
  };

  private readonly lxSourceManager: AppLxSourceManager;
  private readonly accountStore: AccountStore;
  private readonly cloudflare: boolean;
  private readonly serveStatic: boolean;
  private readonly preload: boolean;
  private readonly adminManagementPassword: string;

  constructor(options: CreateAppOptions = {}) {
    this.adminManagementPassword =
      options.adminManagementPassword ??
      process.env.ADMIN_MANAGEMENT_PASSWORD ??
      '';

    this.logger = new Logger({ component: 'server' });

    this.accountStore =
      options.accountStore ?? loadLocalAccountStore();

    this.lxSourceManager =
      options.lxSourceManager ?? loadLocalLxSourceManager();

    this.cloudflare = options.cloudflare === true;
    this.serveStatic = options.serveStatic ?? !this.cloudflare;
    this.preload = options.preload ?? !this.cloudflare;
  }

  private shouldExposeOpenApiDocs(): boolean {
    return process.env.NODE_ENV !== 'production';
  }

  async initialize(): Promise<Express> {
    if (this.initialized) {
      return this.app!;
    }

    await this.registerPlatforms();

    this.app = express();

    this.setupMiddleware();

    await this.setupRoutes();

    this.initialized = true;

    this.app.platformFactory = platformFactory;
    this.app.lxSourceManager = this.lxSourceManager;

    this.app.lxSourceUpdateScheduler =
      createLxSourceUpdateScheduler(this.lxSourceManager);

    this.app.loginRefreshScheduler =
      createLoginRefreshScheduler({
        registry: this.accountSessions,
        platformFactory,
        accountStore: this.accountStore
      });

    this.logger.compact(
      'info',
      'Multi-platform music server initialized',
      'debug'
    );

    return this.app;
  }

  async registerPlatforms(): Promise<boolean> {
    try {
      this.logger.compact(
        'platform',
        'Registering platform adapters...',
        'debug'
      );

      platformFactory.register(
        'netease',
        NeteasePlatform,
        { name: 'netease' }
      );

      platformFactory.register(
        'qqmusic',
        QQMusicPlatform,
        { name: 'qqmusic' }
      );

      await platformFactory.initialize();

      const platformCount: number =
        platformFactory.getAvailablePlatforms().length;

      this.logger.compact(
        'platform',
        `Platform registration completed (${platformCount} platforms loaded)`,
        'debug'
      );

      return true;
    } catch (error) {
      this.logger.error('Platform registration failed', error);
      throw error;
    }
  }

  setupMiddleware(): void {
    const { CORS_ALLOW_ORIGIN } = process.env;

    this.app!.set('trust proxy', true);

    this.app!.use(cookieParser());

    if (this.serveStatic) {
      this.app!.use(
        express.static(path.join(__dirname, '..', 'public'))
      );
    }

    // GitHub 帳號還原已在 createApp() 中先完成。
    // 這裡才載入帳號 Session，避免還原後帳號沒有進入 Session。
    this.accountSessions = loadAccountSessions(this.accountStore);

    (this.accountSessions.onDeleted ??= new Set()).add(session => {
      clearAccountLoginRefresh(session.apiAccessKey);
      clearYTMusicTrackCache(session.cookie);
      clearYTMusicVisitorCache(session.cookie);

      require('../core/PlatformCache').globalCache.clear();
    });

    this.reconcileLxSources();

    this.app!.use((
      req: Request,
      res: Response,
      next: NextFunction
    ) => {
      const isDocsPath = req.path.startsWith('/docs');

      if (
        req.path !== '/' &&
        !req.path.includes('.') &&
        !(this.shouldExposeOpenApiDocs() && isDocsPath)
      ) {
        res.set({
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Origin':
            CORS_ALLOW_ORIGIN ||
            (req.headers.origin as string) ||
            '*',
          'Access-Control-Allow-Headers':
            'X-Requested-With,Content-Type,Authorization',
          'Access-Control-Allow-Methods':
            'POST,PUT,GET,OPTIONS',
          'Content-Type':
            'application/json; charset=utf-8'
        });
      }

      req.method === 'OPTIONS'
        ? res.status(204).end()
        : next();
    });

    this.app!.use(express.json({ limit: '5mb' }));

    this.app!.use(
      express.urlencoded({
        extended: false,
        limit: '5mb'
      })
    );
  }

  async setupRoutes(): Promise<void> {
    if (this.shouldExposeOpenApiDocs()) {
      this.app!.get(
        '/openapi.json',
        (_req: Request, res: Response) => {
          res.json(openApiDocument);
        }
      );
    }

    this.app!.use(
      '/app/api',
      createDashboardRouter({
        registry: this.accountSessions,
        cloudflare: this.cloudflare,
        adminManagementPassword: this.adminManagementPassword,
        accountStore: this.accountStore,
        onAccountsChanged: () => this.reconcileLxSources()
      })
    );

    this.app!.use(
      '/login',
      createLoginRouter({
        registry: this.accountSessions,
        platformFactory,
        accountStore: this.accountStore,
        allowAccountLxSources: !this.cloudflare,
        onAccountsChanged: () => this.reconcileLxSources()
      })
    );

    this.app!.use(
      '/v1',
      async (
        req: Request,
        _res: Response,
        next: NextFunction
      ) => {
        const key = extractAuthorizationToken(
          req.header('Authorization')
        );

        const session =
          this.accountSessions.byAccessKey.get(key);

        if (!session || session.platform !== 'qq') {
          return next();
        }

        try {
          await ensureQQLoginFresh(session, {
            registry: this.accountSessions,
            platformFactory,
            accountStore: this.accountStore,
            logger: this.logger
          });

          next();
        } catch (error) {
          this.logger.error(
            'QQ 登录状态检查或刷新失败，继续使用当前凭证',
            error
          );

          next();
        }
      }
    );

    this.app!.get(
      '/v1/ytmusic/audio/:id',
      async (
        req: Request,
        res: Response,
        next: NextFunction
      ) => {
        const verified = verifyStreamRequest(
          this.accountSessions.sessions,
          String(req.params.id),
          req.query
        );

        if (!verified) {
          res.status(403).json(
            Result.error('音频链接无效或已过期', 403)
          );
          return;
        }

        const controller = new AbortController();

        res.once('close', () => {
          if (!res.writableEnded) {
            controller.abort();
          }
        });

        try {
          const client = new YTMusicClient(
            verified.account.cookie
          );

          const audio = await client.getRawTrackUrl(
            String(req.params.id),
            verified.quality
          );

          const range = req.header('range');

          const rebaseRange =
            audio.format === 'm4a'
              ? rebaseMp4Range(range)
              : null;

          const headers: Record<string, string> = {
            'Accept-Encoding': 'identity'
          };

          if (rebaseRange) {
            headers.Range = rebaseRange.upstreamRange;
          } else if (
            range &&
            /^bytes=\d*-\d*$/.test(range)
          ) {
            headers.Range = range;
          }

          const upstream = await fetch(audio.url, {
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            headers,
            signal: controller.signal
          });

          if (
            !upstream.ok ||
            (req.method !== 'HEAD' && !upstream.body)
          ) {
            res.status(502).json(
              Result.error(
                `YouTube Music 音频请求失败 (${upstream.status})`,
                502
              )
            );
            return;
          }

          const isMp4Audio = audio.format === 'm4a';

          const upstreamRange =
            /^bytes 0-\d+\/(\d+)$/.exec(
              upstream.headers.get('content-range') || ''
            );

          const totalLength = upstreamRange
            ? Number(upstreamRange[1])
            : (
                upstream.status === 200
                  ? Number(upstream.headers.get('content-length'))
                  : NaN
              );

          if (
            rebaseRange &&
            (
              !Number.isSafeInteger(totalLength) ||
              totalLength <= 0 ||
              (upstream.status !== 200 && !upstreamRange)
            )
          ) {
            res.status(502).json(
              Result.error(
                'YouTube Music 音频范围响应无效',
                502
              )
            );
            return;
          }

          if (
            rebaseRange &&
            rebaseRange.start >= totalLength
          ) {
            res
              .status(416)
              .set('Content-Range', `bytes */${totalLength}`)
              .end();

            return;
          }

          const responseEnd = rebaseRange
            ? Math.min(
                rebaseRange.end ?? totalLength - 1,
                totalLength - 1
              )
            : 0;

          res.status(
            rebaseRange ? 206 : upstream.status
          );

          for (const key of [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges'
          ]) {
            const value = upstream.headers.get(key);

            if (value) {
              res.set(key, value);
            }
          }

          if (rebaseRange) {
            res.set(
              'Content-Range',
              `bytes ${rebaseRange.start}-${responseEnd}/${totalLength}`
            );

            res.set(
              'Content-Length',
              String(responseEnd - rebaseRange.start + 1)
            );
          }

          const lastModified =
            upstream.headers.get('last-modified');

          if (lastModified) {
            const parsed = Date.parse(lastModified);

            // 正規化後的 MP4 是新表示，讓 Aduoer 更新舊快取標頭。
            res.set(
              'Last-Modified',
              isMp4Audio && Number.isFinite(parsed)
                ? new Date(parsed + 1000).toUTCString()
                : lastModified
            );
          }

          const upstreamEtag =
            upstream.headers.get('etag');

          if (upstreamEtag) {
            res.set(
              'ETag',
              isMp4Audio
                ? `W/"ytm-mdhd-v1-${upstreamEtag.replace(/[^a-zA-Z0-9]/g, '')}"`
                : upstreamEtag
            );
          }

          res.set(
            'Cache-Control',
            'private, no-store'
          );

          if (req.method === 'HEAD') {
            res.end();
            return;
          }

          const handleStreamError = (error: Error) => {
            if (
              controller.signal.aborted &&
              error.name === 'AbortError'
            ) {
              return;
            }

            this.logger.error(
              'YouTube Music audio stream failed',
              error
            );

            if (!res.destroyed) {
              res.destroy(error);
            }
          };

          const source = Readable
            .fromWeb(upstream.body as any)
            .on('error', handleStreamError);

          const startsAtZero =
            upstream.status === 200 ||
            (
              upstream.status === 206 &&
              /^bytes 0-\d+\//.test(
                upstream.headers.get('content-range') || ''
              )
            );

          const output =
            startsAtZero && isMp4Audio
              ? source.pipe(
                  normalizeFragmentedMp4Stream()
                    .on('error', handleStreamError)
                )
              : source;

          if (rebaseRange) {
            output
              .pipe(
                sliceByteRange(
                  rebaseRange.start,
                  responseEnd + 1
                ).on('error', handleStreamError)
              )
              .pipe(res);
          } else {
            output.pipe(res);
          }
        } catch (error) {
          if (controller.signal.aborted || res.destroyed) {
            return;
          }

          if (!res.headersSent) {
            next(error);
          } else {
            res.destroy(error as Error);
          }
        }
      }
    );

    this.app!.use(
      createWowRouter({
        resolveContext: createWowContextResolver(
          this.accountSessions,
          this.lxSourceManager
        ),
        onError: (error, request) =>
          this.logger.error(
            'Wow v1 request failed',
            error,
            { url: request.url }
          )
      })
    );

    if (this.preload) {
      void preloadData(
        platformFactory,
        this.accountSessions,
        this.lxSourceManager
      ).catch((error) => {
        this.logger.error(
          'Background favorites preload failed',
          error
        );
      });
    }

    const resourceRoutes: string[] =
      platformFactory
        .getAvailableRoutes()
        .filter(
          (route: string) =>
            !INTERNAL_RESOURCE_ROUTES.has(route)
        );

    resourceRoutes.forEach((route: string) => {
      this.app!.all(
        `/${route}`,
        async (req: Request, res: Response) => {
          await this.handleResourceAPI(
            req,
            res,
            route
          );
        }
      );
    });

    this.app!.use(
      (_req: Request, res: Response) => {
        res.status(404).json(
          Result.error('API endpoint not found', 404)
        );
      }
    );

    this.app!.use(
      (
        error: Error,
        _req: Request,
        res: Response,
        _next: NextFunction
      ) => {
        this.logger.error(
          'Unhandled error',
          error,
          { url: _req.url }
        );

        if (error instanceof APIError) {
          res.status(error.status).json(
            Result.error(error.message, error.status)
          );
          return;
        }

        res.status(500).json(
          Result.error('Internal server error', 500)
        );
      }
    );
  }

  private reconcileLxSources(): void {
    this.lxSourceManager.reconcileAccountSources(
      this.accountSessions.sessions.map(
        (session) => session.lxSource
      )
    );
  }

  async handleResourceAPI(
    req: Request,
    res: Response,
    route: string
  ): Promise<void> {
    const startTime = Date.now();

    try {
      if (req.cookies) {
        if (
          req.cookies.MUSIC_U &&
          !req.query.MUSIC_U
        ) {
          req.query.MUSIC_U = req.cookies.MUSIC_U;
        }

        if (
          req.cookies.uin &&
          !req.query.uin
        ) {
          req.query.uin = req.cookies.uin;
        }

        if (
          req.cookies.qm_keyst &&
          !req.query.qm_keyst
        ) {
          req.query.qm_keyst = req.cookies.qm_keyst;
        }
      }

      // 停用 QQ／網易雲官方播放 URL，避免落雪失敗後或舊版 API 再向官方音源請求。
      if (
        [
          'song_url',
          'song_url_v1',
          'song_url_xeapi'
        ].includes(route)
      ) {
        const disabledResult = Result.error(
          '官方播放源已停用；請使用 Aduoer Wow v1 落雪音源播放流程',
          503
        );

        res
          .status(disabledResult.code)
          .json(disabledResult);

        return;
      }

      const platformName =
        (req.query.platform as string) ||
        req.body?.platform ||
        'netease';

      const platform =
        platformFactory.getPlatform(platformName);

      const result = await platform.callModule(
        route,
        req
      );

      res.status(result.code).json(result);
    } catch (error) {
      const responseTime = Date.now() - startTime;

      this.logger.error(
        'API request failed',
        error,
        {
          route,
          platform:
            (req.query.platform as string) ||
            req.body?.platform ||
            'unknown',
          responseTime
        }
      );

      const errorResult = Result.error(error, 500);

      res
        .status(errorResult.code)
        .json(errorResult);
    }
  }

  stop(): void {
    if (this.app && this.app.server) {
      this.app.server.close();

      this.logger.info('Server stopped');
    }
  }
}

/** 建立並初始化 Express 應用；監聽埠由 server.ts 負責。 */
export interface CreateAppOptions {
  adminManagementPassword?: string;
  accountStore?: AccountStore;
  lxSourceManager?: AppLxSourceManager;
  cloudflare?: boolean;
  serveStatic?: boolean;
  preload?: boolean;
}

export interface AppLxSourceManager
  extends LxTrackUrlResolver,
    LxSourceLifecycle {
  reconcileAccountSources(
    sourceGroups: readonly (readonly string[])[]
  ): void;
}

function loadLocalAccountStore(): AccountStore {
  const localRequire = require;

  return localRequire('./storage').createLocalAccountStore();
}

function loadLocalLxSourceManager(): AppLxSourceManager {
  const localRequire = require;

  return localRequire('./lx-resource').createLxSourceManager();
}

/**
 * 建立應用程式。
 *
 * 啟動順序：
 * 1. 建立本機帳號資料庫。
 * 2. 從 GitHub 還原帳號。
 * 3. 初始化 Express。
 * 4. 載入 Account Sessions。
 * 5. 啟動 GitHub 定期備份。
 */
export async function createApp(
  options: CreateAppOptions = {}
): Promise<Express> {
  // 先建立帳號資料庫，確保 GitHub 備份模組使用同一個 Store。
  const accountStore =
    options.accountStore ?? loadLocalAccountStore();

  // 建立 GitHub 帳號備份服務。
  // 未設定必要環境變數時，會依模組設計停用備份。
  const accountBackup =
    createGitHubAccountBackup(accountStore);

  let backupRestored = false;

  if (accountBackup) {
    try {
      // 必須在 MultiPlatformServer 初始化前完成還原。
      // 因為 setupMiddleware() 會在初始化時載入 Account Sessions。
      await accountBackup.restore();

      backupRestored = true;

      console.info(
        '[account-backup] GitHub 帳號還原流程完成'
      );
    } catch (error) {
      // 還原失敗時不啟動同步，避免空資料覆蓋遠端備份。
      console.error(
        '[account-backup] GitHub 帳號還原失敗，暫停本次備份同步',
        error
      );
    }
  }

  // 將已建立的 Store 傳入 Server，避免建立第二個 Store。
  const app = await new MultiPlatformServer({
    ...options,
    accountStore
  }).initialize();

  // 只有還原流程成功，才開始定期同步。
  if (accountBackup && backupRestored) {
    accountBackup.start();

    console.info(
      '[account-backup] GitHub 帳號定期同步已啟動'
    );
  }

  return app;
}

export {
  MultiPlatformServer,
  platformFactory
};
