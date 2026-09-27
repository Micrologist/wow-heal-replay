// Node CLI for live WCL access: fixtures, paging smoke tests, schema checks. Never used by tests.
//   npm run wcl -- whoami
//   npm run wcl -- fights <code|url>
//   npm run wcl -- dump <code|url> <fightID>
//   npm run wcl -- schema

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientCredentialsTokenProvider } from "../src/api/auth.ts";
import { parseReportRef } from "../src/api/reportUrl.ts";
import type { EventDataType, EventPage, HostilityType } from "../src/api/types.ts";
import { WclClient } from "../src/api/WclClient.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every dataType from CLAUDE.md §4, all friendly-side.
const DUMP_STREAMS: { dataType: EventDataType; hostilityType: HostilityType }[] = [
  { dataType: "Healing", hostilityType: "Friendlies" },
  { dataType: "DamageTaken", hostilityType: "Friendlies" },
  { dataType: "Casts", hostilityType: "Friendlies" },
  { dataType: "Buffs", hostilityType: "Friendlies" },
  { dataType: "Debuffs", hostilityType: "Friendlies" },
  { dataType: "Deaths", hostilityType: "Friendlies" },
  { dataType: "Resources", hostilityType: "Friendlies" },
];

const DIFFICULTY: Record<number, string> = { 1: "LFR", 3: "Normal", 4: "Heroic", 5: "Mythic" };

function makeClient() {
  // Trim: pasted secrets often carry a trailing newline, which WCL rejects as invalid_client.
  const id = process.env.WCL_CLIENT_ID?.trim();
  const secret = process.env.WCL_CLIENT_SECRET?.trim();
  if (!id || !secret) {
    console.error("WCL_CLIENT_ID / WCL_CLIENT_SECRET are not set (environment secrets or .env).");
    process.exit(2);
  }
  const tokens = clientCredentialsTokenProvider(fetch, id, secret);
  return { client: new WclClient(fetch, tokens), tokens };
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function whoami() {
  const { client, tokens } = makeClient();
  await tokens();
  const expiresIn = tokens.lastResponse!.expires_in;
  console.log(`token ok: ${tokens.lastResponse!.token_type}, expires in ${expiresIn}s (~${Math.round(expiresIn / 86400)} days)`);
  const rl = await client.rateLimit();
  console.log(`rate limit: ${rl.pointsSpentThisHour}/${rl.limitPerHour} points this hour, resets in ${rl.pointsResetIn}s`);
}

async function fights(input: string) {
  const { code } = parseReportRef(input);
  const { client } = makeClient();
  const report = await client.report(code);
  console.log(`${report.title} (${report.code})${report.zone ? ` — ${report.zone.name}` : ""}`);
  console.log(`${report.masterData.actors.length} actors, ${report.masterData.abilities.length} abilities`);
  for (const f of report.fights) {
    if (!f.encounterID) continue;
    const result = f.kill ? "kill" : `wipe ${f.bossPercentage ?? "?"}%`;
    const diff = DIFFICULTY[f.difficulty ?? 0] ?? `diff ${f.difficulty}`;
    console.log(
      `  #${String(f.id).padStart(3)}  ${f.name.padEnd(28)} ${diff.padEnd(7)} ${result.padEnd(10)} ${fmtDuration(f.endTime - f.startTime).padStart(6)}  ${f.friendlyPlayers?.length ?? "?"} players`,
    );
  }
}

async function dump(input: string, fightArg: string | undefined) {
  const ref = parseReportRef(input);
  const fightID = fightArg !== undefined ? Number(fightArg) : ref.fightID;
  if (fightID === undefined || Number.isNaN(fightID)) throw new Error("usage: dump <code|url> <fightID>");
  const { client } = makeClient();

  const before = await client.rateLimit();
  const report = await client.report(ref.code);
  const fight = report.fights.find((f) => f.id === fightID);
  if (!fight) throw new Error(`fight ${fightID} not found among encounter fights of ${ref.code}`);
  console.log(`dumping #${fight.id} ${fight.name} (${fight.kill ? "kill" : "wipe"}, ${fmtDuration(fight.endTime - fight.startTime)})`);

  const summaryTable = await client.summaryTable(ref.code, fightID, fight.startTime, fight.endTime);

  const events: Record<string, EventPage[]> = {};
  const eventCounts: Record<string, number> = {};
  const pageCounts: Record<string, number> = {};
  for (const { dataType, hostilityType } of DUMP_STREAMS) {
    const key = hostilityType === "Friendlies" ? dataType : `${dataType}:${hostilityType}`;
    const pages = await client.eventPages(
      { code: ref.code, fightID, dataType, hostilityType, startTime: fight.startTime, endTime: fight.endTime },
      (page, i) => process.stdout.write(`\r  ${key.padEnd(12)} page ${i + 1} (${page.data.length} events)   `),
    );
    events[key] = pages;
    eventCounts[key] = pages.reduce((n, p) => n + p.data.length, 0);
    pageCounts[key] = pages.length;
    process.stdout.write(`\r  ${key.padEnd(12)} ${eventCounts[key]} events in ${pages.length} page(s)          \n`);
  }

  const after = await client.rateLimit();
  const pointsSpent =
    after.pointsSpentThisHour >= before.pointsSpentThisHour ? after.pointsSpentThisHour - before.pointsSpentThisHour : null; // null: hour rolled over mid-dump

  const meta = {
    code: ref.code,
    fightID,
    encounterID: fight.encounterID,
    encounterName: fight.name,
    difficulty: fight.difficulty,
    kill: fight.kill,
    bossPercentage: fight.bossPercentage,
    durationMs: fight.endTime - fight.startTime,
    actorCount: report.masterData.actors.length,
    friendlyPlayerCount: fight.friendlyPlayers?.length ?? null,
    eventCounts,
    pageCounts,
    pointsSpent,
    dumpedAt: new Date().toISOString(),
  };

  const dir = join(ROOT, "fixtures");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug(fight.name)}-${ref.code}-${fightID}.json`);
  writeFileSync(file, JSON.stringify({ meta, report, fight, summaryTable, events }) + "\n");
  console.log(`wrote ${file}`);
  console.log(`points spent: ${pointsSpent ?? "unknown (hour rolled over)"}; now ${after.pointsSpentThisHour}/${after.limitPerHour}`);
}

async function schema() {
  const { client } = makeClient();
  console.log(JSON.stringify(await client.schema(), null, 2));
}

async function main() {
  // Local runs can use a .env file; cloud sessions get the vars from environment secrets.
  const envFile = join(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "whoami":
      return whoami();
    case "fights":
      if (!args[0]) throw new Error("usage: fights <code|url>");
      return fights(args[0]);
    case "dump":
      if (!args[0]) throw new Error("usage: dump <code|url> <fightID>");
      return dump(args[0], args[1]);
    case "schema":
      return schema();
    default:
      console.error("usage: npm run wcl -- <whoami | fights <code> | dump <code> <fightID> | schema>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
