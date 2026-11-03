/** Variables that would silently switch an agent from plan billing to API billing. */
export const BILLING_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'] as const;

/**
 * Copy of the environment for a spawned agent with every API-key variable removed, so the
 * official CLIs always fall back to the saved plan login.
 */
export function sanitizedAgentEnv(source: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if ((BILLING_KEYS as readonly string[]).includes(k)) continue;
    // Jarvis's own secrets: the Gemini voice key is for the voice brain only, never for agents.
    if (k.startsWith('JARVIS_ACCESS_TOKEN') || k === 'TELEGRAM_BOT_TOKEN' || k === 'GEMINI_API_KEY' || k === 'GOOGLE_API_KEY') continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!(BILLING_KEYS as readonly string[]).includes(k)) out[k] = v;
  }
  return out;
}

export function presentBillingKeys(source: NodeJS.ProcessEnv = process.env): string[] {
  return BILLING_KEYS.filter((k) => typeof source[k] === 'string' && source[k] !== '');
}
