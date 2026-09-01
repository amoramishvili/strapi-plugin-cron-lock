import type { Core } from '@strapi/strapi';
import type { CronLockConfig, LockDriver } from '../types';
import { createDbDriver } from './db';
import { createRedisDriver } from './redis';

export { createDbDriver, createRedisDriver };

export function createDriver(strapi: Core.Strapi, config: CronLockConfig): LockDriver {
  switch (config.driver) {
    case 'redis':
      return createRedisDriver(config.redisUrl as string, config.keyPrefix);

    case 'custom':
      return config.customDriver as LockDriver;

    case 'db':
    default:
      return createDbDriver(strapi, config.table);
  }
}
