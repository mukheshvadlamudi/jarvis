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
  const downloading = (v.progress.voice > 0 && v.progress.voice < 100) || (v.progress.ears > 0 && v.progress.ears < 100);
  const ready = (p.engine === 'system' || v.progress.voice === 100) && v.progress.ears === 100;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Voice</h2>
        <span className="right faint" style={{ fontSize: 12 }}>
          Kokoro + Whisper, on this device · saved instantly
        </span>
      </div>
      <Line label="Hands-free voice" hint="Jarvis listens for its name and speaks updates by itself. Nothing leaves this device and no credits are used.">
        <VoiceToggle />
      </Line>
      <Line
        label="Voice engine"
        hint={
          p.engine === 'kokoro'
            ? 'Kokoro 82M — natural neural voice. Best quality uses a larger fp32 model and more memory. Fastest with a graphics card; memory is freed when voice is off.'
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
      {p.engine === 'kokoro' ? <Line label="Voice quality" hint="Best uses fp32 on your graphics card when available, or on CPU. Light uses q8 on CPU to save memory.">
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
      <Line label="Speech recognition" hint="Whisper, on this device. RAM while on: Tiny ~200 MB, Base ~300 MB, Small ~600 MB. Base is the best balance of speed and accuracy.">
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
      <Line label="Models" hint={ready ? `Downloaded and cached${v.device ? ` · running on ${v.device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)'}` : ''}.` : 'Downloaded once from Hugging Face, then cached by the browser.'}>
        <button className="btn ghost sm" disabled={downloading || ready} onClick={() => voice.preload()}>
          <Download size={14} strokeWidth={1.5} />
          {ready ? 'Ready' : downloading ? `Voice ${v.progress.voice}% · Ears ${v.progress.ears}%` : 'Download now'}
        </button>
      </Line>
    </section>
  );
}
