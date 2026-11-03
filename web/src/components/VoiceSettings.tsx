import { useEffect, useState } from 'react';
import { modelLoadLabel } from '../voice/loading.ts';
import { Download, Play } from 'lucide-react';
import { Segmented, Switch } from './ui.tsx';
import { VOICES, voice, useVoice, voiceEngineStatus } from '../voice/engine.ts';
import type { VoicePrefs } from '../voice/engine.ts';
import { VoiceToggle } from './VoiceDock.tsx';

function Line({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <div className="row-stack" style={{ flex: '1 1 220px', minWidth: 0 }}>
        <span style={{ fontWeight: 500, fontSize: 13 }}>{label}</span>
        {hint ? <span className="sub" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{hint}</span> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', maxWidth: '100%', minWidth: 0 }}>{children}</div>
    </div>
  );
}

const SPEAK: Array<{ key: keyof VoicePrefs['speak']; label: string }> = [
  { key: 'approvals', label: 'Approvals' },
  { key: 'finished', label: 'Finished tasks' },
  { key: 'failed', label: 'Failures' },
  { key: 'brief', label: 'Morning brief' },
  { key: 'notify', label: 'Agent notes' },
  { key: 'confirmations', label: 'Confirmations' },
];

/** Voice runs in this browser/app, so its settings are per device and save instantly. */
export function VoiceSettings() {
  const v = useVoice();
  const p = v.prefs;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micError, setMicError] = useState('');
  useEffect(() => {
    let active = true;
    const media = navigator.mediaDevices;
    const refresh = () => void media?.enumerateDevices().then((all) => { if (active) setDevices(all.filter((d) => d.kind === 'audioinput')); }).catch(() => { if (active) setMicError('Could not list microphones'); });
    refresh();
    media?.addEventListener('devicechange', refresh);
    void navigator.storage?.persisted().then((persisted) => { if (active && voice.state.persisted === null) voice.setPersistenceStatus(persisted); }).catch(() => undefined);
    return () => { active = false; media?.removeEventListener('devicechange', refresh); };
  }, [v.micLabel]);
  const allowMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'));
      setMicError('');
    } catch { setMicError('Microphone access was blocked. Allow it in browser or system settings, then try again'); }
  };
  const loadingLabel = [modelLoadLabel('voice', v.loads.voice), modelLoadLabel('speech recognition', v.loads.ears)].filter(Boolean).join(' · ');
  const downloading = !!loadingLabel;
  const ready = (p.engine === 'system' || v.progress.voice === 100) && v.progress.ears === 100;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Voice</h2>
        <span className="right faint" style={{ fontSize: 12 }}>
          Kokoro + Whisper, on this device · saved instantly
        </span>
      </div>
      <Line label="Hands-free voice" hint="Jarvis listens for its name and speaks updates by itself. Speech is processed on this device; accepted commands go to your agents.">
        <VoiceToggle />
      </Line>
      <Line label="Microphone" hint={v.micLabel ? 'Using: ' + v.micLabel : 'Choose a microphone, then turn voice on to check its input'}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 300, maxWidth: '100%' }}>
          <select className="input" aria-label="Microphone" value={p.micId} onChange={(e) => voice.setPrefs({ micId: e.target.value })} style={{ flex: 1, width: 0, minWidth: 0 }}>
            <option value="">System default</option>
            {p.micId && !devices.some((d) => d.deviceId === p.micId) ? <option value={p.micId}>Saved microphone (unavailable)</option> : null}
            {devices.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone ' + (i + 1)}</option>)}
          </select>
          {p.enabled ? <div role="meter" aria-label="Microphone input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.level * 100)} style={{ width: 64, flexShrink: 0, height: 8, borderRadius: 4, background: 'var(--bg-active)', overflow: 'hidden' }}>
            <div style={{ height: '100%', background: 'var(--text-muted)', transform: `scaleX(${v.level})`, transformOrigin: 'left' }} />
          </div> : null}
        </div>
      </Line>
      {!devices.some((d) => d.label) ? <Line label="Allow the mic to see device names">
        <button className="btn ghost sm" style={{ minHeight: 44 }} onClick={() => void allowMic()}>Allow microphone</button>
      </Line> : null}
      {micError || v.micFallback ? <Line label="Microphone status" hint={micError || v.micFallback}>{null}</Line> : null}
      <Line label="Interruptions" hint={p.interruptions === 'speaker-safe' ? 'Speaker-safe: listening pauses during speech; press Space or Stop, then reply without the wake word' : 'Headset: keep listening and lower the output when you start speaking; use headphones'}>
        <Segmented<VoicePrefs['interruptions']> label="Interruptions" value={p.interruptions} onChange={(interruptions) => voice.setPrefs({ interruptions })} options={[{ value: 'speaker-safe', label: 'Speaker-safe' }, { value: 'headset', label: 'Headset' }]} />
      </Line>
      <Line label="Turn detection" hint={p.turnDetection === 'smart' ? v.turnStatus : 'Simple timing: send after a short silence'}>
        <Segmented<VoicePrefs['turnDetection']> label="Turn detection" value={p.turnDetection} onChange={(turnDetection) => voice.setPrefs({ turnDetection })} options={[{ value: 'smart', label: 'Smart' }, { value: 'simple', label: 'Simple' }]} />
      </Line>
      <Line label="Mic sensitivity" hint="High detects quieter speech and shorter phrases">
        <Segmented<VoicePrefs['micSensitivity']> label="Mic sensitivity" value={p.micSensitivity} onChange={(micSensitivity) => voice.setPrefs({ micSensitivity })} options={[{ value: 'normal', label: 'Normal' }, { value: 'high', label: 'High' }]} />
      </Line>
      <Line label="Noise suppression" hint="Turn off if quiet or distant speech gets clipped">
        <Switch label="Noise suppression" checked={p.noiseSuppression} onChange={(noiseSuppression) => voice.setPrefs({ noiseSuppression })} />
      </Line>
      <Line
        label="Voice engine"
        hint={
          p.engine === 'kokoro'
            ? 'Kokoro 82M — natural neural voice. Best quality uses a larger fp32 model and more memory. Fastest with a graphics card.'
            : 'Your operating system’s voice — instant and uses no extra memory, but sounds more robotic. Pick a “Natural”/“Enhanced” voice in your OS settings for the best result.'
        }
      >
        <Segmented<VoicePrefs['engine']>
          label="Voice engine"
          value={p.engine}
          onChange={(engine) => voice.setPrefs({ engine })}
          options={[
            { value: 'kokoro', label: 'Natural (Kokoro)' },
            { value: 'system', label: 'Light (system)' },
          ]}
        />
      </Line>
      <Line label="Voice status" hint={[voiceEngineStatus(v), v.adapter, v.fallback].filter(Boolean).join(' \u00b7 ')}>
        {p.engine === 'kokoro' && v.natural === 'failed' ? <button className="btn ghost sm" onClick={() => voice.retryVoice()}>Retry loading</button> : null}
      </Line>
      {p.engine === 'kokoro' ? <Line label="Voice quality" hint="Best uses a separate 326 MB fp32 file, so switching from the older q8 model needs one download. Light uses q8 on CPU to save memory.">
        <select className="input" aria-label="Voice quality" value={p.voiceQuality} onChange={(e) => voice.setPrefs({ voiceQuality: e.target.value as VoicePrefs['voiceQuality'] })} style={{ width: '100%', maxWidth: 300 }}>
          <option value="best">Best (graphics card if available)</option>
          <option value="light">Light (less memory)</option>
        </select>
      </Line> : null}
      <Line label="Voice">
        {p.engine === 'kokoro' ? (
          <select className="input" aria-label="Voice" value={p.voice} onChange={(e) => voice.setPrefs({ voice: e.target.value })} style={{ width: '100%', maxWidth: 300 }}>
            {VOICES.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="faint" style={{ fontSize: 12 }}>Best available system voice for your language</span>
        )}
        <button className="btn ghost sm" onClick={() => void voice.speak('Good evening. Two tasks finished while you were away, and one needs your approval.')}>
          <Play size={14} strokeWidth={1.5} /> Preview
        </button>
      </Line>
      <Line label="Speed">
        <input type="range" aria-label="Speaking speed" min={0.8} max={1.3} step={0.05} value={p.speed} onChange={(e) => voice.setPrefs({ speed: Number(e.target.value) })} style={{ width: 160, accentColor: 'var(--primary)' }} />
        <span className="mono num faint" style={{ fontSize: 12, width: 40 }}>
          {p.speed.toFixed(2)}×
        </span>
      </Line>
      <Line label="Wake word" hint="On: only what you say with “Jarvis” near the start is acted on (right after Jarvis speaks you can reply without it). Off: everything you say is a command.">
        <Switch label="Wake word" checked={p.wakeWord} onChange={(wakeWord) => voice.setPrefs({ wakeWord })} />
      </Line>
      <Line label="Speech recognition" hint={'Whisper, on this device. RAM: Tiny ~200 MB, Base ~300 MB, Small ~600 MB. Base is the default.' + ('gpu' in navigator ? ' Whisper Small is the most accurate and runs fast on the graphics card with WebGPU.' : '')}>
        <Segmented<VoicePrefs['sttModel']>
          label="Speech model"
          value={p.sttModel}
          onChange={(sttModel) => voice.setPrefs({ sttModel })}
          options={[
            { value: 'whisper-tiny', label: 'Tiny' },
            { value: 'whisper-base', label: 'Base' },
            { value: 'whisper-small', label: 'Small' },
          ]}
        />
        <select className="input" aria-label="Language" value={p.language} onChange={(e) => voice.setPrefs({ language: e.target.value })} style={{ width: 130 }}>
          <option value="en">English</option>
          <option value="auto">Auto-detect</option>
          <option value="hi">Hindi</option>
          <option value="te">Telugu</option>
        </select>
      </Line>
      <Line label="Speak out loud">
        {SPEAK.map((s) => (
          <label key={s.key} className="chip" style={{ cursor: 'pointer', gap: 6 }}>
            <input type="checkbox" checked={p.speak[s.key]} onChange={(e) => voice.setPrefs({ speak: { ...p.speak, [s.key]: e.target.checked } })} style={{ accentColor: 'var(--primary)' }} />
            {s.label}
          </label>
        ))}
      </Line>
      <Line label="Keep voice loaded" hint="Keep speech models in memory between wakes for instant listening. Turning this off frees their memory when voice is off.">
        <Switch label="Keep voice loaded" checked={p.keepLoaded} onChange={(keepLoaded) => voice.setPrefs({ keepLoaded })} />
      </Line>
      <Line label="Model storage" hint={v.persisted === true ? 'Models are kept on this device' : 'The browser may clear the models when space is low'}>{null}</Line>
      <Line label="Models" hint={ready ? `Downloaded and cached${v.device ? ` · running on ${v.device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)'}` : ''}.` : loadingLabel || 'Downloads from Hugging Face are saved by the browser for reuse.'}>
        <button className="btn ghost sm" disabled={downloading || ready} onClick={() => voice.preload()}>
          <Download size={14} strokeWidth={1.5} />
          {ready ? 'Ready' : downloading ? 'Loading models' : 'Download now'}
        </button>
      </Line>
    </section>
  );
}
