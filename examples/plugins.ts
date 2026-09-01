/**
 * Example: config/plugins.ts
 */
export default ({ env }: { env: any }) => ({
  'cron-lock': {
    enabled: true,
    config: {
      // 'db' needs no extra infrastructure and fails at the same moment as the
      // database your jobs need anyway. Switch to 'redis' only if you already
      // run Redis.
      driver: env('CRON_LOCK_DRIVER', 'db'),
      redisUrl: env('REDIS_URL'),

      // Used by any job that does not set its own lockTtl.
      defaultTtl: 5 * 60 * 1000,

      // If the lock backend is unreachable: skip the tick rather than risk a
      // duplicate run. Flip to true for jobs that are idempotent and must not
      // be missed.
      failOpen: false,

      onError: (error: unknown, ctx: { key: string; phase: string }) => {
        // In a real project `strapi` is in scope here:
        // strapi.plugin('sentry')?.service('sentry')?.sendError(error);
        console.error(`[cron-lock] ${ctx.key} failed during ${ctx.phase}`, error);
      },
    },
  },
});
