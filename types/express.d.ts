import { Server } from 'http';
import type { LoginRefreshScheduler } from '../src/loginRefresh';
import type { GitHubAccountBackup } from '../src/storage/github-backup';
import type {
  LxSourceLifecycle,
  LxTrackUrlResolver,
  LxSourceUpdateScheduler
} from '../src/lx-resource';

declare global {
  namespace Express {
    interface Application {
      server?: Server;
      platformFactory?: any;
      loginRefreshScheduler?: LoginRefreshScheduler;
      accountBackup?: GitHubAccountBackup;
      lxSourceManager?: LxSourceLifecycle & LxTrackUrlResolver;
      lxSourceUpdateScheduler?: LxSourceUpdateScheduler;
    }
  }
}

export {};
