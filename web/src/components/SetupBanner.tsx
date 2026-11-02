import { PlugZap, X } from 'lucide-react';
import { post } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Link } from './ui.tsx';

/** Home nudge until the required setup steps are done (dismissible). */
export function SetupBanner() {
  const res = useApi<{ progress: { done: number; total: number }; complete: boolean; dismissed: boolean }>('/api/setup', ['project.*']);
  const d = res.data;
  if (!d || d.complete || d.dismissed) return null;
  return (
    <div className="setup-banner" role="status">
      <PlugZap size={16} strokeWidth={1.5} color="var(--text-muted)" />
      <span style={{ flex: 1, minWidth: 180 }}>
        Finish connecting Jarvis <span className="faint">·</span> {d.progress.done} of {d.progress.total} required steps done
      </span>
      <Link to="/setup" className="btn sm">
        Continue setup
      </Link>
      <button
        className="btn ghost sm icon"
        aria-label="Hide setup reminder"
        onClick={async () => {
          await post('/api/setup/dismiss', { dismissed: true });
          res.reload();
        }}
      >
        <X size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}
