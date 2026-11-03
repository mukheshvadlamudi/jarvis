import { useRef, useState } from 'react';
import { ArrowUpRight, GripVertical, Mic, MicOff, Square, X } from 'lucide-react';
import { voice, useVoice, voiceEngineStatus } from '../voice/engine.ts';
import { useVoiceSession, voiceSession, rememberSetting } from '../voice/live/store.ts';
import { VoiceCore } from './voice-mode/VoiceCore.tsx';
import { modelLoadLabel } from '../voice/loading.ts';
import { navigate } from '../lib/router.ts';
import { post } from '../lib/api.ts';

export function VoiceToggle({ compact }: { compact?: boolean }) {
  const v = useVoice(); const session = useVoiceSession();
  const on = session.status !== 'off' && session.status !== 'error' || v.prefs.enabled;
  return <button className={`btn ${on ? 'voice-on' : 'ghost'} ${compact ? 'sm' : ''}`} aria-pressed={on} title="Hands-free voice" onClick={() => {
    rememberSetting('jarvis.voice.bubble.hidden', 'false');
    if (on) { if (voice.focusedSession) void voiceSession.end(); else void voice.stop(); }
    else void voice.start();
  }}>{on ? <Mic size={16} strokeWidth={1.5} /> : <MicOff size={16} strokeWidth={1.5} />}{on ? 'Voice on' : 'Voice off'}</button>;
}
function readPosition() {
  try { const p = JSON.parse(localStorage.getItem('jarvis.voice.bubble.position') ?? '{}'); return { x: Math.max(12, Number(p.x) || 24), y: Math.max(84, Number(p.y) || 88) }; }
  catch { return { x: 24, y: 88 }; }
}
/** One compact surface, backed by the same session as Ask. Diagnostics are opt-in. */
export function VoiceDock() {
  const v = useVoice(); const session = useVoiceSession();
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(() => localStorage.getItem('jarvis.voice.bubble.hidden') === 'true');
  const [position, setPosition] = useState(readPosition);
  const drag = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  const shared = session.status !== 'off' && session.status !== 'error';
  const active = shared || v.status !== 'off';
  if (session.fullView || !active && hidden) return null;
  const status = shared ? session.status : v.status;
  const caption = shared ? session.output || session.input || session.lines.at(-1)?.assistant : v.status === 'speaking' ? v.said : v.heard;
  const labels: Record<string, string> = { off: 'Voice', idle: 'Ready', listening: 'Listening', hearing: 'Listening', thinking: 'Thinking', working: 'Agent working', speaking: 'Speaking', connecting: 'Connecting', loading: 'Starting voice', error: 'Reconnect voice' };
  const end = () => { if (shared) void voiceSession.end(); else void voice.stop(); };
  const mute = () => { if (shared) voiceSession.mute(); else voice.muteMic(); };
  const open = () => {
    rememberSetting('jarvis.ask.mode', 'voice');
    navigate(session.conversationId ? `/c/${session.conversationId}` : '/');
    window.dispatchEvent(new Event('jarvis.open-voice'));
  };
  return <aside className={`voice-bubble${expanded ? ' expanded' : ''}`} style={{ right: Math.min(position.x, Math.max(12, innerWidth - (expanded ? 332 : 64))), bottom: Math.min(position.y, Math.max(84, innerHeight - (expanded ? 360 : 64))) }} aria-label="Jarvis voice">
    {expanded ? <div className="voice-bubble-panel">
      <div className="voice-bubble-head"><span>{labels[status]}</span><button className="btn ghost icon" aria-label="Move voice panel" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, right: position.x, bottom: position.y }; }} onPointerMove={(e) => {
        if (!drag.current) return;
        setPosition({ x: Math.max(12, Math.min(innerWidth - 332, drag.current.right - e.clientX + drag.current.x)), y: Math.max(84, Math.min(innerHeight - 360, drag.current.bottom - e.clientY + drag.current.y)) });
      }} onPointerUp={() => { drag.current = null; rememberSetting('jarvis.voice.bubble.position', JSON.stringify(position)); }} onPointerCancel={() => { drag.current = null; }}><GripVertical size={16} strokeWidth={1.5} /></button><button className="btn ghost icon" aria-label="Collapse voice panel" onClick={() => setExpanded(false)}><X size={16} strokeWidth={1.5} /></button></div>
      <div className="voice-bubble-caption" aria-live="polite">{caption || (active ? 'Say what you need' : 'Open full voice mode to talk with Jarvis')}</div>
      {session.error || shared && session.notice ? <p className="voice-bubble-notice">{session.error || session.notice}</p> : null}
      <div className="voice-bubble-actions"><button className="btn ghost icon" disabled={!active} aria-label={(shared ? session.muted : v.muted) ? 'Unmute mic' : 'Mute mic'} aria-pressed={shared ? session.muted : v.muted} onClick={mute}><MicOff size={16} strokeWidth={1.5} /></button>{status === 'speaking' ? <button className="btn ghost icon" aria-label="Stop speaking" onClick={() => { if (shared) { voiceSession.pushToTalk(true); voiceSession.pushToTalk(false); } else voice.stopSpeaking(); }}><Square size={16} strokeWidth={1.5} /></button> : null}<button className="btn ghost sm" disabled={!active} onClick={end}>End</button><button className="btn ghost sm" onClick={open}>Open full voice mode <ArrowUpRight size={16} strokeWidth={1.5} /></button></div>
      <details className="voice-details"><summary>Details</summary><p>{shared ? `${session.connection} · ${session.model || 'Local'}` : [voiceEngineStatus(v), v.micLabel, modelLoadLabel('voice', v.loads.voice), modelLoadLabel('speech recognition', v.loads.ears), v.adapter, v.fallback, v.error].filter(Boolean).join(' · ')}</p><button className="btn ghost sm" onClick={() => { if (shared && session.conversationId) void post(`/api/tasks/${session.conversationId}/cancel`).catch((error) => voiceSession.set({ error: (error as Error).message })); else voice.onStopAgent?.(); }}>Stop agent</button></details>
      <button className="btn ghost sm voice-dismiss" onClick={() => { setHidden(true); setExpanded(false); rememberSetting('jarvis.voice.bubble.hidden', 'true'); }}>Hide when voice is off</button>
    </div> : null}
    <button className="voice-bubble-trigger" aria-label={expanded ? 'Collapse voice panel' : `Open voice panel · ${labels[status]}`} aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}><VoiceCore small status={status} levels={shared ? undefined : () => [v.level, voice.outputLevel]} /></button>
  </aside>;
}
