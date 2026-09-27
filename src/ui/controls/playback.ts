// Playback controls: play/pause, speed, scrubber with death markers, fight clock.
// Owns the replay time `t` (ms since fight start) and calls `onTime` whenever it changes.
// Keys (CLAUDE.md §6.4): Space play/pause, ←/→ ±1 s (Shift ±10 s), 1–6 speed.

import { h } from "../dom.ts";

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

export function fmtFightTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

export interface Marker {
  t: number;
  label: string;
}

export interface Playback {
  el: HTMLElement;
  seek(t: number): void;
  dispose(): void;
}

export function createPlayback(opts: { durationMs: number; stepMs: number; markers: Marker[]; onTime: (t: number) => void }): Playback {
  const { durationMs } = opts;
  let t = 0;
  let playing = false;
  let speed = 1;
  let raf = 0;
  let lastFrame = 0;

  const playBtn = h("button", { class: "pb-play", type: "button", title: "Play/pause (Space)" });
  const clock = h("span", { class: "pb-clock" });
  const scrub = h("input", { class: "pb-scrub", type: "range", min: 0, max: durationMs, step: opts.stepMs, value: 0, "aria-label": "Fight time" });
  const speedBtns = SPEEDS.map((s, i) => h("button", {
    type: "button", class: "pb-speed", title: `${s}× (${i + 1})`,
    on: { click: () => setSpeed(s) },
  }, `${s}×`));
  const marks = h("div", { class: "pb-marks" }, ...opts.markers.map((m) =>
    h("button", {
      type: "button", class: "pb-mark", title: `${m.label} — ${fmtFightTime(m.t)}`,
      style: { left: `${(100 * m.t) / durationMs}%` },
      on: { click: () => seek(m.t - 3_000) },
    })));

  function render() {
    playBtn.textContent = playing ? "❚❚" : "▶";
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    clock.textContent = `${fmtFightTime(t)} / ${fmtFightTime(durationMs)}`;
    scrub.value = String(t);
    speedBtns.forEach((b, i) => b.classList.toggle("active", SPEEDS[i] === speed));
  }

  function seek(next: number) {
    t = Math.min(durationMs, Math.max(0, next));
    opts.onTime(t);
    render();
  }

  function frame(now: number) {
    if (!playing) return;
    const dt = now - lastFrame;
    lastFrame = now;
    seek(t + dt * speed);
    if (t >= durationMs) setPlaying(false);
    else raf = requestAnimationFrame(frame);
  }

  function setPlaying(p: boolean) {
    if (p && t >= durationMs) t = 0;
    playing = p;
    cancelAnimationFrame(raf);
    if (playing) {
      lastFrame = performance.now();
      raf = requestAnimationFrame(frame);
    }
    render();
  }

  function setSpeed(s: number) {
    speed = s;
    render();
  }

  function onKey(ev: KeyboardEvent) {
    const target = ev.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" && target !== scrub || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (ev.key === " ") setPlaying(!playing);
    else if (ev.key === "ArrowLeft") seek(t - (ev.shiftKey ? 10_000 : 1_000));
    else if (ev.key === "ArrowRight") seek(t + (ev.shiftKey ? 10_000 : 1_000));
    else if (/^[1-6]$/.test(ev.key)) setSpeed(SPEEDS[Number(ev.key) - 1]);
    else return;
    ev.preventDefault();
  }

  playBtn.addEventListener("click", () => setPlaying(!playing));
  scrub.addEventListener("input", () => seek(Number(scrub.value)));
  document.addEventListener("keydown", onKey);
  render();
  opts.onTime(t);

  return {
    el: h("div", { class: "playback" },
      h("div", { class: "pb-row" }, playBtn, clock, h("div", { class: "pb-speeds" }, ...speedBtns)),
      h("div", { class: "pb-track" }, scrub, marks),
    ),
    seek,
    dispose() {
      playing = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
    },
  };
}
