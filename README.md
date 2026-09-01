# strapi-plugin-cron-lock

Distributed locking for Strapi 5 cron jobs.

Every Strapi instance starts its own scheduler, so a job scheduled for 01:00
runs on every pod at 01:00. Two pods means two sitemap rebuilds, two sync runs,
two newsletters. This plugin wraps each job in a lock so only one instance
actually does the work, and the rest skip that tick.

Your task code does not change. Install, add a few lines to `config/plugins.ts`,
and the jobs you already have are covered.

## Requirements

- Strapi `^5.0.0`
- Node.js `>= 18`
- A shared PostgreSQL or MySQL database (the default `db` driver), or Redis

SQLite works for local development but cannot coordinate separate processes in
any meaningful way. Do not rely on it in production.

## Install

```bash
npm install strapi-plugin-cron-lock
# only if you want the redis driver
npm install ioredis
```

```ts
// config/plugins.ts
export default ({ env }) => ({
  'cron-lock': {
    enabled: true,
    config: {
      driver: 'db',
    },
  },
});
```

Cron itself must be enabled, as usual:

```ts
// config/server.ts
import cronTasks from './cron-tasks';

export default ({ env }) => ({
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 1337),
  cron: {
    enabled: true,
    tasks: cronTasks,
  },
});
```

That is the whole setup. On boot you should see:

```
[cron-lock] active (driver=db)
[cron-lock] locking 4 job(s): cleanupExpiredTokens, syncExternalCatalog, sendDailyDigest, fetchExchangeRates | not locked: reportInstanceHealth
```

If it says `no cron jobs were wrapped`, see [Troubleshooting](#troubleshooting).

## Usage

Write cron tasks exactly as you normally would.

```ts
// config/cron-tasks.ts
import type { Core } from '@strapi/strapi';

type Ctx = { strapi: Core.Strapi };

const MINUTE = 60 * 1000;

export default {
  // Nothing to configure: inherits defaultTtl.
  cleanupExpiredTokens: {
    task: ({ strapi }: Ctx) => strapi.service('api::token.token').purgeExpired(),
    options: { rule: '0 * * * *', tz: 'UTC' },
  },

  // A long job needs a TTL above its worst-case run.
  syncExternalCatalog: {
    task: async ({ strapi }: Ctx) => {
      await strapi.service('api::catalog.catalog-sync').run();
      await strapi.service('api::search-index.search-index').rebuild();
    },
    options: { rule: '30 1 * * *', tz: 'UTC' },
    lockTtl: 30 * MINUTE,
  },

  // Some jobs should run everywhere. Opt out.
  reportInstanceHealth: {
    task: ({ strapi }: Ctx) => strapi.log.info(`healthy, pid=${process.pid}`),
    options: { rule: '*/5 * * * *' },
    bypassLock: true,
  },
};
```

A fuller set of examples, one per feature, lives in
[`examples/cron-tasks.ts`](./examples/cron-tasks.ts).

### Per-job options

| Field | Type | Description |
| --- | --- | --- |
| `lockTtl` | `number` | Lock TTL in ms for this job. Defaults to `defaultTtl`. |
| `bypassLock` | `boolean` | Skip locking; run on every instance. |

Strapi core reads only `task` and `options`, so these extra fields are inert
if you ever remove the plugin.

### Choosing a TTL

Set it comfortably above the longest run you expect. A heartbeat extends the
lock every `ttl / 3` while the job is running, so a generous TTL does not delay
recovery: if a process dies, its lock frees `ttl` after the last heartbeat, not
`ttl` after the job started.

### Locking work outside cron

```ts
// src/index.ts
export default {
  async bootstrap({ strapi }) {
    await strapi.plugin('cron-lock').service('lock').run('seed-defaults', async () => {
      // runs on exactly one instance
    });
  },
};
```

## Configuration

```ts
// config/plugins.ts
export default ({ env }) => ({
  'cron-lock': {
    enabled: true,
    config: {
      driver: env('CRON_LOCK_DRIVER', 'db'),   // 'db' | 'redis' | 'custom'
      table: 'cron_locks',                      // db driver
      redisUrl: env('REDIS_URL'),               // redis driver
      keyPrefix: 'cron:lock:',                  // redis driver
      defaultTtl: 5 * 60 * 1000,
      failOpen: false,
      rethrow: false,
      onError: (error, ctx) => {
        // ctx is { key, owner, phase }
        strapi.plugin('sentry')?.service('sentry')?.sendError(error);
      },
    },
  },
});
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Turn locking off without uninstalling. |
| `driver` | `'db'` | Lock backend. |
| `table` | `'cron_locks'` | Table used by the `db` driver. Created on first use. |
| `redisUrl` | – | Required by the `redis` driver. |
| `keyPrefix` | `'cron:lock:'` | Redis key prefix. |
| `customDriver` | – | Your own `LockDriver`. Required when `driver: 'custom'`. |
| `defaultTtl` | `300000` | Fallback TTL in ms. Minimum 10000. |
| `failOpen` | `false` | If the backend is unreachable: skip (`false`) or run anyway (`true`). |
| `rethrow` | `false` | Re-throw task errors after logging them. |
| `onError` | – | `(error, { key, owner, phase }) => void`. |

### `failOpen`

The default is to skip a tick when the lock backend cannot be reached, on the
grounds that a missed hourly run is usually cheaper than a duplicated one. If
your job is idempotent and must not be missed, set `failOpen: true`.

### `rethrow`

Off by default. An async throw inside a cron task becomes an unhandled
rejection, which `node-schedule`'s error listener does not catch. The plugin
logs the error and calls `onError` instead. Turn this on only if you have your
own handler for unhandled rejections.

## Which driver

**`db`** (default) needs nothing new. It creates one small table and takes the
lock with a single conditional `UPDATE`. Its best property is that it fails at
exactly the same moment as the database your jobs need anyway, so it adds no
new point of failure.

**`redis`** is faster and simpler internally (`SET NX PX` plus two Lua scripts
for owner-checked renew and release). Worth it if Redis is already part of your
stack. If it is not, running Redis solely for this is hard to justify.

Both are correct. Pick by what you already operate.

### Custom driver

```ts
import type { LockDriver } from 'strapi-plugin-cron-lock/strapi-server';

const myDriver: LockDriver = {
  async acquire(key, ttlMs) { /* must be atomic */ return true; },
  async renew(key, ttlMs) { /* no-op if we are not the owner */ },
  async release(key) { /* no-op if we are not the owner */ },
  async destroy() {},
};
```

`acquire` must be atomic: when several processes call it at the same instant,
exactly one may get `true`. `renew` and `release` must ignore locks held by a
different owner, or a slow instance will stomp on a fresh lock taken by another.

## How it works

The plugin patches `strapi.cron.add` during its `register()` lifecycle, which
runs before Strapi registers the jobs from `server.cron.tasks`. Each job's
`task` is replaced with a wrapper that:

1. checks an in-process set, so one instance never overlaps itself;
2. calls `driver.acquire(key, ttl)`, and returns early if another instance holds it;
3. starts a heartbeat that renews the lock every `ttl / 3`;
4. runs the original task **outside** the lock operation, not inside a transaction;
5. releases the lock in `finally`, whatever happened.

Two details matter. The lock is taken with one short atomic operation rather
than a read followed by a write, which is what makes concurrent callers safe.
And the task runs outside that operation, so a thirty-minute job does not hold a
database transaction open for thirty minutes.

### About the `db` driver's atomicity

`UPDATE ... WHERE expires_at < now` takes a row lock. When two instances issue
it against the same row, the second waits, then re-evaluates its `WHERE` clause
after the first commits, sees a future `expires_at`, and reports zero affected
rows. That is the whole mechanism.

## Troubleshooting

**`no cron jobs were wrapped`**

Either cron is off (`cron.enabled` in `config/server.ts`), or your jobs use the
key format. `{ '0 * * * *': fn }` gives the plugin no stable name to lock on;
switch to `{ myJob: { task, options } }`.

**`strapi.cron.add is unavailable on this Strapi version`**

`strapi.cron.add` is not part of Strapi's documented plugin API, so a future
release could move it. The plugin says so rather than silently leaving your jobs
unlocked. Please open an issue.

**Both instances log `started`**

Check they really share one backend. Run `strapi console` on each:

```js
strapi.config.get('plugin::cron-lock')
strapi.db.connection.client.config.connection   // db driver
await strapi.db.connection('cron_locks').select()
```

**A lock seems stuck**

```sql
SELECT lock_key, owner, expires_at - (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint AS ms_left
FROM cron_locks;
```

`ms_left` above zero on an idle job means an instance died between acquiring
and releasing. It clears itself once the TTL passes.

## Limitations

- **Clock skew.** Expiry is computed from each instance's `Date.now()`. Keep
  NTP running. Seconds of drift are harmless against multi-minute TTLs; minutes
  of drift are not.
- **Not a queue.** A skipped tick is skipped, not deferred. If you need retries,
  backoff, or job history, use BullMQ or an external scheduler.
- **Not a mutex for request handlers.** This locks scheduled work, not
  concurrent API requests.
- **Key format jobs cannot be locked.** See Troubleshooting.

## Troubleshooting the build

**`TS2742: The inferred type of default cannot be named without a reference to
.pnpm/@strapi+types@.../node_modules/@strapi/types/dist/core/strapi.js`**

`@strapi/types` reaches your project only through `@strapi/strapi`, and pnpm
keeps transitive packages inside `.pnpm/` at paths TypeScript cannot write into
a generated `.d.ts`. Declaration emit then fails on any export whose type was
inferred.

Two things in this repo already handle it, and both are worth copying if you
fork it:

- every `export default` is annotated with a local interface from
  `server/src/types.ts`, so the emitted declarations name only local types;
- `@strapi/types` is a direct devDependency and `.npmrc` hoists it.

If it still appears after `pnpm install`, delete `node_modules` and the
lockfile and install again — a lockfile from before the `.npmrc` was added
keeps the old layout.

## Development

```bash
npm install
npm test          # unit tests, no services needed
npm run typecheck
npm run build
```

Integration tests need a real database, since SQLite serialises writes and would
pass without proving anything:

```bash
docker run -d --name cron-lock-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test -e POSTGRES_DB=test postgres:16

TEST_DATABASE_URL=postgres://test:test@localhost:5433/test npm run test:integration
```

To try it against a real project, link it in with `npm run watch:link` and
follow the printed instructions.

### Testing multi-instance behaviour by hand

```bash
npm run build
PORT=1337 npm run start &
PORT=1338 npm run start &
```

Temporarily add a probe job. Ninety seconds against a one-minute rule exercises
both guards at once:

```ts
lockProbe: {
  task: async ({ strapi }) => {
    const at = new Date().toISOString();
    strapi.log.info(`>>> PROBE START ${at} pid=${process.pid}`);
    await new Promise((resolve) => setTimeout(resolve, 90_000));
    strapi.log.info(`<<< PROBE END   ${at} pid=${process.pid}`);
  },
  options: { rule: '* * * * *' },
  lockTtl: 2 * 60 * 1000,
},
```

Three messages, three different guards:

| Log line | What it proves |
| --- | --- |
| `held by another instance` | the distributed lock |
| `still running in this instance` | the in-process overlap guard |
| one `PROBE START` per 90s window | the two working together |

Remove the probe afterwards, and delete its row: releasing a lock blanks the
owner, it does not drop the row.

```sql
DELETE FROM cron_locks WHERE lock_key = 'lockProbe';
```

## Contributing

Issues and pull requests welcome. Please add a test for any behaviour change;
`tests/wrap.test.ts` covers the wrapper and needs no services to run.

## License

MIT
