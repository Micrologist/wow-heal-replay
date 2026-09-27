// Raid frames, Ellesmere-style: groups of 5 in columns, dark compact frames, class-coloured fill.
// State-driven: `update(state)` draws whatever TimelineState it is given (a replayed tick today,
// a simulated one later — CLAUDE.md §9). Never reads raw events.

import classColors from "../../data/classColors.json";
import type { Player } from "../../model/roster.ts";
import type { TimelineState } from "../../model/timeline.ts";
import { h } from "../dom.ts";

const COLORS = classColors as Record<string, string>;
export const GROUP_SIZE = 5;

export interface RaidFrames {
  el: HTMLElement;
  update(state: TimelineState): void;
}

/** WCL doesn't give raid subgroups (that needs CombatantInfo), so groups are filled in roster
 * order: tanks, healers, dps — like raid frames sorted by role. */
export function groupPlayers<T>(players: T[], size = GROUP_SIZE): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < players.length; i += size) groups.push(players.slice(i, i + size));
  return groups;
}

export function createRaidFrames(players: Player[]): RaidFrames {
  const frames = new Map<number, { root: HTMLElement; fill: HTMLElement; status: HTMLElement; last: string }>();
  const columns = groupPlayers(players).map((group, gi) =>
    h("div", { class: "rf-group", "aria-label": `Group ${gi + 1}` }, ...group.map((p) => {
      const fill = h("div", { class: "rf-fill", style: { background: COLORS[p.className] ?? "#888" } });
      const status = h("span", { class: "rf-status" });
      const root = h("div", { class: "rf-frame", title: `${p.name} — ${p.spec ?? ""} ${p.className}`.trim() },
        fill, h("span", { class: "rf-name" }, p.name), status);
      frames.set(p.id, { root, fill, status, last: "" });
      return root;
    })));

  return {
    el: h("div", { class: "raid-frames" }, ...columns),
    update(state) {
      for (const a of state.actors) {
        const f = frames.get(a.id);
        if (!f) continue;
        const pct = a.dead ? 0 : a.pct;
        const key = `${a.dead}|${a.stale}|${pct.toFixed(3)}`;
        if (key === f.last) continue; // most frames don't change on most ticks
        f.last = key;
        f.fill.style.transform = `scaleX(${pct})`;
        f.root.classList.toggle("dead", a.dead);
        f.root.classList.toggle("stale", a.stale && !a.dead);
        f.status.textContent = a.dead ? "Dead" : a.stale ? "?" : "";
      }
    },
  };
}
