/**
 * Short-lived Claude Code session that never sends a prompt: it only asks the CLI for facts the
 * Agent SDK exposes as control requests (model list, real plan usage, MCP connector status).
 * No model is called, so it costs nothing from the plan. Coded against the shipped sdk.d.ts.
 */
import type { McpServerStatus, ModelInfo, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { sanitizedAgentEnv } from '../util/env.ts';

export interface ClaudeUsageWindows {
  five_hour: { utilization: number | null; resets_at: string | null } | null;
  weekly: { utilization: number | null; resets_at: string | null } | null;
  subscription: string | null;
}

export interface ClaudeProbeResult {
  models?: ModelInfo[];
  usage?: ClaudeUsageWindows | null;
  mcp?: McpServerStatus[];
  errors: string[];
}

interface ProbeQuery {
  supportedModels(): Promise<ModelInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<{
    subscription_type: string | null;
    rate_limits_available: boolean;
    rate_limits: {
      five_hour?: { utilization: number | null; resets_at: string | null } | null;
      seven_day?: { utilization: number | null; resets_at: string | null } | null;
    } | null;
  }>;
  close(): void;
}
export type ProbeQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ProbeQuery;

async function loadQuery(): Promise<ProbeQueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as unknown as ProbeQueryFn;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

/** Ask Claude Code for the requested facts. Never throws: failures land in `errors`. */
export async function probeClaude(
  want: { models?: boolean; usage?: boolean; mcp?: boolean },
  deps: { queryFn?: ProbeQueryFn; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ClaudeProbeResult> {
  const out: ClaudeProbeResult = { errors: [] };
  const abort = new AbortController();
  let release: () => void = () => undefined;
  const idle = new Promise<void>((r) => (release = r));
  // A prompt stream that never yields keeps the session open without calling the model.
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
    await idle;
  }
  let q: ProbeQuery | null = null;
  try {
    const queryFn = deps.queryFn ?? (await loadQuery());
    q = queryFn({
      prompt: noPrompt(),
      options: {
        cwd: homedir(),
        abortController: abort,
        settingSources: ['user'],
        env: sanitizedAgentEnv(deps.env ?? process.env, { CLAUDE_AGENT_SDK_CLIENT_APP: 'jarvis/0.1' }),
      },
    });
    const ms = deps.timeoutMs ?? 30_000;
    if (want.models) {
      try {
        out.models = await withTimeout(q.supportedModels(), ms, 'model list');
      } catch (err) {
        out.errors.push(`models: ${(err as Error).message}`);
      }
    }
    if (want.usage) {
      try {
        const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.bind(q);
        if (!fn) throw new Error('this Claude Code version does not report usage');
        const u = await withTimeout(fn({ skipBehaviors: true }), ms, 'usage');
        out.usage = u.rate_limits_available && u.rate_limits
          ? { five_hour: u.rate_limits.five_hour ?? null, weekly: u.rate_limits.seven_day ?? null, subscription: u.subscription_type }
          : null;
      } catch (err) {
        out.errors.push(`usage: ${(err as Error).message}`);
      }
    }
    if (want.mcp) {
      try {
        out.mcp = await withTimeout(q.mcpServerStatus(), Math.max(ms, 45_000), 'connector status');
      } catch (err) {
        out.errors.push(`connectors: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    out.errors.push((err as Error).message);
  } finally {
    release();
    abort.abort();
    try {
      q?.close();
    } catch {
      // already closed
    }
  }
  return out;
}
