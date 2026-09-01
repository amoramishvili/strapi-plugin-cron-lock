import type { StrapiContext } from './types';
import { getDriver, resetState } from './state';

const destroy = async ({ strapi }: StrapiContext): Promise<void> => {
  const driver = getDriver();

  try {
    await driver?.destroy?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    strapi.log.warn(`[cron-lock] driver cleanup failed: ${message}`);
  }

  resetState();
};

export default destroy;
