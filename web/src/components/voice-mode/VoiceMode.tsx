import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Settings2, Square } from 'lucide-react';
import { voice, useVoice, VOICES, voiceEngineStatus } from '../../voice/engine.ts';
import { modelLoadLabel } from '../../voice/loading.ts';
import { LIVE_VOICES, usageLabel } from '../../voice/live/config.ts';
import { useVoiceSession, voiceSession } from '../../voice/live/store.ts';
import { useNow } from '../../lib/hooks.ts';
import { Link } from '../ui.tsx';
import { VoiceCore } from './VoiceCore.tsx';

const LABELS = { off: 'Ready when you are', connecting: 'Connecting', listening: 'Listening', hearing: 'Listening to you', thinking: 'Thinking', speaking: 'Speaking', working: 'Agent at work', error: 'Let’s reconnect' };
export function VoiceUsage() {
  const session = useVoiceSession();
  useEffect(() => { void voiceSession.loadUsage(); }, []);
  return <p className="voice-usage">{usageLabel({ inSec: session.inSec + session.pendingInSec, outSec: session.outSec + session.pendingOutSec })}</p>;
}
function VoiceSettings() {
  const session = useVoiceSession(); const v = useVoice();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const refresh = () => { void navigator.mediaDevices?.enumerateDevices().then((d) => setDevices(d.filter((d) => d.kind === 'audioinput'))).catch(() => undefined); };
    refresh(); navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [session.status === 'off']);
  return <>
    <label className="voice-setting"><span>Microphone</span><select value={v.prefs.micId} onChange={(e) => void voiceSession.changeMic(e.target.value)}><option value="">System microphone</option>{devices.filter((d) => d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}</select></label>
    <label className="voice-setting"><span>Voice</span><select value={session.brain === 'gemini' ? session.liveVoice : v.prefs.voice} onChange={(e) => session.brain === 'gemini' ? void voiceSession.changeVoice(e.target.value) : voice.setPrefs({ voice: e.target.value })}>{session.brain === 'gemini' ? LIVE_VOICES.map((name) => <option key={name}>{name}</option>) : VOICES.map((v) => <option key={v.id} value={v.id}>{v.label.split(' · ')[0]}</option>)}</select></label>
    <label className="voice-setting"><span>Brain</span><select value={session.brain} onChange={(e) => void voiceSession.changeBrain(e.target.value as 'gemini' | 'local')}><option value="gemini" disabled={session.configured !== true}>{session.configured === false ? 'Gemini Live · Set up' : `Gemini Live${session.model ? ' · ' + session.model.replace(/^gemini-/, '').replace(/-flash/g, '').replace(/-live$/, '').replace(/-/g, ' ') : ''}`}</option><option value="local">Local (no key)</option></select></label>
    <label className="voice-setting"><span>Interruptions</span><select value={v.prefs.interruptions} onChange={(e) => voice.setPrefs({ interruptions: e.target.value as 'headset' | 'speaker-safe' })}><option value="speaker-safe">Speaker-safe</option><option value="headset">Headset</option></select></label>
    {session.configured === false ? <Link to="/settings" className="voice-setup">Set up Gemini</Link> : null}
  </>;
}

export function VoiceMode({ conversationId }: { conversationId: string | null }) {
  const session = useVoiceSession(); const v = useVoice(); const now = useNow(1000);
  const sheet = useRef<HTMLDialogElement>(null);
  const captions = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = captions.current; if (el) el.scrollTop = el.scrollHeight; }, [session.input, session.output, session.lines]);
  useEffect(() => {
    voiceSession.set({ fullView: true }); voiceSession.setConversation(conversationId); void voiceSession.configure();
    if (voice.state.prefs.enabled && !voice.focusedSession) void voiceSession.start(conversationId);
    return () => { voiceSession.set({ fullView: false }); voiceSession.pushToTalk(false); };
  }, []);
  useEffect(() => { voiceSession.setConversation(conversationId); }, [conversationId]);
  useEffect(() => {
    const typing = (event: KeyboardEvent) => { const target = event.target as HTMLElement | null; return target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target?.tagName ?? ''); };
    const down = (event: KeyboardEvent) => { if (event.code !== 'Space' || typing(event) || session.status === 'off') return; event.preventDefault(); if (!event.repeat) voiceSession.pushToTalk(true); };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') voiceSession.pushToTalk(false); };
    const blur = () => voiceSession.pushToTalk(false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [session.status]);
  const active = !['off', 'error'].includes(session.status);
  const last = session.lines.at(-1);
  const input = session.input || (!session.output ? last?.user : '');
  const output = session.output || (!session.input ? last?.assistant : '');
  return <div className="voice-mode">
    <div className="voice-settings-desktop"><VoiceSettings /></div>
    <div className="voice-mobile-top"><span>{session.brain === 'gemini' ? 'Gemini Live' : 'Local voice'}</span><button className="btn ghost sm" onClick={() => sheet.current?.showModal()}><Settings2 size={16} strokeWidth={1.5} /> Voice settings</button></div>
    <dialog ref={sheet} className="voice-settings-sheet" aria-label="Voice settings"><div className="voice-sheet-head"><h2>Voice settings</h2><button className="btn ghost sm" onClick={() => sheet.current?.close()}>Done</button></div><VoiceSettings /></dialog>
    <div className="voice-stage">
      <div className="voice-connection"><span className={`dot${active && session.status !== 'connecting' ? ' live' : ''}`} />{session.connection}{session.brain === 'local' ? ' · On this device' : ' · Silence stays on your device'}</div>
      <VoiceCore status={session.status} />
      <h2 className="voice-status">{session.muted ? 'Microphone muted' : LABELS[session.status]}</h2>
      <div className="voice-captions" ref={captions} aria-live="polite" aria-atomic="false" role="log" aria-label="Live voice captions">
        {input ? <p className="voice-caption-user"><span>You</span>{input}</p> : null}
        {output ? <p className="voice-caption-assistant"><span>Jarvis</span>{output}</p> : null}
        {!input && !output ? <p className="voice-caption-empty">{active ? 'Talk naturally. Take your time.' : 'Talk it through. Send the work to Claude or Codex.'}</p> : null}
      </div>
      <div className="voice-runs">{session.runs.map((run) => {
        const elapsed = Math.max(0, Math.floor((now - Date.parse(run.started_at ?? '')) / 1000)) || 0;
        return <div className="voice-agent-card" key={run.id}><span className="dot live" /><span>{run.agent === 'claude' ? 'Claude' : 'Codex'} · {run.owner_text?.replace(/\n\n\[Voice reply:[\s\S]*/, '').slice(0, 80) || 'Working on your request'}</span><time>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</time></div>;
      })}</div>
    </div>
    <footer className="voice-footer">
      <div className="voice-notice" role={session.error ? 'alert' : 'status'}>{session.error || session.notice || (active ? v.prefs.interruptions === 'speaker-safe' ? 'Speaker-safe · Hold Space to interrupt' : 'Headset · You can interrupt naturally' : 'Your microphone starts only when you connect')}</div>
      <div className="voice-actions">
        <button className="btn voice-mute" disabled={!active} aria-label={session.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={session.muted} onClick={() => voiceSession.mute()}>{session.muted ? <MicOff size={20} strokeWidth={1.5} /> : <Mic size={20} strokeWidth={1.5} />}</button>
        {active ? <button className="btn voice-end" onClick={() => void voiceSession.end()}><Square size={16} strokeWidth={1.5} /> End</button> : <button className="btn primary voice-end" onClick={() => void voiceSession.start(conversationId)}><Mic size={18} strokeWidth={1.5} />{session.status === 'error' ? 'Retry voice' : 'Connect'}</button>}
        <button className="btn voice-push" disabled={!active || v.prefs.interruptions !== 'speaker-safe'} aria-label="Hold to talk" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); voiceSession.pushToTalk(true); }} onPointerUp={() => voiceSession.pushToTalk(false)} onPointerCancel={() => voiceSession.pushToTalk(false)} onKeyDown={(e) => { if (e.code === 'Space' && !e.repeat) voiceSession.pushToTalk(true); }} onKeyUp={() => voiceSession.pushToTalk(false)} onBlur={() => voiceSession.pushToTalk(false)}><span className="voice-space-key">Space</span><span>Hold to talk</span></button>
      </div>
      <VoiceUsage />
      {session.brain === 'local' && (session.status === 'connecting' || session.status === 'error') ? <details className="voice-diagnostics"><summary>Details</summary><p>{[voiceEngineStatus(v), modelLoadLabel('voice', v.loads.voice), modelLoadLabel('speech recognition', v.loads.ears), v.micLabel, v.adapter, v.fallback].filter(Boolean).join(' · ')}</p><Link to="/settings">Open voice settings</Link></details> : null}
    </footer>
  </div>;
}
