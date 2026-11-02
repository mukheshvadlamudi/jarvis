import { useApi } from '../lib/hooks.ts';
import type { UsageState } from '../lib/types.ts';
import { AgentBadge, Skeleton, UsageBar } from './ui.tsx';

export interface UsageResponse {
  current: UsageState;
  fallbackAtPercent: number;
  softCaps: { fiveHourTokens: number; weeklyTokens: number };
  daily: Array<{ date: string; claude: number; codex: number }>;
  byType: Array<{ type: string; claude: number; codex: number; runs: number }>;
  routing: Array<{ run_id: string; task_id: string; title: string; type: string; agent: string; route_reason: string | null; started_at: string; status: string; tokens: number }>;
  history: { claude: Array<{ ts: string; used_percent: number }>; codex: Array<{ ts: string; used_percent: number }> };
  totals: { runs: number; tokens: number; toolCalls: number };
}

export function UsageMeters({ data }: { data?: UsageResponse | null }) {
  const own = useApi<UsageResponse>(data === undefined ? '/api/usage?days=1' : null, ['usage.updated', 'run.finished']);
  const d = data ?? own.data;
  if (!d) {
    return (
      <div className="meter-group" aria-busy="true">
        {[0, 1].map((i) => (
          <div className="meter-agent" key={i}>
            <Skeleton w={60} h={10} />
            <Skeleton h={4} />
            <Skeleton h={4} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="meter-group">
      {(['claude', 'codex'] as const).map((agent) => (
        <div className="meter-agent" key={agent}>
          <AgentBadge agent={agent} />
          <UsageBar agent={agent} label="5 hours" w={d.current[agent].five_hour} threshold={d.fallbackAtPercent} />
          <UsageBar agent={agent} label="Weekly" w={d.current[agent].weekly} threshold={d.fallbackAtPercent} />
        </div>
      ))}
    </div>
  );
}
