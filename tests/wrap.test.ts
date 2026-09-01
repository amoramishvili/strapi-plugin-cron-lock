import { describe, expect, it, vi } from 'vitest';
import { withLock } from '../server/src/wrap';
import type { CronLockConfig, LockDriver } from '../server/src/types';

const baseConfig: CronLockConfig = {
  enabled: true,
  driver: 'custom',
  table: 'cron_locks',
  keyPrefix: 'cron:lock:',
  defaultTtl: 60_000,
  failOpen: false,
  rethrow: false,
};

const fakeStrapi = () =>
  ({
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }) as any;

/** Grants the lock to whoever asks first and refuses everyone else. */
const singleWinnerDriver = (): LockDriver & { held: string | null } => {
  const state = {
    held: null as string | null,
    async acquire(key: string) {
      if (state.held === key) return false;
      state.held = key;
      return true;
    },
    async renew() {},
    async release(key: string) {
      if (state.held === key) state.held = null;
    },
  };

  return state;
};

const alwaysFreeDriver = (): LockDriver => ({
  acquire: async () => true,
  renew: async () => {},
  release: async () => {},
});

const alwaysHeldDriver = (): LockDriver => ({
  acquire: async () => false,
  renew: async () => {},
  release: async () => {},
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('withLock', () => {
  it('runs the task when the lock is free', async () => {
    const strapi = fakeStrapi();
    const driver = alwaysFreeDriver();
    const task = vi.fn(async () => 'done');

    const wrapped = withLock({ strapi, driver, config: baseConfig }, 'job', task, 60_000);

    await expect(wrapped()).resolves.toBe('done');
    expect(task).toHaveBeenCalledOnce();
  });

  it('skips the task when another instance holds the lock', async () => {
    const strapi = fakeStrapi();
    const driver = alwaysHeldDriver();
    const task = vi.fn();

    const wrapped = withLock({ strapi, driver, config: baseConfig }, 'job', task, 60_000);

    await expect(wrapped()).resolves.toBeUndefined();
    expect(task).not.toHaveBeenCalled();
  });

  it('releases the lock after a successful run', async () => {
    const strapi = fakeStrapi();
    const driver = singleWinnerDriver();
    const task = vi.fn(async () => {});

    const wrapped = withLock({ strapi, driver, config: baseConfig }, 'job', task, 60_000);

    await wrapped();
    expect(driver.held).toBeNull();

    await wrapped();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('releases the lock after a failing run', async () => {
    const strapi = fakeStrapi();
    const driver = singleWinnerDriver();
    const task = vi.fn(async () => {
      throw new Error('boom');
    });

    const wrapped = withLock({ strapi, driver, config: baseConfig }, 'job', task, 60_000);

    await expect(wrapped()).resolves.toBeUndefined();
    expect(driver.held).toBeNull();
    expect(strapi.log.error).toHaveBeenCalled();
  });

  it('releases the lock when the task throws synchronously', async () => {
    const strapi = fakeStrapi();
    const driver = singleWinnerDriver();
    const task = () => {
      throw new Error('sync boom');
    };

    const wrapped = withLock({ strapi, driver, config: baseConfig }, 'job', task, 60_000);

    await expect(wrapped()).resolves.toBeUndefined();
    expect(driver.held).toBeNull();
  });

  it('rethrows when configured to', async () => {
    const strapi = fakeStrapi();
    const driver = alwaysFreeDriver();
    const config = { ...baseConfig, rethrow: true };
    const task = async () => {
      throw new Error('boom');
    };

    const wrapped = withLock({ strapi, driver, config }, 'job', task, 60_000);

    await expect(wrapped()).rejects.toThrow('boom');
  });

  it('does not start a second run while the first is still going', async () => {
    const strapi = fakeStrapi();
    const driver = alwaysFreeDriver();
    const gate = deferred();
    const task = vi.fn(async () => {
      await gate.promise;
    });

    const wrapped = withLock({ strapi, driver, config: baseConfig }, 'overlap', task, 60_000);

    const first = wrapped();
    await wrapped(); // second tick arrives while the first is in flight

    expect(task).toHaveBeenCalledOnce();

    gate.resolve();
    await first;
  });

  it('skips the tick when the lock backend is unreachable', async () => {
    const strapi = fakeStrapi();
    const driver: LockDriver = {
      acquire: async () => {
        throw new Error('ECONNREFUSED');
      },
      renew: async () => {},
      release: async () => {},
    };
    const task = vi.fn();

    const wrapped = withLock({ strapi, driver, config: baseConfig }, 'job', task, 60_000);

    await wrapped();
    expect(task).not.toHaveBeenCalled();
  });

  it('runs anyway when failOpen is enabled and the backend is down', async () => {
    const strapi = fakeStrapi();
    const driver: LockDriver = {
      acquire: async () => {
        throw new Error('ECONNREFUSED');
      },
      renew: async () => {},
      release: async () => {},
    };
    const task = vi.fn(async () => 'ran');
    const config = { ...baseConfig, failOpen: true };

    const wrapped = withLock({ strapi, driver, config }, 'job', task, 60_000);

    await expect(wrapped()).resolves.toBe('ran');
  });

  it('reports failures through onError with the phase', async () => {
    const strapi = fakeStrapi();
    const driver = alwaysFreeDriver();
    const onError = vi.fn();
    const config = { ...baseConfig, onError };
    const task = async () => {
      throw new Error('boom');
    };

    const wrapped = withLock({ strapi, driver, config }, 'job', task, 60_000);
    await wrapped();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][1]).toMatchObject({ key: 'job', phase: 'task' });
  });

  it('renews the lock while a long task runs', async () => {
    vi.useFakeTimers();

    try {
      const strapi = fakeStrapi();
      const renew = vi.fn(async () => {});
      const driver: LockDriver = {
        acquire: async () => true,
        renew,
        release: async () => {},
      };

      const gate = deferred();
      const wrapped = withLock(
        { strapi, driver, config: baseConfig },
        'slow',
        () => gate.promise,
        30_000 // heartbeat every 10s (the floor)
      );

      const running = wrapped();
      await vi.advanceTimersByTimeAsync(25_000);

      expect(renew).toHaveBeenCalledTimes(2);

      gate.resolve();
      await running;
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes every argument through to the task', async () => {
    const strapi = fakeStrapi();
    const driver = alwaysFreeDriver();
    const task = vi.fn(async () => {});

    const wrapped = withLock({ strapi, driver, config: baseConfig }, 'job', task, 60_000);
    const ctx = { strapi };
    const fireDate = new Date();

    await wrapped(ctx as any, fireDate as any);

    expect(task).toHaveBeenCalledWith(ctx, fireDate);
  });
});
