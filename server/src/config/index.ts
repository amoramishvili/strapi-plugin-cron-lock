import type { CronLockConfig, PluginConfigDefinition } from '../types';

const defaults: CronLockConfig = {
  enabled: true,
  driver: 'db',
  table: 'cron_locks',
  redisUrl: undefined,
  keyPrefix: 'cron:lock:',
  customDriver: undefined,
  defaultTtl: 5 * 60 * 1000,
  failOpen: false,
  rethrow: false,
  onError: undefined,
};

/** Guards against SQL injection through the configurable table name. */
const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MIN_TTL_MS = 10_000;

const definition: PluginConfigDefinition = {
  default: defaults,

  validator(config: Partial<CronLockConfig>) {
    const { driver, table, defaultTtl, redisUrl, customDriver, onError } = config;

    if (driver !== undefined && !['db', 'redis', 'custom'].includes(driver)) {
      throw new Error(
        `[cron-lock] "driver" must be one of "db", "redis" or "custom", received "${driver}"`
      );
    }

    if (driver === 'redis' && !redisUrl) {
      throw new Error('[cron-lock] driver "redis" requires "redisUrl" to be set');
    }

    if (driver === 'custom' && !customDriver) {
      throw new Error('[cron-lock] driver "custom" requires "customDriver" to be set');
    }

    if (customDriver !== undefined) {
      for (const method of ['acquire', 'renew', 'release'] as const) {
        if (typeof (customDriver as any)[method] !== 'function') {
          throw new Error(`[cron-lock] "customDriver" is missing the ${method}() method`);
        }
      }
    }

    if (table !== undefined && !SAFE_TABLE_NAME.test(table)) {
      throw new Error(
        `[cron-lock] "table" must be a plain identifier, received "${table}"`
      );
    }

    if (defaultTtl !== undefined) {
      if (typeof defaultTtl !== 'number' || Number.isNaN(defaultTtl)) {
        throw new Error('[cron-lock] "defaultTtl" must be a number of milliseconds');
      }

      if (defaultTtl < MIN_TTL_MS) {
        throw new Error(
          `[cron-lock] "defaultTtl" must be at least ${MIN_TTL_MS}ms, received ${defaultTtl}. ` +
            'A very short TTL can expire mid-run and let a second instance start the same job.'
        );
      }
    }

    if (onError !== undefined && typeof onError !== 'function') {
      throw new Error('[cron-lock] "onError" must be a function');
    }
  },
};

export default definition;
