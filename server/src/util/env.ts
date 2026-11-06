/** Variables that would silently switch an agent from plan billing to API billing. */
export const BILLING_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const;
const isBillingKey = (key: string) => (BILLING_KEYS as readonly string[]).includes(key.toUpperCase());
const isPrivate = (key: string) => isBillingKey(key) ||
  ['JARVIS_ACCESS_TOKEN', 'TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'].includes(key.toUpperCase());

/**
 * Copy of the environment for a spawned agent with every API-key variable removed, so the
 * official CLIs always fall back to the saved plan login.
 */
export function sanitizedAgentEnv(source: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    // Jarvis's own secrets: the Gemini voice key is for the voice brain only, never for agents.
    if (isPrivate(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!isPrivate(k)) out[k] = v;
  }
  return out;
}

export function presentBillingKeys(source: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set(Object.entries(source).filter(([k, v]) => v && isBillingKey(k)).map(([k]) => k.toUpperCase()))];
}
