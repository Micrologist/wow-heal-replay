// Test helpers: load gzipped `wcl dump` fixtures and serve them through a mocked fetch.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { EventPage, Report, ReportFight } from "../api/types.ts";

export const FIXTURES_DIR = join(import.meta.dirname, "../../fixtures");

export interface Dump {
  meta: { code: string; fightID: number; dumpedAt: string; eventCounts: Record<string, number>; pageCounts: Record<string, number> };
  report: Report;
  fight: ReportFight;
  summaryTable: unknown;
  events: Record<string, EventPage[]>;
}

export const fixtureFiles = (): string[] => readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json.gz")).sort();

const cache = new Map<string, Dump>();
export function loadDump(file: string): Dump {
  if (!cache.has(file)) cache.set(file, JSON.parse(gunzipSync(readFileSync(join(FIXTURES_DIR, file))).toString("utf8")));
  return cache.get(file)!;
}

export interface Request { query: string; variables: Record<string, unknown> }

/** A fetch that answers the WCL token + GraphQL endpoints from a dump, recording every GraphQL request. */
export function wclFromDump(dump: Dump, requests: Request[] = []): typeof fetch {
  const json = (body: unknown) => new Response(JSON.stringify(body));
  return (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/oauth/token")) return json({ access_token: "tok", token_type: "Bearer", expires_in: 3600 });
    const req = JSON.parse(init.body as string) as Request;
    requests.push(req);
    const v = req.variables;
    if (req.query.includes("rateLimitData")) return json({ data: { rateLimitData: { limitPerHour: 3600, pointsSpentThisHour: 0, pointsResetIn: 3600 } } });
    if (req.query.includes("masterData")) return json({ data: { reportData: { report: dump.report } } });
    if (req.query.includes("table(")) return json({ data: { reportData: { report: { table: dump.summaryTable } } } });
    const pages = dump.events[v.dataType as string];
    const i = pages.findIndex((_, i) => (i === 0 ? dump.fight.startTime : pages[i - 1].nextPageTimestamp) === v.startTime);
    if (i < 0) return json({ errors: [{ message: `unexpected startTime ${v.startTime} for ${v.dataType}` }] });
    return json({ data: { reportData: { report: { events: pages[i] } } } });
  }) as typeof fetch;
}
