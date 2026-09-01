import { describe, expect, it } from 'vitest';
import config from '../server/src/config';

const validate = (partial: Record<string, unknown>) =>
  config.validator({ ...config.default, ...partial } as any);

describe('config validator', () => {
  it('accepts the defaults', () => {
    expect(() => config.validator(config.default)).not.toThrow();
  });

  it('rejects an unknown driver', () => {
    expect(() => validate({ driver: 'memcached' })).toThrow(/driver/);
  });

  it('requires redisUrl for the redis driver', () => {
    expect(() => validate({ driver: 'redis' })).toThrow(/redisUrl/);
    expect(() =>
      validate({ driver: 'redis', redisUrl: 'redis://localhost:6379' })
    ).not.toThrow();
  });

  it('requires customDriver for the custom driver', () => {
    expect(() => validate({ driver: 'custom' })).toThrow(/customDriver/);
  });

  it('rejects a custom driver that is missing methods', () => {
    expect(() =>
      validate({ driver: 'custom', customDriver: { acquire: () => {} } })
    ).toThrow(/renew/);
  });

  it('rejects an unsafe table name', () => {
    expect(() => validate({ table: 'locks; DROP TABLE users' })).toThrow(/table/);
    expect(() => validate({ table: 'my_locks' })).not.toThrow();
  });

  it('rejects a dangerously short TTL', () => {
    expect(() => validate({ defaultTtl: 500 })).toThrow(/at least/);
  });

  it('rejects a non-function onError', () => {
    expect(() => validate({ onError: 'sentry' })).toThrow(/onError/);
  });
});
