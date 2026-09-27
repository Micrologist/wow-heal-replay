// Milestone 2 debug readout: scrub a slider, see `timeline.at(t)` as text bars, and in the console.
// Throwaway: the raid frames (Milestone 3) replace it.

import classColors from "../data/classColors.json";
import type { Timeline } from "../model/timeline.ts";
import { h } from "./dom.ts";

const COLORS = classColors as Record<string, string>;

export function fmtFightTime(ms: number): string {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

export function timelineDebug(tl: Timeline): HTMLElement {
  (window as unknown as { timeline: Timeline }).timeline = tl;
  const slider = h("input", { type: "range", min: 0, max: tl.durationMs, step: tl.tickMs, value: 0, class: "scrub" });
  const clock = h("span", { class: "clock" });
  const summary = h("span", { class: "muted" });
  const rows = tl.actors.map((a) => {
    const fill = h("div", { class: "fill", style: { background: COLORS[a.className] ?? "#888" } });
    const text = h("span", { class: "muted" });
    const row = h("div", { class: "hprow" }, h("span", { class: "name", style: { color: COLORS[a.className] ?? "inherit" } }, a.name), h("div", { class: "bar" }, fill), text);
    return { row, fill, text };
  });
  const deathMarks = h("div", { class: "marks" }, ...tl.deaths.map((d) =>
    h("span", { class: "mark", title: `${d.name} died at ${fmtFightTime(d.t)}`, style: { left: `${(100 * d.t) / tl.durationMs}%` } })));

  let logTimer: ReturnType<typeof setTimeout> | undefined;
  function show(t: number) {
    const s = tl.at(t);
    clock.textContent = fmtFightTime(s.t);
    summary.textContent = `alive ${s.alive}/${tl.actors.length} · raid HP ${(s.raidPct * 100).toFixed(1)}%`;
    s.actors.forEach((a, i) => {
      const r = rows[i];
      r.fill.style.width = `${a.pct * 100}%`;
      r.row.classList.toggle("dead", a.dead);
      r.text.textContent = a.dead ? "dead" : `${(a.pct * 100).toFixed(0)}%${a.stale ? " ?" : ""}`;
    });
    clearTimeout(logTimer);
    logTimer = setTimeout(() => console.log(`timeline.at(${s.t})`, s), 250);
  }
  slider.addEventListener("input", () => show(Number(slider.value)));
  show(0);

  return h("details", { class: "debug", open: true },
    h("summary", null, "Timeline (debug) — ", h("code", null, "timeline.at(t)"), " is also on ", h("code", null, "window.timeline")),
    h("div", { class: "row" }, clock, summary),
    h("div", { class: "scrubwrap" }, slider, deathMarks),
    h("div", { class: "hpgrid" }, ...rows.map((r) => r.row)),
  );
}
