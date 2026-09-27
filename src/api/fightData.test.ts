import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { fixtureFiles, loadDump, type Request, wclFromDump } from "../test/fixtures.ts";
import { IdbFightStore, MemoryFightStore } from "./cache.ts";
import { fightDataFromDump, loadFightData, type LoadProgress } from "./fightData.ts";
import { WclClient } from "./WclClient.ts";

const dump = loadDump(fixtureFiles()[0]);

describe("loadFightData", () => {
  it("fetches every stream once, then serves the fight from the cache with no requests", async () => {
    const requests: Request[] = [];
    const client = new WclClient(wclFromDump(dump, requests), async () => "tok");
    const store = new MemoryFightStore();
    const progress: LoadProgress[] = [];

    const first = await loadFightData({ client, store, report: dump.report, fight: dump.fight, onProgress: (p) => progress.push(p) });
    expect(first.fromCache).toBe(false);
    for (const [k, n] of Object.entries(dump.meta.eventCounts)) expect(first.data.events[k]).toHaveLength(n);
    expect(first.data).toMatchObject(fightDataFromDump(dump) && { code: dump.meta.code, fight: dump.fight, summaryTable: dump.summaryTable });

    const fractions = progress.map((p) => p.fraction);
    expect(fractions.at(-1)).toBe(1);
    expect(fractions.every((f, i) => i === 0 || f >= fractions[i - 1])).toBe(true);

    const fetched = requests.length;
    const second = await loadFightData({ client, store, report: dump.report, fight: dump.fight });
    expect(second.fromCache).toBe(true);
    expect(requests.length).toBe(fetched);
  });
});

describe("IdbFightStore", () => {
  it("round-trips fights and reports, keyed by (code, fightID)", async () => {
    const store = await IdbFightStore.open(indexedDB, `test-${Math.random()}`);
    const data = fightDataFromDump(dump);

    expect(await store.getFight(data.code, data.fight.id)).toBeUndefined();
    await store.putFight(data);
    await store.putFight({ ...data, code: "otherReport" });

    const back = await store.getFight(data.code, data.fight.id);
    expect(back?.events.Healing.length).toBe(dump.meta.eventCounts.Healing);
    expect(await store.cachedFightIDs(data.code)).toEqual([data.fight.id]);

    await store.deleteFight(data.code, data.fight.id);
    expect(await store.cachedFightIDs(data.code)).toEqual([]);

    await store.putReport(dump.report);
    expect((await store.getReport(dump.report.code))?.report.fights.length).toBe(dump.report.fights.length);
  });
});
