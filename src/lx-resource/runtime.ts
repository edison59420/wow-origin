
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import type {
  LxLogLevel,
  LxScriptInfo,
  LxWorkerInvocation,
  LxWorkerInitialization,
  LxPlatformCapability,
  LxQuality
} from './types';

type PendingInvocation = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

type RuntimeOptions = {
  script: string;
  sourceInfo: LxScriptInfo;
  initializationTimeoutMs?: number;
  onLog?: (level: LxLogLevel, message: string) => void;
  onExit?: (event: { code: number; expected: boolean }) => void;
};

type WorkerMessage = {
  type: string;
  requestId?: string;
  level?: LxLogLevel;
  message?: string;
  data?: unknown;
  value?: unknown;
  error?: string;
  hasRequestHandler?: boolean;
};

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;
const DEFAULT_INVOCATION_TIMEOUT_MS = 5_000;

const LX_QUALITIES: readonly LxQuality[] = [
  '128k',
  '320k',
  'flac',
  'flac24bit',
  'hires',
  'atmos',
  'master'
];

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeCapability(
  value: unknown
): LxPlatformCapability | undefined {
  if (!isRecord(value)) return undefined;

  if (value.type !== 'music') return undefined;

  if (
    !Array.isArray(value.actions) ||
    !value.actions.includes('musicUrl')
  ) {
    return undefined;
  }

  if (!Array.isArray(value.qualitys)) return undefined;

  const qualities = value.qualitys.filter(
    (quality: unknown): quality is LxQuality =>
      typeof quality === 'string' &&
      LX_QUALITIES.includes(quality as LxQuality)
  );

  if (qualities.length === 0) return undefined;

  return {
    actions: value.actions.filter(
      (action: unknown): action is string =>
        typeof action === 'string'
    ),
    qualities: [...new Set(qualities)]
  };
}

function normalizeInitialization(
  data: unknown,
  sourceInfo: LxScriptInfo,
  hasRequestHandler: boolean
): LxWorkerInitialization {
  if (!hasRequestHandler) {
    throw new Error('LX source has not registered a request handler');
  }

  if (!isRecord(data)) {
    throw new Error('Invalid LX initialization response');
  }

  if (data.status === false) {
    throw new Error(
      typeof data.message === 'string'
        ? data.message
        : 'LX source initialization failed'
    );
  }

  if (!isRecord(data.sources)) {
    throw new Error(
      'LX source initialization did not provide sources'
    );
  }

  const tx = normalizeCapability(data.sources.tx);
  const wy = normalizeCapability(data.sources.wy);

  if (!tx && !wy) {
    throw new Error('LX source does not support musicUrl');
  }

  const returnedInfo = isRecord(data.sourceInfo)
    ? data.sourceInfo
    : {};

  return {
    sourceInfo: {
      ...sourceInfo,
      ...returnedInfo
    },
    capabilities: {
      ...(tx ? { tx } : {}),
      ...(wy ? { wy } : {})
    }
  };
}

function createAbortError(): Error {
  const error = new Error('LX source invocation cancelled');
  error.name = 'AbortError';
  return error;
}

export class LxSourceRuntime {
  private readonly worker: Worker;

  private readonly pending = new Map<string, PendingInvocation>();

  private readonly initializationTimeoutMs: number;

  private readonly onLog?: RuntimeOptions['onLog'];

  private readonly onExit?: RuntimeOptions['onExit'];

  private readonly sourceInfo: LxScriptInfo;

  private initialization?: Promise<LxWorkerInitialization>;

  private initialized = false;

  private expectedExit = false;

  private stopped = false;

  private exited = false;

  constructor(options: RuntimeOptions) {
    this.sourceInfo = options.sourceInfo;

    this.initializationTimeoutMs =
      options.initializationTimeoutMs ??
      DEFAULT_INITIALIZATION_TIMEOUT_MS;

    this.onLog = options.onLog;
    this.onExit = options.onExit;

    this.worker = new Worker(
      path.join(__dirname, 'worker.js'),
      {
        workerData: {
          script: options.script,
          sourceInfo: options.sourceInfo
        }
      }
    );

    this.worker.on('message', (message: WorkerMessage) => {
      this.handleMessage(message);
    });

    this.worker.on('error', (error: Error) => {
      this.handleWorkerError(error);
    });

    this.worker.on('exit', (code: number) => {
      this.handleExit(code);
    });
  }

  get isStopped(): boolean {
    return this.stopped || this.exited;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  initialize(): Promise<LxWorkerInitialization> {
    if (this.initialization) {
      return this.initialization;
    }

    if (this.stopped || this.exited) {
      return Promise.reject(
        new Error('LX source worker has already stopped')
      );
    }

    this.initialization = new Promise<LxWorkerInitialization>(
      (resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          clearTimeout(timer);
          this.worker.off('message', messageListener);
          this.worker.off('exit', exitListener);
          this.worker.off('error', errorListener);
        };

        const finishResolve = (value: LxWorkerInitialization) => {
          if (settled) return;
          settled = true;
          cleanup();
          this.initialized = true;
          resolve(value);
        };

        const finishReject = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        const messageListener = (message: WorkerMessage) => {
          if (message.type === 'initialized') {
            try {
              const result = normalizeInitialization(
                message.data,
                this.sourceInfo,
                message.hasRequestHandler === true
              );

              finishResolve(result);
            } catch (error) {
              finishReject(
                error instanceof Error
                  ? error
                  : new Error(String(error))
              );

              void this.terminate();
            }

            return;
          }

          if (message.type === 'initializationError') {
            finishReject(
              new Error(
                message.error || 'LX source initialization failed'
              )
            );

            void this.terminate();
          }
        };

        const exitListener = (code: number) => {
          finishReject(
            new Error(
              `LX source worker exited before initialization (code ${code})`
            )
          );
        };

        const errorListener = (error: Error) => {
          finishReject(error);
        };

        const timer = setTimeout(() => {
          finishReject(
            new Error(
              `LX source initialization timeout after ${this.initializationTimeoutMs}ms`
            )
          );

          void this.terminate();
        }, this.initializationTimeoutMs);

        this.worker.on('message', messageListener);
        this.worker.once('exit', exitListener);
        this.worker.once('error', errorListener);
      }
    );

    return this.initialization;
  }

  invoke(
    invocation: LxWorkerInvocation,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.stopped || this.exited) {
      return Promise.reject(
        new Error('LX source worker is not available')
      );
    }

    if (!this.initialized) {
      return Promise.reject(
        new Error('LX source worker has not been initialized')
      );
    }

    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    const requestId = randomUUID();

    const timeoutMs =
      typeof invocation.timeoutMs === 'number' &&
      invocation.timeoutMs > 0
        ? invocation.timeoutMs
        : DEFAULT_INVOCATION_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const cleanup = (pending: PendingInvocation) => {
        clearTimeout(pending.timer);

        if (pending.signal && pending.abortHandler) {
          pending.signal.removeEventListener(
            'abort',
            pending.abortHandler
          );
        }
      };

      const cancel = (error: Error) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;

        this.pending.delete(requestId);
        cleanup(pending);

        try {
          this.worker.postMessage({
            type: 'cancel',
            requestId
          });
        } catch {
          // Worker may already have exited.
        }

        reject(error);
      };

      const timer = setTimeout(() => {
        cancel(
          new Error(
            `LX source request timeout after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      const pending: PendingInvocation = {
        resolve,
        reject,
        timer,
        signal
      };

      if (signal) {
        pending.abortHandler = () => {
          cancel(createAbortError());
        };

        signal.addEventListener(
          'abort',
          pending.abortHandler,
          { once: true }
        );
      }

      this.pending.set(requestId, pending);

      try {
        this.worker.postMessage({
          type: 'invoke',
          requestId,
          invocation: {
            source: invocation.source,
            quality: invocation.quality,
            musicInfo: invocation.musicInfo
          }
        });
      } catch (error) {
        this.pending.delete(requestId);
        cleanup(pending);

        reject(
          error instanceof Error
            ? error
            : new Error(String(error))
        );
      }
    });
  }

  async drainAndTerminate(): Promise<void> {
    if (this.stopped || this.exited) return;

    this.expectedExit = true;

    const drainTimeoutMs = 5_000;
    const start = Date.now();

    while (
      this.pending.size > 0 &&
      Date.now() - start < drainTimeoutMs
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }

    await this.terminate();
  }

  async terminate(): Promise<void> {
    if (this.stopped || this.exited) return;

    this.stopped = true;
    this.expectedExit = true;

    try {
      this.worker.postMessage({ type: 'stop' });
    } catch {
      // Worker may already have exited.
    }

    this.rejectPending(
      new Error('LX source worker has been terminated')
    );

    try {
      await this.worker.terminate();
    } catch {
      // Ignore termination errors.
    }
  }

  private handleMessage(message: WorkerMessage): void {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'log') {
      this.onLog?.(
        message.level ?? 'info',
        message.message ?? ''
      );
      return;
    }

    if (
      message.type === 'initialized' ||
      message.type === 'initializationError'
    ) {
      return;
    }

    if (message.type !== 'result' || !message.requestId) {
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;

    this.pending.delete(message.requestId);

    clearTimeout(pending.timer);

    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener(
        'abort',
        pending.abortHandler
      );
    }

    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.value);
    }
  }

  private handleWorkerError(error: Error): void {
    this.rejectPending(error);
  }

  private handleExit(code: number): void {
    if (this.exited) return;

    this.exited = true;
    this.stopped = true;

    this.rejectPending(
      new Error(`LX source worker exited with code ${code}`)
    );

    this.onExit?.({
      code,
      expected: this.expectedExit
    });
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);

      if (pending.signal && pending.abortHandler) {
        pending.signal.removeEventListener(
          'abort',
          pending.abortHandler
        );
      }

      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}
