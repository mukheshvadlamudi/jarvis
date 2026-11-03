import { voice } from '../web/src/voice/engine.ts';
import { api, post } from '../web/src/lib/api.ts';

interface Bridge {
  anywhereSettings(patch?: { mode: string }): Promise<{ mode: string }>;
  onAnywhere(fn: (event: { action: string; mode?: string }) => void): void;
  closeAnywhere(): Promise<void>;
  expandAnywhere(): Promise<void>;
  releaseAnywhereFocus(): Promise<void>;
  openAnywhere(id: string): Promise<void>;
  pasteAnywhere(text: string): Promise<{ ok: boolean; message?: string }>;
}
const bridge = (window as unknown as { jarvisDesktop: Bridge }).jarvisDesktop;
const el = (id: string) => document.getElementById(id)!;
let mode = 'ask';
let conversation: string | null = null;
let busy = false;
let active = false;
let epoch = 0;
let finishing = false;
let finishTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function setMode(value: string) {
  mode = value;
  el('ask').setAttribute('aria-pressed', String(mode === 'ask'));
  el('dictate').setAttribute('aria-pressed', String(mode === 'dictate'));
}
async function switchMode() {
  if (busy) return;
  const previous = mode;
  setMode(mode === 'ask' ? 'dictate' : 'ask');
  try { await bridge.anywhereSettings({ mode }); }
  catch (error) { setMode(previous); el('status').textContent = (error as Error).message; }
}
function stop() {
  active = false;
  finishing = false;
  clearTimeout(finishTimer);
  void voice.stop();
}
function finish() {
  if (busy || !active || finishing) return;
  // Let VAD endpoint the last words and Whisper complete; stopping the engine discards pending STT.
  finishing = true;
  el('status').textContent = 'Finishing transcription…';
  const deadline = Date.now() + 120_000;
  const drained = () => {
    if (!active || busy) return;
    if (Date.now() < deadline && ['loading', 'hearing', 'thinking'].includes(voice.state.status)) { finishTimer = setTimeout(drained, 1000); return; }
    stop();
    el('status').textContent = 'No speech received · tap the shortcut to try again';
    void bridge.releaseAnywhereFocus();
  };
  finishTimer = setTimeout(drained, 1500);
}
voice.subscribe(() => {
  if (!active || busy || finishing) return;
  const state = voice.state;
  el('status').textContent = state.error || (state.status === 'loading' ? 'Loading speech recognition on this device…' : state.outcome || (state.status === 'hearing' ? 'Listening…' : state.status === 'thinking' ? 'Transcribing…' : 'Listening · speak when ready'));
});

async function readAnswer(id: string, turn: number, deadline: number) {
  if (turn !== epoch) return;
  try {
    const data = await api<{ active: boolean; approvals: unknown[]; conversation: { status: string }; runs: Array<{ events: Array<{ kind: string; payload: { role?: string; text?: string } }> }> }>(`/api/conversations/${id}`);
    if (turn !== epoch) return;
    const messages = data.runs.at(-1)?.events.filter((e) => e.kind === 'message' && e.payload.role === 'assistant') ?? [];
    el('answer').textContent = messages.map((m) => m.payload.text).join('\n').slice(0, 2400);
    el('status').textContent = data.approvals.length ? 'Approval needed · open Jarvis' : data.active ? 'Jarvis is working…' : data.conversation.status === 'failed' ? 'Run failed · open Jarvis for details' : 'Answered';
    if (data.active && Date.now() < deadline) pollTimer = setTimeout(() => void readAnswer(id, turn, deadline), 1000);
    else { busy = false; if (data.active) el('status').textContent = 'Still working · open Jarvis to follow the run'; void bridge.releaseAnywhereFocus(); }
  } catch (error) { if (turn === epoch) { busy = false; el('status').textContent = (error as Error).message; } }
}

voice.onUtterance = (text) => {
  if (!active || busy) return;
  busy = true;
  el('finish').hidden = true;
  void bridge.expandAnywhere();
  const turn = epoch;
  stop();
  el('transcript').textContent = text;
  void (async () => {
    if (mode === 'dictate') {
      const result = await bridge.pasteAnywhere(text);
      if (turn !== epoch) return;
      el('status').textContent = result.ok ? 'Pasted' : result.message ?? 'Paste failed · select and copy the transcript';
      busy = false;
    } else {
      el('status').textContent = 'Asking Jarvis…';
      const data = await post<{ conversation: { id: string } }>(conversation ? `/api/conversations/${conversation}/messages` : '/api/conversations', { text });
      conversation = data.conversation.id;
      if (turn !== epoch) return;
      el('open').hidden = false;
      await readAnswer(conversation, turn, Date.now() + 300_000);
    }
  })().catch((error: Error) => { if (turn === epoch) { busy = false; el('status').textContent = error.message; } });
};

function start(modeOverride = mode) {
  ++epoch; clearTimeout(pollTimer); busy = false;
  setMode(modeOverride);
  active = true; finishing = false;
  el('finish').hidden = false;
  el('transcript').textContent = ''; el('answer').textContent = ''; el('open').hidden = !conversation;
  // The isolated overlay session keeps these overrides separate from the main Voice screen.
  voice.setPrefs({ engine: 'system', turnDetection: 'simple', keepLoaded: false, wakeWord: false });
  void voice.start();
}
bridge.onAnywhere((event) => {
  if (event.action === 'close') { ++epoch; busy = false; clearTimeout(pollTimer); stop(); return; }
  if (event.action === 'finish') { finish(); return; }
  if (event.action === 'toggle') { if (!active && !busy) start(); else finish(); return; }
  if (event.action === 'start') {
    start(event.mode ?? 'ask');
  }
});
el('ask').onclick = () => { if (mode !== 'ask') void switchMode(); };
el('dictate').onclick = () => { if (mode !== 'dictate') void switchMode(); };
el('close').onclick = () => void bridge.closeAnywhere();
el('finish').onclick = finish;
el('open').onclick = () => { if (conversation) void bridge.openAnywhere(conversation); };
window.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); void switchMode(); }
  if (event.key === 'Escape') void bridge.closeAnywhere();
});
