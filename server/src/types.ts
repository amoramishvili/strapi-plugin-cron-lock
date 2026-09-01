import type { Core } from '@strapi/strapi';

/**
 * A lock backend. Both bundled drivers (`db`, `redis`) implement this, and you
 * can pass your own through the `customDriver` config option.
 */
export interface LockDriver {
  /**
   * Try to take the lock for `key`. MUST be atomic: when several processes call
   * this at the same moment, exactly one may receive `true`.
   *
   * @returns true if this process now holds the lock, false if someone else does.
   */
  acquire(key: string, ttlMs: number): Promise<boolean>;

  /**
   * Push the expiry of a lock we already hold further into the future.
   * MUST be a no-op if the lock is currently held by a different owner.
   */
  renew(key: string, ttlMs: number): Promise<void>;

  /**
   * Release a lock we hold.
   * MUST be a no-op if the lock is currently held by a different owner.
   */
  release(key: string): Promise<void>;

  /** Optional cleanup on Strapi shutdown (close connections, etc). */
  destroy?(): Promise<void>;
}

export interface ErrorContext {
  /** The cron job name, which is also the lock key. */
  key: string;
  /** Identifier of the process that was running the job. */
  owner: string;
  /** Where the failure happened. */
  phase: 'acquire' | 'task' | 'renew' | 'release';
}

export interface CronLockConfig {
  /** Turn locking off entirely. Jobs still run, just without a lock. */
  enabled: boolean;

  /** Which lock backend to use. */
  driver: 'db' | 'redis' | 'custom';

  /** `db` driver: table used to store locks. Created automatically. */
  table: string;

  /** `redis` driver: connection string, e.g. redis://localhost:6379 */
  redisUrl?: string;

  /** `redis` driver: prefix for lock keys. */
  keyPrefix: string;

  /** `custom` driver: your own LockDriver implementation. */
  customDriver?: LockDriver;

  /**
   * Lock TTL in ms, used when a job does not set its own `lockTtl`.
   * Should comfortably exceed the longest expected run.
   */
  defaultTtl: number;

  /**
   * What to do when the lock backend itself is unreachable.
   * false (default) — skip the tick, so a broken backend can never cause
   *   duplicate runs.
   * true — run the job anyway, accepting the risk of duplicates.
   */
  failOpen: boolean;

  /**
   * Re-throw errors from the job after logging them.
   * Off by default: an async throw from a cron task becomes an unhandled
   * rejection, which node-schedule's error listener does not catch.
   */
  rethrow: boolean;

  /** Called on any failure. Handy for Sentry and friends. */
  onError?: (error: unknown, context: ErrorContext) => void;
}

/**
 * Extra fields this plugin reads from a cron job definition. Strapi itself only
 * looks at `task` and `options`, so these are ignored by core.
 */
export interface CronLockJobExtras {
  /** Run this job on every instance, without a lock. */
  bypassLock?: boolean;
  /** Lock TTL for this job in ms. Overrides `defaultTtl`. */
  lockTtl?: number;
}

/* ------------------------------------------------------------------------- */
/* Explicit shapes for the plugin's exports.                                  */
/*                                                                            */
/* Under pnpm, @strapi/types lives at an unnameable path inside .pnpm/, so    */
/* TypeScript cannot write it into a generated .d.ts and fails with TS2742    */
/* whenever an exported value's type is inferred. Annotating every export     */
/* explicitly keeps the emitted declarations pointing at names that resolve   */
/* from the package root.                                                     */
/* ------------------------------------------------------------------------- */

/** The `{ strapi }` argument Strapi passes to lifecycles and service factories. */
export interface StrapiContext {
  strapi: Core.Strapi;
}

/** Which jobs received a lock at startup, and which did not. */
export interface WrapStats {
  wrapped: string[];
  skipped: string[];
}

/** Public surface of the `lock` service. */
export interface LockService {
  run<T>(key: string, fn: () => Promise<T> | T, ttlMs?: number): Promise<T | undefined>;
  running(): string[];
  stats(): WrapStats;
  driver(): LockDriver | null;
}

/** Shape Strapi expects from a plugin's `config` export. */
export interface PluginConfigDefinition {
  default: CronLockConfig;
  validator: (config: Partial<CronLockConfig>) => void;
}

/** Shape of this plugin's `strapi-server` default export. */
export interface CronLockPlugin {
  register: (context: StrapiContext) => void;
  destroy: (context: StrapiContext) => Promise<void>;
  config: PluginConfigDefinition;
  services: {
    lock: (context: StrapiContext) => LockService;
  };
}
