import { useEffect, useRef } from 'react';
import { voiceSession } from '../../voice/live/store.ts';

/** The reactor is an instrument: its displacement comes from real input/output RMS. */
export function VoiceCore({ status, small = false, levels }: { status: string; small?: boolean; levels?: () => [number, number] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useRef({ status, levels }); source.current = { status, levels };
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const ctx = element.getContext('2d'); if (!ctx) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0; let rotation = 0; let previous = 0;
    let accent = ''; let border = ''; let muted = '';
    const colors = () => { const style = getComputedStyle(element); accent = style.getPropertyValue('--accent').trim(); border = style.getPropertyValue('--border-strong').trim(); muted = style.getPropertyValue('--text-faint').trim(); };
    colors(); const observer = new MutationObserver(() => { colors(); repaint(); }); observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const draw = (time: number) => {
      const size = element.clientWidth; const dpr = Math.min(devicePixelRatio || 1, 2);
      if (element.width !== Math.round(size * dpr)) { element.width = Math.round(size * dpr); element.height = element.width; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, size, size);
      const s = source.current.status;
      const live = !['off', 'error', 'idle'].includes(s);
      const working = s === 'working'; const thinking = s === 'thinking' || s === 'connecting' || working;
      const [mic, output] = source.current.levels?.() ?? [voiceSession.micLevel, voiceSession.outputLevel];
      const level = reduced.matches ? 0 : Math.min(1, (s === 'speaking' ? output : mic) * 7);
      if (!reduced.matches && live) rotation += Math.min(32, time - previous || 16) * (thinking ? 0.00022 : 0.00006);
      previous = time;
      const centre = size / 2; const radius = size * 0.35;
      ctx.save(); ctx.translate(centre, centre);
      const circle = (r: number, color: string, width: number) => { ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); };
      circle(radius * 1.23, border, 1); circle(radius * 0.94, border, 1);
      // Three measured arcs echo Jarvis's existing mark, without glow or decorative washes.
      ctx.save(); ctx.rotate(rotation);
      for (let i = 0; i < 3; i++) {
        const angle = i * Math.PI * 2 / 3;
        ctx.beginPath(); ctx.arc(0, 0, radius * (1.06 + level * 0.04), angle, angle + Math.PI * 0.53);
        ctx.strokeStyle = live ? accent : muted; ctx.globalAlpha = live ? 0.85 : 0.35; ctx.lineWidth = small ? 1.5 : 3; ctx.stroke();
      }
      ctx.restore(); ctx.globalAlpha = 1;
      for (let i = 0; i < (small ? 16 : 48); i++) {
        const angle = i / (small ? 16 : 48) * Math.PI * 2;
        const outer = radius * 1.23;
        ctx.beginPath(); ctx.moveTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
        ctx.lineTo(Math.cos(angle) * (outer - (i % 4 === 0 ? 7 : 3)), Math.sin(angle) * (outer - (i % 4 === 0 ? 7 : 3)));
        ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.stroke();
      }
      // Waveform ring follows audio energy. At rest it becomes a precise, quiet dial.
      ctx.beginPath();
      for (let i = 0; i <= 160; i++) {
        const a = i / 160 * Math.PI * 2;
        const r = radius * (0.66 + level * 0.07 * Math.sin(a * 12 + rotation * 6));
        const x = Math.cos(a) * r; const y = Math.sin(a) * r; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = live ? accent : muted; ctx.globalAlpha = live ? 0.6 : 0.25; ctx.lineWidth = 1; ctx.stroke(); ctx.globalAlpha = 1;
      if (!small) for (let i = 0; i < 8; i++) {
        const a = i / 8 * Math.PI * 2 - rotation * 0.6; const r = radius * (working ? 0.85 : 0.8);
        ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, working ? 2 : 1, 0, Math.PI * 2); ctx.fillStyle = live ? accent : border; ctx.fill();
      }
      circle(radius * 0.33 * (1 + level * 0.3), live ? accent : border, small ? 2 : 4);
      ctx.beginPath(); ctx.arc(0, 0, radius * (0.13 + level * 0.04), 0, Math.PI * 2); ctx.fillStyle = live ? accent : muted; ctx.globalAlpha = live ? 1 : 0.3; ctx.fill();
      ctx.restore();
      if (!reduced.matches && live) frame = requestAnimationFrame(draw);
    };
    const repaint = () => { cancelAnimationFrame(frame); draw(performance.now()); };
    reduced.addEventListener('change', repaint);
    const resize = new ResizeObserver(repaint); resize.observe(element); repaint();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); reduced.removeEventListener('change', repaint); };
  }, [status, small]);
  return <canvas ref={canvas} className={`voice-reactor${small ? ' small' : ''}`} aria-hidden="true" />;
}
