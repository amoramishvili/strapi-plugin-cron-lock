# Changelog

## 1.0.0

Initial release.

- Distributed locking for every Strapi 5 cron job, with no changes to task code
- `db` driver (no extra infrastructure) and `redis` driver
- TTL with a heartbeat, so a crashed instance frees its lock automatically
- Per-job `lockTtl` and `bypassLock`
- `failOpen`, `rethrow` and `onError` configuration
- `custom` driver for your own lock backend
- `lock` service for locking work outside of cron
- Portable declaration output: every export is explicitly annotated, so
  `declaration: true` builds cleanly under pnpm (TS2742)
