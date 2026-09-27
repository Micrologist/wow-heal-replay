// Fetch a fight's event streams (or read them from the cache) into one FightData.

import type { FightStore } from "./cache.ts";
import { FIGHT_STREAMS } from "./streams.ts";
import type { EventPage, FightData, Report, ReportFight } from "./types.ts";
import type { WclClient } from "./WclClient.ts";

export interface LoadProgress {
  /** 0..1 across all streams; each stream counts equally and advances by event timestamp. */
  fraction: number;
  label: string;
}

export function reportHeader(report: Report): FightData["report"] {
  const { code, title, startTime, endTime, zone, masterData } = report;
  return { code, title, startTime, endTime, zone, masterData };
}

export async function fetchFightData(
  client: WclClient,
  report: Report,
  fight: ReportFight,
  onProgress?: (p: LoadProgress) => void,
): Promise<FightData> {
  const steps = FIGHT_STREAMS.length + 1;
  const duration = Math.max(1, fight.endTime - fight.startTime);
  onProgress?.({ fraction: 0, label: "Summary" });
  const summaryTable = await client.summaryTable(report.code, fight.id, fight.startTime, fight.endTime);

  const events: FightData["events"] = {};
  for (const [i, { dataType, hostilityType }] of FIGHT_STREAMS.entries()) {
    const step = i + 1;
    onProgress?.({ fraction: step / steps, label: dataType });
    const pages = await client.eventPages(
      { code: report.code, fightID: fight.id, dataType, hostilityType, startTime: fight.startTime, endTime: fight.endTime },
      (page) => {
        const reached = page.nextPageTimestamp ?? fight.endTime;
        const within = Math.min(1, Math.max(0, (reached - fight.startTime) / duration));
        onProgress?.({ fraction: (step + within) / steps, label: dataType });
      },
    );
    events[dataType] = flattenPages(pages);
  }
  onProgress?.({ fraction: 1, label: "done" });
  return { code: report.code, report: reportHeader(report), fight, summaryTable, events, fetchedAt: Date.now() };
}

export function flattenPages(pages: EventPage[]): FightData["events"][string] {
  return pages.flatMap((p) => p.data);
}

/** Cached fights cost no API points; freshly fetched ones are stored for next time. */
export async function loadFightData(opts: {
  /** Only needed on a cache miss. */
  client: WclClient | null;
  store: FightStore;
  report: Report;
  fight: ReportFight;
  onProgress?: (p: LoadProgress) => void;
}): Promise<{ data: FightData; fromCache: boolean }> {
  const cached = await opts.store.getFight(opts.report.code, opts.fight.id);
  if (cached) return { data: cached, fromCache: true };
  if (!opts.client) throw new Error("This fight isn't cached: save your WCL API client to fetch it.");
  const data = await fetchFightData(opts.client, opts.report, opts.fight, opts.onProgress);
  await opts.store.putFight(data);
  return { data, fromCache: false };
}

/** A `npm run wcl -- dump` fixture as FightData (tests, and loading a dump into the app). */
export function fightDataFromDump(dump: {
  report: Report;
  fight: ReportFight;
  summaryTable: unknown;
  events: Record<string, EventPage[]>;
  meta: { code: string; dumpedAt: string };
}): FightData {
  const events: FightData["events"] = {};
  for (const [k, pages] of Object.entries(dump.events)) events[k] = flattenPages(pages);
  return {
    code: dump.meta.code,
    report: reportHeader(dump.report),
    fight: dump.fight,
    summaryTable: dump.summaryTable,
    events,
    fetchedAt: Date.parse(dump.meta.dumpedAt),
  };
}
