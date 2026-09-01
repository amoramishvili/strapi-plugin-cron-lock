import type { Core } from '@strapi/strapi';
import type { CronLockConfig, LockDriver } from './types';
import { OWNER_ID } from './owner';

/**
 * Keys currently executing inside *this* process.
 *
 * The distributed lock stops other instances; this stops the same instance from
 * starting a second run when a job outlives its own interval. Checking it costs
 * nothing and avoids a pointless round trip to the lock backend.
 */
const inFlight = new Set<string>();

/** Exposed for the plugin's service API and for tests. */
export const runningJobs = (): string[] => [...inFlight];

const heartbeatInterval = (ttlMs: number): number =>
  Math.max(Math.floor(ttlMs / 3), 10_000);

const toMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface WithLockDeps {
  strapi: Core.Strapi;
  driver: LockDriver;
  config: CronLockConfig;
}

/**
 * Wrap a function so that only one instance runs it at a time.
 *
 * The lock is taken with a short atomic operation and the work happens outside
 * it. A heartbeat pushes the expiry forward while the job runs, so a TTL can be
 * short enough to recover quickly from a crashed process without cutting off a
 * job that is simply slow.
 */
export function withLock<TArgs extends unknown[]>(
  { strapi, driver, config }: WithLockDeps,
  key: string,
  fn: (...args: TArgs) => unknown,
  ttlMs: number
) {
  return async (...args: TArgs): Promise<unknown> => {
    if (inFlight.has(key)) {
      strapi.log.warn(
        `[cron-lock] "${key}" is still running in this instance, skipping this tick`
      );
      return undefined;
    }

    inFlight.add(key);

    let acquired = false;
    let heartbeat: NodeJS.Timeout | undefined;

    try {
      try {
        acquired = await driver.acquire(key, ttlMs);
      } catch (error) {
        strapi.log.error(
          `[cron-lock] could not reach the lock backend for "${key}": ${toMessage(error)}`
        );
        config.onError?.(error, { key, owner: OWNER_ID, phase: 'acquire' });

        if (!config.failOpen) return undefined;

        strapi.log.warn(`[cron-lock] failOpen is on, running "${key}" without a lock`);
      }

      if (!acquired && !config.failOpen) {
        strapi.log.info(
          `[cron-lock] "${key}" is held by another instance, skipping this tick`
        );
        return undefined;
      }

      if (acquired) {
        heartbeat = setInterval(() => {
          driver.renew(key, ttlMs).catch((error) => {
            strapi.log.warn(
              `[cron-lock] failed to renew the lock for "${key}": ${toMessage(error)}`
            );
            config.onError?.(error, { key, owner: OWNER_ID, phase: 'renew' });
          });
        }, heartbeatInterval(ttlMs));

        // Never hold the event loop open just for a heartbeat.
        heartbeat.unref?.();
      }

      const startedAt = Date.now();
      strapi.log.info(`[cron-lock] ${key} started (owner=${OWNER_ID})`);

      try {
        const result = await fn(...args);
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        strapi.log.info(`[cron-lock] ${key} finished in ${seconds}s`);
        return result;
      } catch (error) {
        strapi.log.error(`[cron-lock] ${key} failed: ${toMessage(error)}`);
        config.onError?.(error, { key, owner: OWNER_ID, phase: 'task' });
        if (config.rethrow) throw error;
        return undefined;
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);

      if (acquired) {
        try {
          await driver.release(key);
        } catch (error) {
          // Not fatal: the TTL will free the lock on its own.
          strapi.log.warn(
            `[cron-lock] failed to release the lock for "${key}": ${toMessage(error)}`
          );
          config.onError?.(error, { key, owner: OWNER_ID, phase: 'release' });
        }
      }

      inFlight.delete(key);
    }
  };
}
