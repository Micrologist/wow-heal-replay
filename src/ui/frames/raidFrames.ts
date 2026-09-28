// Raid frames, Ellesmere-style: groups of 5 in columns, dark compact frames, class-coloured fill,
// absorb as a lighter segment past current HP (glow at the edge when it overshoots), up to 3
// debuff icons bottom-right with stacks and a remaining-time sweep.
// State-driven: `update(state)` draws whatever TimelineState it is given (a replayed tick today,
// a simulated one later — CLAUDE.md §9). Never reads raw events.

import classColors from "../../data/classColors.json";
import type { Player } from "../../model/roster.ts";
import { type Ability, MAX_DEBUFF_ICONS, type TimelineState } from "../../model/timeline.ts";
import { h } from "../dom.ts";

const COLORS = classColors as Record<string, string>;
export const GROUP_SIZE = 5;

export const iconUrl = (icon: string) => `https://wow.zamimg.com/images/wow/icons/large/${icon.endsWith(".jpg") ? icon : `${icon}.jpg`}`;

export interface RaidFrames {
  el: HTMLElement;
  update(state: TimelineState): void;
  /** Pulse the frame the selected healer is casting on. `key` changes per cast so the pulse
   * restarts when a new cast lands on the same target. */
  highlight(targetID: number | null, key: string): void;
  /** Mark the selected healer's own frame. */
  markHealer(id: number | null): void;
}

/** WCL doesn't give raid subgroups (that needs CombatantInfo), so groups are filled in roster
 * order: tanks, healers, dps — like raid frames sorted by role. */
export function groupPlayers<T>(players: T[], size = GROUP_SIZE): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < players.length; i += size) groups.push(players.slice(i, i + size));
  return groups;
}

interface DebuffSlot {
  root: HTMLElement;
  img: HTMLImageElement;
  sweep: HTMLElement;
  count: HTMLElement;
  abilityID: number;
}

interface Frame {
  root: HTMLElement;
  fill: HTMLElement;
  absorb: HTMLElement;
  status: HTMLElement;
  slots: DebuffSlot[];
  last: string;
}

function debuffSlot(): DebuffSlot {
  const img = h("img", { alt: "", loading: "lazy", draggable: false });
  const sweep = h("span", { class: "rf-sweep" });
  const count = h("span", { class: "rf-count" });
  return { root: h("span", { class: "rf-debuff", hidden: true }, img, sweep, count), img, sweep, count, abilityID: 0 };
}

export function createRaidFrames(players: Player[], abilities: Map<number, Ability>): RaidFrames {
  const frames = new Map<number, Frame>();
  const columns = groupPlayers(players).map((group, gi) =>
    h("div", { class: "rf-group", "aria-label": `Group ${gi + 1}` }, ...group.map((p) => {
      const fill = h("div", { class: "rf-fill", style: { background: COLORS[p.className] ?? "#888" } });
      const absorb = h("div", { class: "rf-absorb" });
      const status = h("span", { class: "rf-status" });
      const slots = Array.from({ length: MAX_DEBUFF_ICONS }, debuffSlot);
      const root = h("div", { class: "rf-frame", title: `${p.name} — ${p.spec ?? ""} ${p.className}`.trim() },
        fill, absorb, h("span", { class: "rf-name" }, p.name), status, h("div", { class: "rf-debuffs" }, ...slots.map((s) => s.root)));
      frames.set(p.id, { root, fill, absorb, status, slots, last: "" });
      return root;
    })));

  let highlighted: { id: number | null; key: string } = { id: null, key: "" };
  let markedHealer: number | null = null;

  return {
    el: h("div", { class: "raid-frames" }, ...columns),
    highlight(targetID, key) {
      if (targetID === highlighted.id && key === highlighted.key) return;
      if (highlighted.id !== null) frames.get(highlighted.id)?.root.classList.remove("targeted");
      highlighted = { id: targetID, key };
      const f = targetID !== null ? frames.get(targetID) : undefined;
      if (!f) return;
      void f.root.offsetWidth; // restart the CSS pulse
      f.root.classList.add("targeted");
    },
    markHealer(id) {
      if (markedHealer !== null) frames.get(markedHealer)?.root.classList.remove("selected-healer");
      markedHealer = id;
      if (id !== null) frames.get(id)?.root.classList.add("selected-healer");
    },
    update(state) {
      for (const a of state.actors) {
        const f = frames.get(a.id);
        if (!f) continue;
        const pct = a.dead ? 0 : a.pct;
        const shield = a.dead || a.maxHp <= 0 ? 0 : a.absorb / a.maxHp;
        const key = `${a.dead}|${a.stale}|${pct.toFixed(3)}|${shield.toFixed(3)}`;
        if (key !== f.last) {
          f.last = key;
          f.fill.style.transform = `scaleX(${pct})`;
          // lighter segment right after current HP; what doesn't fit shows as a glow at the edge
          const visible = Math.min(shield, 1 - pct);
          f.absorb.style.left = `${pct * 100}%`;
          f.absorb.style.width = `${visible * 100}%`;
          f.root.classList.toggle("overshield", shield > visible + 0.001);
          f.root.classList.toggle("dead", a.dead);
          f.root.classList.toggle("stale", a.stale && !a.dead);
          f.status.textContent = a.dead ? "Dead" : a.stale ? "?" : "";
        }
        f.slots.forEach((slot, i) => {
          const d = a.debuffs[i];
          slot.root.hidden = !d;
          if (!d) return;
          if (slot.abilityID !== d.abilityID) {
            slot.abilityID = d.abilityID;
            const ab = abilities.get(d.abilityID);
            slot.img.src = ab ? iconUrl(ab.icon) : "";
            slot.root.title = ab?.name ?? String(d.abilityID);
          }
          slot.count.textContent = d.stacks > 1 ? String(d.stacks) : "";
          slot.sweep.style.background = `conic-gradient(rgba(0,0,0,.7) ${((1 - d.remaining) * 360).toFixed(1)}deg, transparent 0)`;
        });
      }
    },
  };
}
