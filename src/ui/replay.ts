// The replay screen: playback controls on top, raid frames + healer panels below.
// Reads only the Timeline (`at(t)` and the healers' `at(id, t)`), never raw events.

import type { Timeline } from "../model/timeline.ts";
import { createPlayback, type Playback } from "./controls/playback.ts";
import { h } from "./dom.ts";
import { createRaidFrames } from "./frames/raidFrames.ts";
import { createHealerPanels } from "./healerPanel/healerPanel.ts";

export interface Replay {
  el: HTMLElement;
  dispose(): void;
}

export function createReplay(tl: Timeline, opts: { actorNames: Map<number, string>; selectedHealer?: string; onSelectHealer?: (name: string | null) => void } ): Replay {
  (window as unknown as { timeline: Timeline }).timeline = tl; // handy in the console
  const frames = createRaidFrames(tl.actors, tl.abilities);
  const summary = h("span", { class: "muted small" });
  let selected: number | null = tl.healers.find((p) => p.name === opts.selectedHealer)?.id ?? null;
  let now = 0;
  let lastTick = -1;

  const panels = createHealerPanels({
    healers: tl.healers,
    players: new Map(tl.actors.map((p) => [p.id, p])),
    actorNames: opts.actorNames,
    abilities: tl.abilities,
    onSelect: (id) => {
      select(id);
      opts.onSelectHealer?.(id === null ? null : tl.healers.find((p) => p.id === id)!.name);
    },
  });

  function select(id: number | null) {
    selected = id;
    panels.setSelected(id);
    frames.markHealer(id);
    drawHealers(now);
  }

  // Healer panels + target highlight follow the exact playback time (smooth cast bars);
  // frames only redraw when the 100 ms tick changes.
  function drawHealers(t: number) {
    const states = tl.healers.map((p) => tl.healerData.at(p.id, t));
    panels.update(states);
    const cast = selected !== null ? states.find((s) => s.id === selected)?.cast : null;
    frames.highlight(cast?.targetID ?? null, cast ? `${cast.abilityID}@${cast.start}` : "");
  }

  const playback: Playback = createPlayback({
    durationMs: tl.durationMs,
    stepMs: tl.tickMs,
    markers: tl.deaths.map((d) => ({ t: d.t, label: `${d.name} died` })),
    onTime: (t) => {
      now = t;
      const tick = Math.floor(t / tl.tickMs);
      if (tick !== lastTick) {
        lastTick = tick;
        const state = tl.at(t);
        frames.update(state);
        summary.textContent = `${state.alive}/${tl.actors.length} alive · raid HP ${(state.raidPct * 100).toFixed(0)}%`;
      }
      drawHealers(t);
    },
  });
  select(selected);

  return {
    el: h("div", { class: "replay" },
      playback.el,
      summary,
      h("div", { class: "replay-body" },
        frames.el,
        tl.healers.length ? panels.el : h("p", { class: "muted" }, "No healers detected in this fight."),
      ),
    ),
    dispose: () => playback.dispose(),
  };
}
