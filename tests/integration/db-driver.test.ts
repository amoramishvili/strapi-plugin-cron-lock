import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import knexLib, { type Knex } from 'knex';
import { createDbDriver } from '../../server/src/drivers/db';

/**
 * These tests need a real database with row-level locking. SQLite serialises
 * every write, so it would pass without proving anything.
 *
 *   docker run -d --name cron-lock-pg -p 5433:5432 \
 *     -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=test postgres:16
 *
 *   TEST_DATABASE_URL=postgres://test:test@localhost:5433/test npm run test:integration
 */
const url = process.env.TEST_DATABASE_URL;
const client = process.env.TEST_DATABASE_CLIENT ?? 'pg';

const TABLE = 'cron_locks_test';

describe.skipIf(!url)('db driver', () => {
  let db: Knex;

  const strapiFor = (connection: Knex) =>
    ({
      db: { connection },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }) as any;

  beforeAll(async () => {
    db = knexLib({ client, connection: url, pool: { min: 10, max: 30 } });
    await db.schema.dropTableIfExists(TABLE);
  });

  afterAll(async () => {
    await db?.schema.dropTableIfExists(TABLE);
    await db?.destroy();
  });

  it('creates its table on first use', async () => {
    const driver = createDbDriver(strapiFor(db), TABLE);

    await driver.acquire('bootstrap', 60_000);
    expect(await db.schema.hasTable(TABLE)).toBe(true);

    await driver.release('bootstrap');
  });

  it('gives the lock to exactly one of many concurrent callers', async () => {
    const CONTENDERS = 25;

    // Each driver instance stands in for a separate pod. They deliberately
    // share one connection pool, which is warmed first so that opening
    // connections does not serialise the attempts and hide a race.
    await Promise.all(Array.from({ length: 30 }, () => db.raw('select 1')));

    const drivers = Array.from({ length: CONTENDERS }, () =>
      createDbDriver(strapiFor(db), TABLE)
    );

    const results = await Promise.all(
      drivers.map((driver) => driver.acquire('race', 60_000))
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a second acquire while the lock is held', async () => {
    const driver = createDbDriver(strapiFor(db), TABLE);

    expect(await driver.acquire('held', 60_000)).toBe(true);
    expect(await driver.acquire('held', 60_000)).toBe(false);

    await driver.release('held');
    expect(await driver.acquire('held', 60_000)).toBe(true);
    await driver.release('held');
  });

  it('lets another owner take over once the TTL has passed', async () => {
    const driver = createDbDriver(strapiFor(db), TABLE);

    // A crashed process leaves the row set but never releases it.
    expect(await driver.acquire('expiring', 1_000)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(await driver.acquire('expiring', 60_000)).toBe(true);
    await driver.release('expiring');
  });

  it('pushes the expiry forward on renew', async () => {
    const driver = createDbDriver(strapiFor(db), TABLE);

    await driver.acquire('renewed', 5_000);
    const before = await db(TABLE).where('lock_key', 'renewed').first();

    await new Promise((resolve) => setTimeout(resolve, 50));
    await driver.renew('renewed', 60_000);

    const after = await db(TABLE).where('lock_key', 'renewed').first();
    expect(Number(after.expires_at)).toBeGreaterThan(Number(before.expires_at));

    await driver.release('renewed');
  });
});
