import type { LockDriver, WrapStats } from './types';

/**
 * The active driver, shared between register(), the service layer and
 * destroy(). Strapi loads a plugin once per process, so module scope is the
 * natural place for it.
 */
let driver: LockDriver | null = null;

export const setDriver = (next: LockDriver | null): void => {
  driver = next;
};

export const getDriver = (): LockDriver | null => driver;

const stats: WrapStats = { wrapped: [], skipped: [] };

export const recordWrapped = (key: string): void => {
  stats.wrapped.push(key);
};

export const recordSkipped = (key: string): void => {
  stats.skipped.push(key);
};

export const getStats = (): WrapStats => ({
  wrapped: [...stats.wrapped],
  skipped: [...stats.skipped],
});

export const resetState = (): void => {
  driver = null;
  stats.wrapped = [];
  stats.skipped = [];
};
