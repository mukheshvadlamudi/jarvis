/** Browser dictation via the Web Speech API. Text input only — Jarvis never speaks. */
type Rec = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

function ctor(): (new () => Rec) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && ctor() !== null;
}

export function startDictation(handlers: { onText: (finalText: string, interim: string) => void; onEnd: () => void; onError: (msg: string) => void }): () => void {
  const C = ctor();
  if (!C) {
    handlers.onError('Dictation is not supported in this browser.');
    return () => undefined;
  }
  const rec = new C();
  rec.lang = navigator.language || 'en-GB';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (e: any) => {
    let finalText = '';
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    handlers.onText(finalText, interim);
  };
  rec.onerror = (e: any) => handlers.onError(e?.error === 'not-allowed' ? 'Microphone access was blocked. Allow it in the browser’s site settings.' : `Dictation stopped (${e?.error ?? 'error'}).`);
  rec.onend = handlers.onEnd;
  rec.start();
  return () => rec.stop();
}
