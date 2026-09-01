import type { LockService, StrapiContext } from '../types';
import lock from './lock';

const services: { lock: (context: StrapiContext) => LockService } = {
  lock,
};

export default services;
