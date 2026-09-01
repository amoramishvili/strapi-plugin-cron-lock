/**
 * Example: config/cron-tasks.ts
 *
 * There is no locking code here. The plugin wraps each `task` at registration
 * time, so this file only describes what runs and when.
 *
 * Every job below demonstrates one thing. Replace them with your own.
 */
import type { Core } from '@strapi/strapi';

type Ctx = { strapi: Core.Strapi };

const MINUTE = 60 * 1000;

const TZ = process.env.CRON_TZ ?? 'UTC';
const withTz = (rule: string) => ({ rule, tz: TZ });

export default {
  /**
   * The plain case: nothing to configure. The job inherits `defaultTtl`
   * from config/plugins.ts.
   */
  cleanupExpiredTokens: {
    task: async ({ strapi }: Ctx) => {
      const cutoff = new Date().toISOString();

      const expired = await strapi.documents('api::token.token').findMany({
        filters: { expiresAt: { $lte: cutoff } },
      });

      for (const token of expired) {
        await strapi.documents('api::token.token').delete({
          documentId: token.documentId,
        });
      }

      strapi.log.info(`[cron] removed ${expired.length} expired token(s)`);
    },
    options: withTz('0 * * * *'), // hourly
  },

  /**
   * A long job. Give it a TTL comfortably above its worst-case run, or the
   * lock can expire mid-run and let another instance start a second copy.
   */
  syncExternalCatalog: {
    task: async ({ strapi }: Ctx) => {
      await strapi.service('api::catalog.catalog-sync').run();
      await strapi.service('api::search-index.search-index').rebuild();
    },
    options: withTz('30 1 * * *'), // 01:30
    lockTtl: 30 * MINUTE,
  },

  /**
   * Several independent sources. `Promise.allSettled` keeps one failure from
   * hiding the others' results, whether or not you lock.
   */
  fetchExchangeRates: {
    task: async ({ strapi }: Ctx) => {
      const sources = ['primary', 'fallback'] as const;

      const results = await Promise.allSettled([
        strapi.service('api::rate.primary-rate-fetch').run(),
        strapi.service('api::rate.fallback-rate-fetch').run(),
      ]);

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          strapi.log.error(
            `[cron] rate source "${sources[index]}" failed: ${result.reason}`
          );
        }
      });
    },
    options: withTz('10 0 * * *'), // 00:10
    lockTtl: 5 * MINUTE,
  },

  /**
   * The job that makes this plugin worth installing. Without a lock, three
   * instances send every subscriber three copies.
   */
  sendDailyDigest: {
    task: ({ strapi }: Ctx) => strapi.service('api::digest.digest').sendPending(),
    options: withTz('0 8 * * *'), // 08:00
    lockTtl: 15 * MINUTE,
  },

  /**
   * The exception: some jobs *should* run everywhere. Each instance reporting
   * its own health is the point, so opt out of locking.
   */
  reportInstanceHealth: {
    task: ({ strapi }: Ctx) => {
      strapi.log.info(`[cron] healthy, pid=${process.pid}`);
    },
    options: withTz('*/5 * * * *'),
    bypassLock: true,
  },
};
