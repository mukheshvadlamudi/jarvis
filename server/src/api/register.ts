import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { registerCoreRoutes } from './core.ts';

/** Each module adds exactly one line here, so parallel branches stay mergeable. */
export function registerRoutes(app: Hono, s: Services): void {
  registerCoreRoutes(app, s);
}
