import type { CronLockConfig, CronLockJobExtras, StrapiContext } from './types';
import { createDriver } from './drivers';
import { withLock } from './wrap';
import { getStats, recordSkipped, recordWrapped, setDriver } from './state';

type CronJobDefinition = CronLockJobExtras & {
  task?: (...args: unknown[]) => unknown;
  options?: unknown;
};

/**
 * Wrap every cron job with a distributed lock.
 *
 * This runs in register() rather than bootstrap() because Strapi registers the
 * jobs from `server.cron.tasks` during its own bootstrap phase. Plugin
 * register() is guaranteed to happen first, so the patch is in place before any
 * job is added. Jobs added later from a bootstrap() or at runtime go through the
 * same patched function.
 */
const register = ({ strapi }: StrapiContext): void => {
  const config = strapi.config.get('plugin::cron-lock') as CronLockConfig;

  if (!config.enabled) {
    strapi.log.info('[cron-lock] disabled, cron jobs will run without a lock');
    return;
  }

  const cron = (strapi as any).cron;

  // strapi.cron.add is not part of the documented plugin API, so a future
  // Strapi release could move it. Say so loudly rather than silently leaving
  // every job unlocked.
  if (!cron || typeof cron.add !== 'function') {
    strapi.log.error(
      '[cron-lock] strapi.cron.add is unavailable on this Strapi version. ' +
        'Cron jobs will run WITHOUT locking. Please report this at ' +
        'https://github.com/amoramishvili/strapi-plugin-cron-lock/issues'
    );
    return;
  }

  const driver = createDriver(strapi, config);
  setDriver(driver);

  const deps = { strapi, driver, config };
  const originalAdd = cron.add.bind(cron);

  cron.add = (tasks: Record<string, CronJobDefinition | Function>) => {
    const patched: Record<string, unknown> = {};

    for (const [key, definition] of Object.entries(tasks ?? {})) {
      // Key format: { '0 * * * *': fn }. The key is the schedule, not a name,
      // so there is nothing stable to lock on across instances.
      if (typeof definition === 'function') {
        strapi.log.warn(
          `[cron-lock] job "${key}" uses the key format and cannot be locked. ` +
            'Switch to the object format ({ myJob: { task, options } }) to enable locking.'
        );
        recordSkipped(key);
        patched[key] = definition;
        continue;
      }

      if (!definition || typeof definition.task !== 'function') {
        recordSkipped(key);
        patched[key] = definition;
        continue;
      }

      if (definition.bypassLock === true) {
        strapi.log.debug(`[cron-lock] job "${key}" opted out via bypassLock`);
        recordSkipped(key);
        patched[key] = definition;
        continue;
      }

      const ttl = definition.lockTtl ?? config.defaultTtl;

      recordWrapped(key);
      patched[key] = {
        ...definition,
        task: withLock(deps, key, definition.task, ttl),
      };
    }

    return originalAdd(patched);
  };

  // cron.start() runs after every statically configured job is registered, so
  // it is the first moment a summary is meaningful.
  if (typeof cron.start === 'function') {
    const originalStart = cron.start.bind(cron);
    let reported = false;

    cron.start = (...args: unknown[]) => {
      if (!reported) {
        reported = true;
        const { wrapped, skipped } = getStats();

        if (wrapped.length === 0) {
          strapi.log.warn(
            '[cron-lock] no cron jobs were wrapped. Check that your jobs use the ' +
              'object format and are registered through config.server.cron.tasks.'
          );
        } else {
          strapi.log.info(
            `[cron-lock] locking ${wrapped.length} job(s): ${wrapped.join(', ')}` +
              (skipped.length ? ` | not locked: ${skipped.join(', ')}` : '')
          );
        }
      }

      return originalStart(...args);
    };
  }

  strapi.log.info(`[cron-lock] active (driver=${config.driver})`);
};

export default register;
