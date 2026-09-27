import { describe, expect, it } from "vitest";
import { fightDataFromDump } from "../api/fightData.ts";
import type { FightData, RawEvent } from "../api/types.ts";
import { fixtureFiles, loadDump } from "../test/fixtures.ts";
import { collectHealthSamples } from "./health.ts";
import { buildTimeline, STALE_MS } from "./timeline.ts";

// ---- synthetic fight: one player (id 1), one enemy (id 99), fight starts at 1_000_000 ----
const T0 = 1_000_000;
function fight(events: Record<string, RawEvent[]>, durationMs = 60_000): FightData {
  return {
    code: "test",
    report: {
      code: "test", title: "t", startTime: 0, endTime: 0, zone: null,
      masterData: {
        actors: [
          { id: 1, gameID: 0, name: "Healbot", type: "Player", subType: "Paladin", server: null, petOwner: null, icon: "" },
          { id: 99, gameID: 0, name: "Boss", type: "NPC", subType: "Boss", server: null, petOwner: null, icon: "" },
        ],
        abilities: [],
      },
    },
    fight: { id: 1, encounterID: 1, name: "Boss", difficulty: 5, kill: true, bossPercentage: 0, fightPercentage: 0, startTime: T0, endTime: T0 + durationMs, friendlyPlayers: [1], size: 20 },
    summaryTable: { data: { composition: [{ id: 1, specs: [{ spec: "Holy", role: "healer" }] }] } },
    events,
    fetchedAt: 0,
  };
}
const dmg = (t: number, hp: number, extra: Partial<RawEvent> = {}): RawEvent =>
  ({ timestamp: T0 + t, type: "damage", sourceID: 99, targetID: 1, resourceActor: 2, hitPoints: hp, maxHitPoints: 1000, absorb: 0, ...extra });
const death = (t: number): RawEvent => ({ timestamp: T0 + t, type: "death", sourceID: -1, targetID: 1 });
const hp = (tl: ReturnType<typeof buildTimeline>, t: number) => tl.at(t).actors[0];

describe("health samples", () => {
  it("attribute the snapshot by resourceActor: 1 = source, 2 = target, absent = none", () => {
    const data = fight({
      DamageTaken: [dmg(100, 700)],
      Casts: [{ timestamp: T0 + 200, type: "cast", sourceID: 1, targetID: 99, resourceActor: 1, hitPoints: 650, maxHitPoints: 1000 }],
      Healing: [
        { timestamp: T0 + 300, type: "heal", sourceID: 1, targetID: 99, resourceActor: 2, hitPoints: 5, maxHitPoints: 10 }, // boss's HP: ignored
        { timestamp: T0 + 400, type: "heal", sourceID: 1, targetID: 1, hitPoints: 999, maxHitPoints: 1000 }, // no resourceActor: no sample
      ],
    });
    expect(collectHealthSamples(data, new Set([1])).get(1)!.map((s) => [s.t, s.hp])).toEqual([[100, 700], [200, 650]]);
  });
});

describe("timeline (synthetic)", () => {
  it("starts full, then holds the last sample between samples", () => {
    const tl = buildTimeline(fight({ DamageTaken: [dmg(1_000, 600), dmg(5_000, 300)] }));
    expect(hp(tl, 0)).toMatchObject({ hp: 1000, pct: 1, dead: false });
    expect(hp(tl, 999).hp).toBe(1000);
    expect(hp(tl, 1_000).hp).toBe(600);
    expect(hp(tl, 4_999).hp).toBe(600); // no interpolation
    expect(hp(tl, 5_050).hp).toBe(300);
  });

  it("death → 0 and dead until a later positive sample (resurrect)", () => {
    const tl = buildTimeline(fight({
      DamageTaken: [dmg(1_000, 0), dmg(1_010, 50) /* stale snapshot after the killing blow */, dmg(20_000, 400)],
      Deaths: [death(1_005)],
    }));
    expect(hp(tl, 900).dead).toBe(false);
    expect(hp(tl, 1_100)).toMatchObject({ hp: 0, dead: true });
    expect(hp(tl, 19_900)).toMatchObject({ hp: 0, dead: true, stale: false }); // dead is never stale
    expect(hp(tl, 20_000)).toMatchObject({ hp: 400, dead: false });
    expect(tl.deaths).toEqual([expect.objectContaining({ t: 1_005, actorID: 1, name: "Healbot" })]);
  });

  it("a positive sample in the same ms as the death does not revive", () => {
    const tl = buildTimeline(fight({ DamageTaken: [dmg(2_000, 300)], Deaths: [death(2_000)] }));
    expect(hp(tl, 2_000)).toMatchObject({ hp: 0, dead: true });
  });

  it("flags alive actors with no sample for more than 10 s as stale", () => {
    const tl = buildTimeline(fight({ DamageTaken: [dmg(1_000, 800), dmg(30_000, 700)] }));
    expect(hp(tl, 1_000 + STALE_MS).stale).toBe(false);
    expect(hp(tl, 1_100 + STALE_MS)).toMatchObject({ stale: true, hp: 800 });
    expect(hp(tl, 30_000).stale).toBe(false);
  });

  it("clamps t to the fight and snaps to the tick", () => {
    const tl = buildTimeline(fight({}, 1_050));
    expect(tl.tickCount).toBe(11);
    expect(tl.at(-5).t).toBe(0);
    expect(tl.at(123).t).toBe(100);
    expect(tl.at(99_999).t).toBe(1_000);
  });
});

// ---- fixtures ----
// Dead at the end of the fight, derived by hand from the Deaths stream + later samples (resurrects).
const DEAD_AT_END: Record<string, number> = {
  "nek-zali-the-soulcoiler-368AMJNcyTLkrPvz-15.json.gz": 20, // wipe: everyone
  "nek-zali-the-soulcoiler-368AMJNcyTLkrPvz-16.json.gz": 0, // Bigpew died at 235.7 s, battle-rezzed 4.5 s later
  "the-lost-explorers-t7Jz29RwvfQhYKLg-38.json.gz": 20,
  "the-lost-explorers-t7Jz29RwvfQhYKLg-40.json.gz": 13, // 15 deaths; Bigpew died twice, Earthwaker was rezzed
};

describe.each(fixtureFiles())("timeline of %s", (file) => {
  const data = fightDataFromDump(loadDump(file));
  const started = performance.now();
  const tl = buildTimeline(data);
  const buildMs = performance.now() - started;
  const end = tl.at(tl.durationMs);

  it("builds quickly and covers the whole fight", () => {
    expect(buildMs).toBeLessThan(2_000);
    expect(tl.tickCount).toBe(Math.floor(tl.durationMs / 100) + 1);
    expect(tl.actors).toHaveLength(data.fight.friendlyPlayers!.length);
  });

  it("starts with everyone alive at full health", () => {
    const start = tl.at(0);
    expect(start.alive).toBe(tl.actors.length);
    expect(start.actors.every((a) => a.pct === 1 && !a.stale)).toBe(true);
  });

  it("marks every death, and has the expected number dead at the end", () => {
    for (const d of tl.deaths) {
      const s = tl.at(d.t + 100).actors.find((a) => a.id === d.actorID)!;
      expect(s.dead || tl.at(d.t + 100).t > tl.durationMs, `${d.name} at ${d.t}`).toBe(true);
      expect(s.hp).toBe(0);
    }
    expect(DEAD_AT_END[file], `add ${file} to DEAD_AT_END`).toBeDefined();
    expect(tl.actors.length - end.alive).toBe(DEAD_AT_END[file]);
  });

  it("shows each sampled HP value from the first tick at or after it, until the next sample", () => {
    const ids = new Set(tl.actors.map((a) => a.id));
    const samples = collectHealthSamples(data, ids);
    let checked = 0;
    for (const [id, list] of samples) {
      const idx = tl.actors.findIndex((a) => a.id === id);
      for (let i = 0; i < list.length; i += 97) {
        const s = list[i];
        const tickT = Math.ceil(s.t / 100) * 100;
        const overwritten = list.some((o, j) => j > i && o.t <= tickT);
        const state = tl.at(tickT).actors[idx];
        if (overwritten || state.dead || s.hp === 0 || s.hp > s.maxHp) continue;
        expect(state.hp).toBe(s.hp);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("keeps HP within [0, maxHp] and raid HP within [0, 1]", () => {
    for (let t = 0; t <= tl.durationMs; t += 1_000) {
      const s = tl.at(t);
      expect(s.raidPct).toBeGreaterThanOrEqual(0);
      expect(s.raidPct).toBeLessThanOrEqual(1);
      for (const a of s.actors) expect(a.pct >= 0 && a.pct <= 1).toBe(true);
    }
  });
});
