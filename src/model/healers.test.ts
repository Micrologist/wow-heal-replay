import { describe, expect, it } from "vitest";
import { fightDataFromDump } from "../api/fightData.ts";
import type { FightData, RawEvent } from "../api/types.ts";
import { fixtureFiles, loadDump } from "../test/fixtures.ts";
import { collectCasts } from "./casts.ts";
import { buildHealers, INSTANT_FLASH_MS } from "./healers.ts";
import { healers } from "./roster.ts";
import { buildRoster } from "./roster.ts";

// Healer 1 (Paladin) with totem 5, target 2, boss 99. Fight at T0, 60 s.
const T0 = 1_000_000;
function fight(events: Record<string, RawEvent[]>): FightData {
  const actor = (id: number, name: string, type: string, subType: string, petOwner: number | null = null) => ({ id, gameID: 0, name, type, subType, server: null, petOwner, icon: "" });
  return {
    code: "t",
    report: { code: "t", title: "t", startTime: 0, endTime: 0, zone: null, masterData: {
      actors: [actor(1, "Healer", "Player", "Paladin"), actor(2, "Tank", "Player", "Warrior"), actor(5, "Totem", "Pet", "Pet", 1), actor(99, "Boss", "NPC", "Boss")],
      abilities: [],
    } },
    fight: { id: 1, encounterID: 1, name: "Boss", difficulty: 5, kill: true, bossPercentage: 0, fightPercentage: 0, startTime: T0, endTime: T0 + 60_000, friendlyPlayers: [1, 2], size: 20 },
    summaryTable: null,
    events,
    fetchedAt: 0,
  };
}
const ev = (t: number, type: string, abilityGameID: number, extra: Partial<RawEvent> = {}): RawEvent =>
  ({ timestamp: T0 + t, type, sourceID: 1, targetID: -1, abilityGameID, ...extra });

describe("casts", () => {
  const casts = (events: RawEvent[]) =>
    collectCasts(fight({ Casts: events }), new Set([1])).map((c) => [c.abilityID, c.start, c.end, c.targetID, c.kind, c.interrupted]);

  it("pair begincast → cast and take the target from the cast", () => {
    expect(casts([ev(1_000, "begincast", 19750), ev(2_500, "cast", 19750, { targetID: 2 })])).toEqual([[19750, 1_000, 2_500, 2, "hardcast", false]]);
  });
  it("a new begincast interrupts the pending one; an off-GCD instant does not", () => {
    expect(casts([
      ev(1_000, "begincast", 100), ev(1_300, "cast", 31821), ev(1_500, "begincast", 101), ev(3_000, "cast", 101, { targetID: 2 }),
    ])).toEqual([[100, 1_000, 1_500, null, "hardcast", true], [31821, 1_300, 1_300, null, "instant", false], [101, 1_500, 3_000, 2, "hardcast", false]]);
  });
  it("a begincast → cast pair under 50 ms is an instant proc", () => {
    expect(casts([ev(1_000, "begincast", 19750), ev(1_000, "cast", 19750, { targetID: 2 })])).toEqual([[19750, 1_000, 1_000, 2, "instant", false]]);
  });
  it("skip fake (proc) casts; empower start/end is a hard cast and its echo cast isn't doubled", () => {
    expect(casts([
      ev(1_000, "cast", 369, { fake: true }),
      ev(2_000, "empowerstart", 355936), ev(3_000, "empowerend", 355936), ev(3_050, "cast", 355936),
    ])).toEqual([[355936, 2_000, 3_000, null, "hardcast", false]]);
  });
});

describe("healer state (synthetic)", () => {
  const data = fight({
    Casts: [ev(1_000, "begincast", 19750), ev(2_000, "cast", 19750, { targetID: 2 }), ev(5_000, "cast", 20473, { targetID: 2 })],
    Healing: [
      { timestamp: T0 + 2_000, type: "heal", sourceID: 1, targetID: 2, abilityGameID: 19750, amount: 1000, overheal: 200 },
      { timestamp: T0 + 3_000, type: "heal", sourceID: 5, targetID: 2, abilityGameID: 5394, amount: 500, overheal: 0, tick: true },
      { timestamp: T0 + 4_000, type: "absorbed", sourceID: 1, targetID: 2, abilityGameID: 17, amount: 300 },
      { timestamp: T0 + 4_000, type: "heal", sourceID: 2, targetID: 2, abilityGameID: 1, amount: 9999 }, // not a healer
    ],
    Resources: [{ timestamp: T0 + 1_000, type: "resourcechange", sourceID: 1, targetID: 1, resourceActor: 1, classResources: [{ type: 0, amount: 50, max: 100 }] }],
  });
  const h = buildHealers(data, [1]);

  it("shows the hard cast in progress with its eventual target", () => {
    expect(h.at(1, 1_500).cast).toMatchObject({ abilityID: 19750, targetID: 2, progress: 0.5, finished: false });
  });
  it("flashes an instant for INSTANT_FLASH_MS, then clears", () => {
    expect(h.at(1, 5_100).cast).toMatchObject({ abilityID: 20473, kind: "instant", finished: true });
    expect(h.at(1, 5_000 + INSTANT_FLASH_MS).cast).toBeNull();
  });
  it("credits pets to the owner, counts shield absorbs, lists recent heals newest first", () => {
    const s = h.at(1, 4_500);
    expect(s.healingDone).toBe(1_800);
    expect(s.recent.map((x) => [x.abilityID, x.amount, x.viaID])).toEqual([[17, 300, null], [5394, 500, 5], [19750, 1000, null]]);
    expect(h.at(1, 8_900).recent.map((x) => x.abilityID)).toEqual([17]); // 5 s window: 4.0 s in, 3.0 s out
    expect(s.mana).toBe(0.5);
    expect(h.at(1, 500).mana).toBeNull();
  });
});

describe.each(fixtureFiles())("healers in %s", (file) => {
  const data = fightDataFromDump(loadDump(file));
  const hs = healers(buildRoster(data));
  const h = buildHealers(data, hs.map((p) => p.id));
  const end = data.fight.endTime - data.fight.startTime;
  const wcl = new Map(((data.summaryTable as { data: { healingDone: { id: number; total: number }[] } }).data.healingDone).map((x) => [x.id, x.total]));

  it("healing done matches WCL's Summary table within 5%", () => {
    for (const p of hs) {
      const ratio = h.at(p.id, end).healingDone / wcl.get(p.id)!;
      expect(ratio, p.name).toBeGreaterThan(0.95);
      expect(ratio, p.name).toBeLessThan(1.05);
    }
  });

  it("every healer casts, hard casts end after they start, mana is known after the pull", () => {
    for (const p of hs) {
      const casts = h.casts(p.id);
      expect(casts.length, p.name).toBeGreaterThan(50);
      expect(casts.every((c) => c.end >= c.start && (c.kind === "instant") === (c.start === c.end) || c.kind === "hardcast")).toBe(true);
      expect(h.at(p.id, 30_000).mana, p.name).not.toBeNull();
    }
  });

  if (file.includes("lost-explorers-t7Jz29RwvfQhYKLg-40")) {
    it("Balotan (Holy Paladin): 34 Flash of Light, 32 of them instant procs; no fake casts; targets on single-target spells", () => {
      const bal = hs.find((p) => p.name === "Balotan")!;
      const casts = h.casts(bal.id);
      const byName = (n: string) => casts.filter((c) => data.report.masterData.abilities.find((a) => a.gameID === c.abilityID)?.name === n);
      expect(byName("Flash of Light")).toHaveLength(34);
      expect(byName("Flash of Light").filter((c) => c.kind === "instant")).toHaveLength(32);
      expect(byName("Reclamation")).toHaveLength(0); // fake
      expect(byName("Holy Shock").every((c) => c.targetID !== null)).toBe(true);
      expect(byName("Light of Dawn").every((c) => c.targetID === null)).toBe(true);
    });
  }
});
