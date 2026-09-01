import type { LockDriver } from '../types';
import { OWNER_ID } from '../owner';

/**
 * Delete the key only if we still own it.
 *
 * A plain GET followed by DEL is not safe: the lock can expire between the two
 * commands and be picked up by another instance, whose lock we would then
 * delete. Lua runs atomically inside Redis, which closes that window.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Extend the TTL only if we still own the key. Same reasoning as above. */
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

/**
 * Lock driver backed by Redis.
 *
 * `SET key owner NX PX ttl` is a single atomic command, so exactly one caller
 * can win. Faster and simpler than the DB driver, at the cost of one more
 * service that has to be up.
 *
 * `ioredis` is an optional peer dependency and is imported lazily, so projects
 * on the `db` driver never need to install it.
 */
export function createRedisDriver(url: string, keyPrefix: string): LockDriver {
  let clientPromise: Promise<any> | null = null;

  const getClient = (): Promise<any> => {
    clientPromise ??= (async () => {
      let Redis: any;

      try {
        const mod: any = await import('ioredis');
        Redis = mod.default ?? mod;
      } catch {
        throw new Error(
          '[cron-lock] driver "redis" requires the optional peer dependency ' +
            '"ioredis". Install it with: npm install ioredis'
        );
      }

      return new Redis(url, {
        maxRetriesPerRequest: 2,
        // Connect on first command rather than at boot, so a Redis hiccup
        // cannot hold up Strapi's startup.
        lazyConnect: true,
      });
    })();

    return clientPromise;
  };

  const fullKey = (key: string) => `${keyPrefix}${key}`;

  return {
    async acquire(key, ttlMs) {
      const client = await getClient();
      const result = await client.set(fullKey(key), OWNER_ID, 'PX', ttlMs, 'NX');
      return result === 'OK';
    },

    async renew(key, ttlMs) {
      const client = await getClient();
      await client.eval(RENEW_SCRIPT, 1, fullKey(key), OWNER_ID, String(ttlMs));
    },

    async release(key) {
      const client = await getClient();
      await client.eval(RELEASE_SCRIPT, 1, fullKey(key), OWNER_ID);
    },

    async destroy() {
      if (!clientPromise) return;

      try {
        const client = await clientPromise;
        await client.quit();
      } catch {
        try {
          const client = await clientPromise;
          client.disconnect();
        } catch {
          // Already gone.
        }
      }
    },
  };
}
