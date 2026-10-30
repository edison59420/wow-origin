import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  LX_QUALITIES,
  type LxLogLevel,
  type LxPlatformCapability,
  type LxRuntimeExit,
  type LxScriptInfo,
  type LxSourceCapabilities,
  type LxWorkerInitialization,
  type LxWorkerInvocation
} from './types';

type RuntimeOptions = {
  script: string;
  sourceInfo: LxScriptInfo;
  initializationTimeoutMs?: number;
  onLog?: (level: LxLogLevel, message: string) => void;
  onExit?: (event: LxRuntimeExit) => void;
};

type PendingInvocation = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

function normalizeCapability(value: unknown): LxPlatformCapability | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as { type?: unknown; actions?: unknown; qualitys?: unknown };
  if (source.type !== 'music' || !Array.isArray(source.actions) || !source.actions.includes('musicUrl')) {
    return undefined;
  }
  if (!Array.isArray(source.qualitys)) return undefined;

  const rawQualities = source.qualitys;
  const qualities = LX_QUALITIES.filter((quality) => rawQualities.includes(quality));
  if (qualities.length === 0) return undefined;

  return {
    actions: source.actions.filter((action): action is string => typeof action === 'string'),
    qualities
  };
}

function normalizeInitialization(
  raw: unknown,
  hasRequestHandler: boolean,
  sourceInfo: LxScriptInfo
): LxWorkerInitialization {
  if (!hasRequestHandler) throw new Error('LX source did not register a request handler');
  if (!raw || typeof raw !== 'object') throw new Error('LX source inited payload is invalid');

  const info = raw as { status?: unknown; sources?: unknown };
  if (info.status === false) throw new Error('LX source reported initialization failure');
  if (!info.sources || typeof info.sources !== 'object') {
    throw new Error('LX source did not declare sources');
  }

  const sources = info.sources as Record<string, unknown>;
  const capabilities: LxSourceCapabilities = {
    tx: normalizeCapability(sources.tx),
    wy: normalizeCapability(sources.wy)
  };
  if (!capabilities.tx && !capabilities.wy) {
    throw new Error('LX source has no usable tx or wy capability');
  }

  const fallbackName = [sources.tx, sources.wy]
    .map((source) => source && typeof source === 'object'
      ? (source as { name?: unknown }).name
      : undefined)
    .find((name): name is string => typeof name === 'string' && Boolean(name.trim()));

  const resolvedSourceInfo = {
    ...sourceInfo,
    name: sourceInfo.name || fallbackName?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 64) || ''
  };

  return { sourceInfo: resolvedSourceInfo, capabilities };
}

export class LxSourceRuntime {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly initializationTimeoutMs: number;
  private readonly sourceInfo: LxScriptInfo;
  private readonly onLog?: RuntimeOptions['onLog'];
  private readonly onExit?: RuntimeOptions['onExit'];
  private initialization?: Promise<LxWorkerInitialization>;
  private expectedExit = false;
  private stopped = false;

  constructor(options: RuntimeOptions) {
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 10_000;
    this.sourceInfo = options.sourceInfo;
    this.onLog = options.onLog;
    this.onExit = options.onExit;
    this.worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: {
        script: options.script,
        sourceInfo: options.sourceInfo
      }
    });
  }

  /** Worker 是否仍存活，可用於防止註冊已退出的執行個體。 */
  get available(): boolean {
    return !this.stopped;
  }

  initialize(): Promise<LxWorkerInitialization> {
    if (this.initialization) return this.initialization;

    this.initialization = new Promise<LxWorkerInitialization>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`LX source initialization timed out after ${this.initializationTimeoutMs}ms`));
        void this.terminate();
      }, this.initializationTimeoutMs);
      timer.unref?.();

      const cleanup = () => {
        this.worker.off('message', onMessage);
        this.worker.off('error', onError);
        this.worker.off('exit', onExit);
      };

      const onMessage = (message: any) => {
        if (message?.type === 'initializationError') {
          clearTimeout(timer);
          cleanup();
          reject(new Error(String(message.error || 'LX source initialization failed')));
          void this.terminate();
          return;
        }
        if (message?.type !== 'initialized') return;

        clearTimeout(timer);
        cleanup();
        try {
          resolve(normalizeInitialization(message.data, message.hasRequestHandler === true, this.sourceInfo));
        } catch (error) {
          reject(error);
          void this.terminate();
        }
      };

      const onError = (error: Error) => {
        clearTimeout(timer);
        cleanup();
        reject(error);
      };

      const onExit = (code: number) => {
        clearTimeout(timer);
        cleanup();
        reject(new Error(`LX source worker exited during initialization with code ${code}`));
      };

      this.worker.on('message', onMessage);
      this.worker.once('error', onError);
      this.worker.once('exit', onExit);
    });

    this.worker.on('message', (message: any) => this.handleMessage(message));
    this.worker.on('error', (error) => this.handleExit({ expected: this.expectedExit, error }));
    this.worker.on('exit', (code) => {
      const error = code === 0 ? undefined : new Error(`LX source worker exited with code ${code}`);
      this.handleExit({ expected: this.expectedExit, error });
    });

    return this.initialization;
  }

  /**
   * 執行音源請求。提供 AbortSignal 時，管理器可在另一條音源先命中後
   * 立即取消本次請求；worker 會將 cancel 傳遞給 lx.request 的 AbortController。
   */
  invoke(invocation: LxWorkerInvocation, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error('LX source worker is unavailable'));
    if (signal?.aborted) return Promise.reject(new Error('LX source request aborted'));

    const requestId = randomUUID();

    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        const pending = this.takePending(requestId);
        if (!pending) return;
        try {
          this.worker.postMessage({ type: 'cancel', requestId });
        } catch {
          // Worker may already be gone.
        }
        pending.reject(new Error('LX source request aborted'));
      };

      const timer = setTimeout(() => {
        const pending = this.takePending(requestId);
        if (!pending) return;
        try {
          this.worker.postMessage({ type: 'cancel', requestId });
        } catch {
          // Worker may already be gone.
        }
        pending.reject(new Error(`LX source request timed out after ${invocation.timeoutMs}ms`));
      }, invocation.timeoutMs);
      timer.unref?.();

      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        signal,
        abortHandler
      });

      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
        if (signal.aborted) {
          abortHandler();
          return;
        }
      }

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
        const pending = this.takePending(requestId);
        pending?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async drainAndTerminate(timeoutMs: number = 3_000): Promise<void> {
    if (this.pending.size === 0) {
      await this.terminate();
      return;
    }

    await new Promise<void>((resolve) => {
      let poll: NodeJS.Timeout;
      const finish = () => {
        clearInterval(poll);
        resolve();
      };
      const deadline = setTimeout(finish, timeoutMs);
      deadline.unref?.();
      poll = setInterval(() => {
        if (this.pending.size !== 0) return;
        clearTimeout(deadline);
        finish();
      }, 25);
      poll.unref?.();
    });

    await this.terminate();
  }

  async terminate(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.expectedExit = true;

    try {
      this.worker.postMessage({ type: 'stop' });
    } catch {
      // Worker may already be gone.
    }

    await this.worker.terminate();
    this.rejectPending(new Error('LX source worker stopped'));
  }

  private takePending(requestId: string): PendingInvocation | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;

    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener('abort', pending.abortHandler);
    }
    return pending;
  }

  private handleMessage(message: any): void {
    if (message?.type === 'log') {
      this.onLog?.(message.level, String(message.message ?? ''));
      return;
    }
    if (message?.type !== 'result' || typeof message.requestId !== 'string') return;

    const pending = this.takePending(message.requestId);
    if (!pending) return;

    if (message.error) {
      pending.reject(new Error(String(message.error)));
    } else {
      pending.resolve(message.value);
    }
  }

  private handleExit(event: LxRuntimeExit): void {
    if (this.stopped && event.expected) return;
    this.stopped = true;
    this.rejectPending(event.error ?? new Error('LX source worker exited'));
    this.onExit?.(event);
  }

  private rejectPending(error: Error): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.takePending(requestId);
      pending?.reject(error);
    }
  }
}
