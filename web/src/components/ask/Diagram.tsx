import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../../lib/markdown.tsx';
import mermaidUrl from './mermaid.min.js?url';

let runtimeText: Promise<string> | null = null;
function loadRuntime() {
  runtimeText ??= fetch(mermaidUrl, { signal: AbortSignal.timeout(10_000) }).then((r) => {
    if (!r.ok) throw new Error('Diagram runtime could not load');
    return r.text();
  }).catch((err) => { runtimeText = null; throw err; });
  return runtimeText;
}

/** Mermaid runs in an opaque sandbox: generated diagrams cannot access the app or load images. */
export default function Diagram({ source }: { source: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(240);
  const [doc, setDoc] = useState('');
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [theme, setTheme] = useState('');
  useEffect(() => {
    const update = () => setTheme(getComputedStyle(document.documentElement).getPropertyValue('--text'));
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    update();
    return () => { observer.disconnect(); media.removeEventListener('change', update); };
  }, []);
  useEffect(() => {
    setFailed(false);
    setLoaded(false);
    setDoc('');
    let disposed = false;
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--bg-raised').trim();
    const ink = css.getPropertyValue('--text').trim();
    const muted = css.getPropertyValue('--text-muted').trim();
    const data = JSON.stringify(source).replace(/</g, '\\u003c');
    const config = JSON.stringify({ startOnLoad: false, securityLevel: 'strict', theme: 'base', flowchart: { htmlLabels: false }, themeVariables: { primaryColor: bg, primaryTextColor: ink, primaryBorderColor: muted, lineColor: muted, background: bg, fontFamily: 'system-ui' } });
    // Fetch in the app origin; opaque frames cannot fetch loopback assets in some browsers.
    void loadRuntime().then((runtime) => {
      if (disposed) return;
      setDoc(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'"><style>body{margin:0;background:${bg};color:${ink};font:14px system-ui}svg{display:block;min-width:600px;width:100%;height:auto;margin:auto}::-webkit-scrollbar{height:8px}::-webkit-scrollbar-thumb{background:${muted};border-radius:4px}</style></head><body><div id="chart" role="img" aria-label="Answer diagram"></div><script>${runtime.replace(/<\/script/gi, '<\\/script')}</script><script>(async()=>{try{mermaid.initialize(${config});const {svg}=await mermaid.render('diagram',${data});document.getElementById('chart').innerHTML=svg;parent.postMessage({type:'jarvis.diagram',height:document.querySelector('svg').getBoundingClientRect().height+16},'*')}catch{parent.postMessage({type:'jarvis.diagram',error:true},'*')}})()</script></body></html>`);
    }).catch(() => { if (!disposed) setFailed(true); });
    const timeout = window.setTimeout(() => setFailed(true), 15_000);
    const receive = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.data?.type !== 'jarvis.diagram') return;
      window.clearTimeout(timeout);
      if (e.data.error) setFailed(true);
      else if (Number.isFinite(e.data.height)) { setLoaded(true); setHeight(Math.min(1000, Math.max(80, e.data.height + 16))); }
    };
    window.addEventListener('message', receive);
    return () => { disposed = true; window.clearTimeout(timeout); window.removeEventListener('message', receive); };
  }, [source, theme]);
  return <figure className="answer-diagram">
    {!loaded && !failed ? <p role="status" className="muted">Loading diagram…</p> : null}
    {!failed && doc ? <iframe ref={frame} title="Answer diagram" sandbox="allow-scripts" srcDoc={doc} style={{ height }} /> : null}
    {failed ? <p className="muted">Diagram unavailable. You can still read or copy its source below.</p> : null}
    {loaded ? <figcaption className="diagram-scroll-hint">Scroll horizontally to explore</figcaption> : null}
    <details><summary>Diagram source</summary><Markdown source={`\`\`\`mermaid\n${source}\n\`\`\``} /></details>
  </figure>;
}
