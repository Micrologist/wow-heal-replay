// The replay screen: playback controls on top, raid frames below. Reads only `timeline.at(t)`.

import type { Timeline } from "../model/timeline.ts";
import { createPlayback, type Playback } from "./controls/playback.ts";
import { h } from "./dom.ts";
import { createRaidFrames } from "./frames/raidFrames.ts";

export interface Replay {
  el: HTMLElement;
  dispose(): void;
}

export function createReplay(tl: Timeline): Replay {
  (window as unknown as { timeline: Timeline }).timeline = tl; // handy in the console
  const frames = createRaidFrames(tl.actors);
  const summary = h("span", { class: "muted small" });
  let lastTick = -1;
  const playback: Playback = createPlayback({
    durationMs: tl.durationMs,
    stepMs: tl.tickMs,
    markers: tl.deaths.map((d) => ({ t: d.t, label: `${d.name} died` })),
    onTime: (t) => {
      const tick = Math.floor(t / tl.tickMs);
      if (tick === lastTick) return;
      lastTick = tick;
      const state = tl.at(t);
      frames.update(state);
      summary.textContent = `${state.alive}/${tl.actors.length} alive · raid HP ${(state.raidPct * 100).toFixed(0)}%`;
    },
  });
  return {
    el: h("div", { class: "replay" }, playback.el, summary, frames.el),
    dispose: () => playback.dispose(),
  };
}
