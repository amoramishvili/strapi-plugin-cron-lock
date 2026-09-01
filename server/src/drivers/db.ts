import type { Core } from '@strapi/strapi';
import type { LockDriver } from '../types';
import { OWNER_ID } from '../owner';

/**
 * Lock driver backed by a single table in Strapi's own database.
 *
 * Needs no extra infrastructure, and it fails at the same time as the database
 * the jobs need anyway, so it adds no new point of failure.
 *
 * Atomicity comes from a single conditional UPDATE. Two instances issuing
 * `UPDATE ... WHERE expires_at < now` against the same row are serialised by
 * the row lock: the second one re-evaluates the WHERE clause after the first
 * commits, sees a future `expires_at`, and reports 0 affected rows.
 */
export function createDbDriver(strapi: Core.Strapi, table: string): LockDriver {
  const db = (strapi.db as any).connection;

  let tableReady: Promise<void> | null = null;

  const ensureTable = (): Promise<void> => {
    tableReady ??= (async () => {
      try {
        if (await db.schema.hasTable(table)) return;

        await db.schema.createTable(table, (t: any) => {
          t.string('lock_key', 100).primary();
          t.string('owner', 200).notNullable().defaultTo('');
          t.bigInteger('expires_at').notNullable().defaultTo(0);
        });

        strapi.log.info(`[cron-lock] created table "${table}"`);
      } catch (error) {
        // Two instances booting together can both reach createTable. If the
        // table exists now, whoever lost the race is still fine.
        if (await db.schema.hasTable(table)) return;
        tableReady = null;
        throw error;
      }
    })();

    return tableReady;
  };

  const ensureRow = async (key: string): Promise<void> => {
    const existing = await db(table).where('lock_key', key).first();
    if (existing) return;

    try {
      await db(table).insert({ lock_key: key, owner: '', expires_at: 0 });
    } catch {
      // Lost the insert race against another instance. The row exists now,
      // which is all we needed.
    }
  };

  return {
    async acquire(key, ttlMs) {
      await ensureTable();
      await ensureRow(key);

      const now = Date.now();

      const affected = await db(table)
        .where('lock_key', key)
        .andWhere('expires_at', '<', now)
        .update({ owner: OWNER_ID, expires_at: now + ttlMs });

      return Number(affected) > 0;
    },

    async renew(key, ttlMs) {
      await db(table)
        .where({ lock_key: key, owner: OWNER_ID })
        .update({ expires_at: Date.now() + ttlMs });
    },

    async release(key) {
      await db(table)
        .where({ lock_key: key, owner: OWNER_ID })
        .update({ owner: '', expires_at: 0 });
    },
  };
}
