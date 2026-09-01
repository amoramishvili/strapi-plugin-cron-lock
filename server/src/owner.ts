import { randomUUID } from 'node:crypto';

/**
 * Identifies this process to the lock backend.
 *
 * Two Strapi processes must never share this value, or one could release or
 * renew a lock the other one holds. HOSTNAME alone is not enough: in a
 * container two workers share a hostname, and locally you may run two
 * instances on the same machine. The pid narrows it further and the random
 * suffix covers pid reuse after a restart.
 */
export const OWNER_ID = [
  process.env.HOSTNAME || 'local',
  process.pid,
  randomUUID().slice(0, 8),
].join('-');
