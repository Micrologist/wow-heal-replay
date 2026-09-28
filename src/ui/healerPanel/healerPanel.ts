// One panel per healer (CLAUDE.md §6.2, cooldown rows come in Milestone 6):
// header (name, spec, HPS, mana), now casting (icon, spell → target, cast bar), recent heals.
// Click a panel to select that healer: the replay highlights their cast target on the frames.

import classColors from "../../data/classColors.json";
import { type CastState, type HealerState, MAX_RECENT_HEALS } from "../../model/healers.ts";
import type { Player } from "../../model/roster.ts";
import type { Ability } from "../../model/timeline.ts";
import { h } from "../dom.ts";
import { iconUrl } from "../frames/raidFrames.ts";

const COLORS = classColors as Record<string, string>;

export function fmtAmount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export interface HealerPanels {
  el: HTMLElement;
  update(states: HealerState[]): void;
  setSelected(id: number | null): void;
}

interface Panel {
  root: HTMLElement;
  hps: HTMLElement;
  manaFill: HTMLElement;
  castIcon: HTMLImageElement;
  castText: HTMLElement;
  castFill: HTMLElement;
  castRow: HTMLElement;
  feed: HTMLElement;
  rows: FeedRow[];
  lastCastKey: string;
  lastFeedKey: string;
}

interface FeedRow {
  li: HTMLLIElement;
  icon: HTMLImageElement;
  spell: HTMLElement;
  target: HTMLElement;
  amount: HTMLElement;
  abilityID: number;
}

/** Fixed pool of feed rows: updates change text, and swap an icon only when the spell changes. */
function feedRow(): FeedRow {
  const icon = h("img", { class: "hp-feed-icon", alt: "", draggable: false });
  const spell = h("span", { class: "hp-feed-spell" });
  const target = h("span", { class: "hp-feed-target" });
  const amount = h("span", { class: "hp-feed-amt" });
  return { li: h("li", { hidden: true }, icon, spell, " → ", target, amount), icon, spell, target, amount, abilityID: -1 };
}

export function createHealerPanels(opts: {
  healers: Player[];
  players: Map<number, Player>;
  actorNames: Map<number, string>;
  abilities: Map<number, Ability>;
  onSelect: (id: number | null) => void;
}): HealerPanels {
  const { abilities } = opts;
  let selected: number | null = null;
  const name = (id: number | null) => (id === null ? "" : opts.players.get(id)?.name ?? opts.actorNames.get(id) ?? `#${id}`);
  const color = (id: number | null) => (id === null ? "inherit" : COLORS[opts.players.get(id)?.className ?? ""] ?? "var(--muted)");
  const abilityName = (id: number) => abilities.get(id)?.name ?? `Spell ${id}`;

  const panels = new Map<number, Panel>();
  const els = opts.healers.map((p) => {
    const hps = h("span", { class: "hp-hps" });
    const manaFill = h("div", { class: "hp-mana-fill" });
    const castIcon = h("img", { class: "hp-cast-icon", alt: "", draggable: false });
    const castText = h("span", { class: "hp-cast-text" });
    const castFill = h("div", { class: "hp-cast-fill" });
    const castRow = h("div", { class: "hp-cast idle" }, castIcon, h("div", { class: "hp-cast-body" }, castText, h("div", { class: "hp-cast-bar" }, castFill)));
    const rows = Array.from({ length: MAX_RECENT_HEALS }, feedRow);
    const feed = h("ol", { class: "hp-feed" }, ...rows.map((r) => r.li));
    const root = h("section", {
      class: "hp-panel", tabIndex: 0, role: "button", "aria-pressed": "false", title: "Select: highlight this healer's targets",
      on: {
        click: () => opts.onSelect(selected === p.id ? null : p.id),
        keydown: (ev) => { if ((ev as KeyboardEvent).key === "Enter") opts.onSelect(selected === p.id ? null : p.id); },
      },
    },
      h("header", { class: "hp-head" },
        h("span", { class: "hp-name", style: { color: COLORS[p.className] ?? "inherit" } }, p.name),
        h("span", { class: "muted" }, p.spec ?? ""),
        hps),
      h("div", { class: "hp-mana" }, manaFill),
      castRow,
      feed,
    );
    panels.set(p.id, { root, hps, manaFill, castIcon, castText, castFill, castRow, feed, rows, lastCastKey: "init", lastFeedKey: "init" });
    return root;
  });

  function renderCast(pn: Panel, c: CastState | null) {
    const key = c ? `${c.abilityID}|${c.start}|${c.targetID}|${c.finished}|${c.interrupted}` : "";
    if (key !== pn.lastCastKey) {
      pn.lastCastKey = key;
      pn.castRow.className = `hp-cast ${!c ? "idle" : c.interrupted ? "interrupted" : c.finished ? "done" : "casting"}`;
      if (c) {
        const ab = abilities.get(c.abilityID);
        pn.castIcon.src = ab ? iconUrl(ab.icon) : "";
        pn.castText.replaceChildren(
          abilityName(c.abilityID),
          ...(c.targetID !== null ? [" → ", h("span", { style: { color: color(c.targetID) } }, name(c.targetID))] : []),
          ...(c.interrupted ? [h("span", { class: "muted" }, " (interrupted)")] : []),
        );
      } else {
        pn.castIcon.removeAttribute("src");
        pn.castText.textContent = "—";
      }
    }
    pn.castFill.style.transform = `scaleX(${c ? Math.min(1, c.progress) : 0})`;
  }

  function renderFeed(pn: Panel, s: HealerState) {
    const key = s.recent.map((x) => `${x.t}:${x.abilityID}:${x.targetID}`).join(",");
    if (key === pn.lastFeedKey) return;
    pn.lastFeedKey = key;
    pn.rows.forEach((row, i) => {
      const x = s.recent[i];
      row.li.hidden = !x;
      if (!x) return;
      if (row.abilityID !== x.abilityID) {
        row.abilityID = x.abilityID;
        const ab = abilities.get(x.abilityID);
        row.icon.src = ab ? iconUrl(ab.icon) : "";
        row.spell.textContent = abilityName(x.abilityID);
      }
      row.li.className = x.tick ? "tick" : "";
      row.target.textContent = name(x.targetID);
      row.target.style.color = color(x.targetID);
      row.amount.textContent = `+${fmtAmount(x.amount)}${x.overheal > 0 ? ` (${fmtAmount(x.overheal)} over)` : ""}${x.kind === "absorb" ? " absorb" : ""}`;
    });
  }

  return {
    el: h("div", { class: "healer-panels" }, ...els),
    update(states) {
      for (const s of states) {
        const pn = panels.get(s.id);
        if (!pn) continue;
        pn.hps.textContent = `${fmtAmount(s.hps)} HPS`;
        pn.manaFill.style.transform = `scaleX(${s.mana ?? 0})`;
        renderCast(pn, s.cast);
        renderFeed(pn, s);
      }
    },
    setSelected(id) {
      selected = id;
      for (const [pid, pn] of panels) {
        pn.root.classList.toggle("selected", pid === id);
        pn.root.setAttribute("aria-pressed", String(pid === id));
      }
    },
  };
}
