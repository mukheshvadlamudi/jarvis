import { Mic, MicOff, Square, Volume2 } from 'lucide-react';
import { voice, useVoice } from '../voice/engine.ts';
import type { VoiceStatus } from '../voice/engine.ts';

const LABEL: Record<VoiceStatus, string> = {
  off: 'Voice off',
  loading: 'Waking up',
  idle: 'Ready',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Voice error',
};

/** Sidebar/More toggle. One click turns hands-free voice on; after that Jarvis speaks on its own. */
export function VoiceToggle({ compact }: { compact?: boolean }) {
  const v = useVoice();
  const on = v.status !== 'off' && v.status !== 'error';
  return (
    <button
      className={`btn ${on ? 'voice-on' : 'ghost'} ${compact ? 'sm' : ''}`}
      aria-pressed={on}
      title={on ? 'Turn hands-free voice off' : 'Turn hands-free voice on (Kokoro + Whisper, runs on this device)'}
      onClick={() => void (on ? voice.stop() : voice.start())}
    >
      {on ? <Mic size={14} strokeWidth={1.5} /> : <MicOff size={14} strokeWidth={1.5} />}
      {on ? 'Voice on' : 'Voice off'}
    </button>
  );
}

function Ring({ status, level }: { status: VoiceStatus; level: number }) {
  const active = status === 'hearing' || status === 'speaking';
  const scale = 1 + (status === 'hearing' ? Math.min(0.35, level * 0.35) : 0);
  return (
    <svg className={`voice-ring ${status}`} viewBox="0 0 40 40" aria-hidden>
      <circle cx="20" cy="20" r="17" fill="none" stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="2 4" className="voice-ring-outer" />
      <circle cx="20" cy="20" r="11" fill="none" stroke="var(--accent)" strokeWidth="2" opacity={active ? 1 : 0.55} style={{ transform: `scale(${scale})`, transformOrigin: '20px 20px', transition: 'transform 90ms linear' }} />
      <circle cx="20" cy="20" r="5" fill="var(--accent)" opacity={status === 'listening' || status === 'idle' ? 0.6 : 1} className={status === 'speaking' || status === 'thinking' ? 'voice-core-pulse' : undefined} />
    </svg>
  );
}

/** Floating HUD while voice is on: state, what it heard, what it said. */
export function VoiceDock() {
  const v = useVoice();
  if (v.status === 'off') return null;
  const loading = v.status === 'loading' || (v.progress.voice < 100 && v.progress.voice > 0) || (v.progress.ears < 100 && v.progress.ears > 0);
  const hint =
    v.needsGesture
      ? 'Click anywhere to let Jarvis use audio'
      : v.status === 'error'
        ? v.error
        : loading
          ? `Downloading voice models (first time only) · voice ${v.progress.voice}% · ears ${v.progress.ears}%`
          : v.status === 'listening'
            ? v.awaiting
              ? 'Go ahead — no need to say “Jarvis”'
              : v.prefs.wakeWord
                ? 'Say “Jarvis, …”'
                : 'Listening'
            : v.status === 'speaking'
              ? v.said
              : v.heard
                ? `“${v.heard}”`
                : '';
  return (
    <div className={`voice-dock ${v.status}`} role="status" aria-live="polite">
      <Ring status={v.status} level={v.level} />
      <div className="voice-text">
        <span className="voice-state">
          {LABEL[v.status]}
          {v.device ? <span className="faint"> · {v.device === 'webgpu' ? 'GPU' : 'CPU'}</span> : null}
        </span>
        {hint ? <span className="voice-hint">{hint}</span> : null}
      </div>
      {v.status === 'speaking' ? (
        <button className="btn ghost icon sm" aria-label="Stop speaking" title="Stop speaking (or just start talking)" onClick={() => voice.stopSpeaking()}>
          <Square size={14} strokeWidth={1.5} />
        </button>
      ) : (
        <button className="btn ghost icon sm" aria-label="Test voice" title="Say something" onClick={() => void voice.speak('Systems online. Say Jarvis, then what you need.')}>
          <Volume2 size={14} strokeWidth={1.5} />
        </button>
      )}
      <button className="btn ghost icon sm" aria-label="Turn voice off" title="Turn voice off" onClick={() => void voice.stop()}>
        <MicOff size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}
