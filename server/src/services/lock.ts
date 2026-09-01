import type { CronLockConfig, LockService, StrapiContext, WrapStats } from '../types';
import type { LockDriver } from '../types';
import { getDriver, getStats } from '../state';
import { runningJobs, withLock } from '../wrap';

/**
 * Manual access to the same lock the cron wrapper uses.
 *
 * Useful for work that should happen once across the cluster but is not a cron
 * job, such as a one-off migration in bootstrap().
 *
 *   const lock = strapi.plugin('cron-lock').service('lock');
 *   await lock.run('seed-defaults', async () => { ... });
 */
const lock = ({ strapi }: StrapiContext): LockService => ({
  /**
   * Run `fn` if this instance can take the lock for `key`.
   * Returns whatever `fn` returns, or undefined when the lock was not obtained.
   */
  async run<T>(
    key: string,
    fn: () => Promise<T> | T,
    ttlMs?: number
  ): Promise<T | undefined> {
    const config = strapi.config.get('plugin::cron-lock') as CronLockConfig;
    const driver = getDriver();

    if (!driver) {
      strapi.log.warn(`[cron-lock] no driver available, running "${key}" without a lock`);
      return (await fn()) as T;
    }

    const wrapped = withLock(
      { strapi, driver, config },
      key,
      fn,
      ttlMs ?? config.defaultTtl
    );

    return (await wrapped()) as T | undefined;
  },

  /** Job names currently executing in this process. */
  running(): string[] {
    return runningJobs();
  },

  /** Which jobs got a lock at startup, and which did not. */
  stats(): WrapStats {
    return getStats();
  },

  /** The active driver, for tests or advanced use. */
  driver(): LockDriver | null {
    return getDriver();
  },
});

export default lock;
