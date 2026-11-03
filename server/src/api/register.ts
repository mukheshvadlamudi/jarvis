import { registerWorkflowRoutes } from './workflows.ts';
import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { registerCollabRoutes } from './collab.ts';
import { registerConnectorRoutes } from './connectors.ts';
import { registerConversationRoutes } from './conversations.ts';
import { registerVoiceLiveRoutes } from '../voice/gemini.ts';
import { registerCoreRoutes } from './core.ts';
import { registerOutputRoutes } from './outputs.ts';
import { registerMcpRoutes } from './mcp.ts';
import { registerMemoryRoutes } from './memory.ts';
import { registerScheduleRoutes } from './schedules.ts';
import { registerSetupRoutes } from './setup.ts';
import { registerSkillsRoutes } from './skills.ts';
import { registerWorkspaceRoutes } from './workspaces.ts';

/** Each module adds exactly one line here, so parallel branches stay mergeable. */
export function registerRoutes(app: Hono, s: Services): void {
  registerCoreRoutes(app, s);
  registerWorkflowRoutes(app, s);
  registerMemoryRoutes(app, s);
  registerSkillsRoutes(app, s);
  registerMcpRoutes(app, s);
  registerScheduleRoutes(app, s);
  registerWorkspaceRoutes(app, s);
  registerSetupRoutes(app, s);
  registerCollabRoutes(app, s);
  registerOutputRoutes(app, s);
  registerConversationRoutes(app, s);
  registerConnectorRoutes(app, s);
  registerVoiceLiveRoutes(app, s);
}
