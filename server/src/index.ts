import type { CronLockPlugin } from './types';
import register from './register';
import destroy from './destroy';
import config from './config';
import services from './services';

export { createDbDriver, createRedisDriver } from './drivers';
export { withLock } from './wrap';
export { OWNER_ID } from './owner';
export type {
  LockDriver,
  LockService,
  CronLockConfig,
  CronLockJobExtras,
  CronLockPlugin,
  ErrorContext,
  StrapiContext,
  WrapStats,
} from './types';

const plugin: CronLockPlugin = {
  register,
  destroy,
  config,
  services,
};

export default plugin;
