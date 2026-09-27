import { describe, expect, it } from "vitest";
import { fightDataFromDump } from "../api/fightData.ts";
import type { FightData, RawEvent } from "../api/types.ts";
import { fixtureFiles, loadDump } from "../test/fixtures.ts";
import { collectDebuffs, isImportant } from "./debuffs.ts";
import { buildTimeline, MAX_DEBUFF_ICONS } from "./timeline.ts";

// Player 1 (target), player 2 (friendly caster), NPC 99 (boss). Fight at T0, 60 s.
const T0 = 1_000_000;
function fight(events: Record<string, RawEvent[]>): FightData {
  const actor = (id: number, name: string, type: string, subType: string) => ({ id, gameID: 0, name, type, subType, server: null, petOwner: null, icon: "" });
  return {
    code: "t",
    report: { code: "t", title: "t", startTime: 0, endTime: 0, zone: null, masterData: {
      actors: [actor(1, "Tank", "Player", "Warrior"), actor(2, "Mage", "Player", "Mage"), actor(99, "Boss", "NPC", "Boss")],
      abilities: [{ gameID: 500, name: "Stacking Slash", icon: "a.jpg", type: "1" }],
    } },
    fight: { id: 1, encounterID: 1, name: "Boss", difficulty: 5, kill: true, bossPercentage: 0, fightPercentage: 0, startTime: T0, endTime: T0 + 60_000, friendlyPlayers: [1, 2], size: 20 },
    summaryTable: null,
    events,
    fetchedAt: 0,
  };
}
const deb = (t: number, type: string, abilityGameID: number, sourceID = 99, extra: Partial<RawEvent> = {}): RawEvent =>
  ({ timestamp: T0 + t, type, sourceID, targetID: 1, abilityGameID, ...extra });

describe("debuff intervals", () => {
  it("follow apply → stacks → refresh → remove", () => {
    const [iv] = collectDebuffs(fight({ Debuffs: [
      deb(1_000, "applydebuff", 500),
      deb(2_000, "applydebuffstack", 500, 99, { stack: 2 }),
      deb(3_000, "applydebuffstack", 500, 99, { stack: 3 }),
      deb(4_000, "refreshdebuff", 500),
      deb(9_000, "removedebuff", 500),
    ] }), new Set([1]));
    expect(iv).toMatchObject({ start: 1_000, end: 9_000, maxStacks: 3, applied: [1_000, 2_000, 3_000, 4_000], fromEnemy: true });
  });

  it("open before the pull or never removed: clamp to the fight", () => {
    const ivs = collectDebuffs(fight({ Debuffs: [deb(5_000, "removedebuff", 501), deb(50_000, "applydebuff", 502)] }), new Set([1]));
    expect(ivs.map((i) => [i.abilityID, i.start, i.end])).toEqual([[501, 0, 5_000], [502, 50_000, 60_000]]);
  });

  it("are important when from an enemy and stacking or ≥ 5 s; config overrides both ways", () => {
    const ivs = collectDebuffs(fight({ Debuffs: [
      deb(0, "applydebuff", 600), deb(6_000, "removedebuff", 600), // enemy, 6 s → yes
      deb(0, "applydebuff", 601), deb(1_000, "removedebuff", 601), // enemy, 1 s, no stacks → no
      deb(0, "applydebuff", 602, 2), deb(30_000, "removedebuff", 602, 2), // friendly source (e.g. Forbearance-like) → no
    ] }), new Set([1]));
    const imp = Object.fromEntries(ivs.map((i) => [i.abilityID, isImportant(i)]));
    expect(imp).toEqual({ 600: true, 601: false, 602: false });
    expect(isImportant(ivs.find((i) => i.abilityID === 601)!, { important: [601] })).toBe(true);
    expect(isImportant(ivs.find((i) => i.abilityID === 600)!, { ignore: [600] })).toBe(false);
  });
});

describe("timeline debuffs + absorbs (synthetic)", () => {
  it("shows stacks and the sweep of the current application", () => {
    const tl = buildTimeline(fight({ Debuffs: [
      deb(1_000, "applydebuff", 500), deb(3_000, "applydebuffstack", 500, 99, { stack: 2 }), deb(13_000, "removedebuff", 500),
    ] }));
    const at = (t: number) => tl.at(t).actors.find((a) => a.id === 1)!.debuffs;
    expect(at(500)).toEqual([]);
    expect(at(2_000)).toEqual([expect.objectContaining({ abilityID: 500, stacks: 1, from: 1_000, until: 13_000 })]);
    expect(at(8_000)[0]).toMatchObject({ stacks: 2, from: 3_000, remaining: 0.5 });
    expect(at(13_000)).toEqual([]);
    expect(tl.abilities.get(500)).toEqual({ name: "Stacking Slash", icon: "a.jpg" });
  });

  it("absorb: snapshot is the authority; a shield applied after it shows until the next snapshot", () => {
    const snap = (t: number, absorb: number): RawEvent => ({ timestamp: T0 + t, type: "damage", sourceID: 99, targetID: 1, resourceActor: 2, hitPoints: 800, maxHitPoints: 1000, absorb });
    const tl = buildTimeline(fight({
      DamageTaken: [snap(1_000, 100), snap(5_000, 250)],
      Buffs: [{ timestamp: T0 + 2_000, type: "applybuff", sourceID: 2, targetID: 1, abilityGameID: 17, absorb: 300 }],
    }));
    const absorb = (t: number) => tl.at(t).actors.find((a) => a.id === 1)!.absorb;
    expect([absorb(1_500), absorb(2_500), absorb(5_000)]).toEqual([100, 400, 250]);
  });
});

describe.each(fixtureFiles())("debuffs in %s", (file) => {
  const data = fightDataFromDump(loadDump(file));
  const tl = buildTimeline(data);
  const shown = new Map<number, number>();
  let maxIcons = 0;
  let withAbsorb = 0;
  for (let t = 0; t <= tl.durationMs; t += 500) {
    for (const a of tl.at(t).actors) {
      maxIcons = Math.max(maxIcons, a.debuffs.length);
      if (a.absorb > 0) withAbsorb++;
      for (const d of a.debuffs) {
        shown.set(d.abilityID, Math.max(shown.get(d.abilityID) ?? 0, d.stacks));
        expect(d.remaining).toBeGreaterThanOrEqual(0);
        expect(d.remaining).toBeLessThanOrEqual(1);
        expect(tl.abilities.has(d.abilityID)).toBe(true);
      }
    }
  }
  const name = (id: number) => tl.abilities.get(id)?.name;

  it("shows some boss debuffs, never more than the icon limit", () => {
    expect(shown.size).toBeGreaterThan(0);
    expect(maxIcons).toBeLessThanOrEqual(MAX_DEBUFF_ICONS);
  });

  it("never shows short one-off or friendly debuffs", () => {
    const names = [...shown.keys()].map(name);
    for (const noise of ["Aftershock", "Forbearance", "Light of the Martyr", "Hypothermia", "Resurrecting"]) expect(names).not.toContain(noise);
  });

  if (file.includes("lost-explorers")) {
    it("shows the Lost Explorers stacking mechanics with their stacks", () => {
      const byName = Object.fromEntries([...shown].map(([id, n]) => [name(id), n]));
      expect(byName["Splinters"]).toBeGreaterThanOrEqual(2);
      expect(byName["Steady Strikes"]).toBeGreaterThan(10);
    });
  }

  it("has absorb shields on frames a good part of the time", () => {
    expect(withAbsorb).toBeGreaterThan(100);
  });
});
