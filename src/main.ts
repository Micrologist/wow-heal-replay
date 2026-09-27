// Milestone 0c smoke page: load a fight through the shared WclClient in the browser and print
// the same event counts `npm run wcl -- dump` records in a fixture's meta block.

import { createBrowserClient, loadCredentials, saveCredentials, type WclCredentials } from "./api/browser.ts";
import { parseReportRef } from "./api/reportUrl.ts";
import { DIFFICULTY, FIGHT_STREAMS } from "./api/streams.ts";
import type { Report, ReportFight } from "./api/types.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let creds: WclCredentials | null = loadCredentials();

function showCredsStatus() {
  $("credsStatus").textContent = creds ? `saved (${creds.clientId.slice(0, 8)}…)` : "not set";
  if (creds) $<HTMLInputElement>("clientId").value = creds.clientId;
}
showCredsStatus();

$("creds").addEventListener("submit", (ev) => {
  ev.preventDefault();
  creds = { clientId: $<HTMLInputElement>("clientId").value.trim(), clientSecret: $<HTMLInputElement>("clientSecret").value.trim() };
  saveCredentials(creds);
  $<HTMLInputElement>("clientSecret").value = "";
  showCredsStatus();
});
$("forget").addEventListener("click", () => {
  creds = null;
  saveCredentials(null);
  $<HTMLInputElement>("clientId").value = "";
  showCredsStatus();
});

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function showError(target: HTMLElement, err: unknown) {
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = err instanceof Error ? err.message : String(err);
  target.append(p);
}

$("load").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fightsEl = $("fights");
  fightsEl.hidden = false;
  fightsEl.replaceChildren();
  $("result").hidden = true;
  if (!creds) return showError(fightsEl, "Save your WCL client id and secret first.");

  let ref;
  try {
    ref = parseReportRef($<HTMLInputElement>("report").value);
  } catch (err) {
    return showError(fightsEl, err);
  }
  $("loadStatus").textContent = "loading…";
  try {
    const client = createBrowserClient(creds);
    const report = await client.report(ref.code);
    $("loadStatus").textContent = "";
    renderFights(report, ref.code);
    const preselected = ref.fightID !== undefined && report.fights.find((f) => f.id === ref.fightID);
    if (preselected) void loadFight(report, ref.code, preselected);
  } catch (err) {
    $("loadStatus").textContent = "";
    showError(fightsEl, err);
  }
});

function renderFights(report: Report, code: string) {
  const el = $("fights");
  const h = document.createElement("h2");
  h.textContent = `${report.title} — ${report.masterData.actors.length} actors`;
  el.append(h);
  for (const f of report.fights.filter((f) => f.encounterID)) {
    const btn = document.createElement("button");
    btn.className = "fight";
    const left = document.createElement("span");
    left.textContent = `#${f.id} ${f.name} (${DIFFICULTY[f.difficulty ?? 0] ?? f.difficulty})`;
    const right = document.createElement("span");
    right.className = f.kill ? "kill" : "wipe";
    right.textContent = `${f.kill ? "kill" : `wipe ${f.bossPercentage}%`} · ${fmtDuration(f.endTime - f.startTime)}`;
    btn.append(left, right);
    btn.addEventListener("click", () => void loadFight(report, code, f));
    el.append(btn);
  }
}

async function loadFight(report: Report, code: string, fight: ReportFight) {
  const el = $("result");
  el.hidden = false;
  el.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = `#${fight.id} ${fight.name} — ${fight.kill ? "kill" : "wipe"}, ${fmtDuration(fight.endTime - fight.startTime)}`;
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>dataType</th><th class="num">pages</th><th class="num">events</th></tr></thead><tbody></tbody>`;
  const status = document.createElement("p");
  status.className = "muted";
  el.append(h, table, status);
  const tbody = table.querySelector("tbody")!;

  const client = createBrowserClient(creds!);
  const counts: Record<string, number> = {};
  try {
    const before = await client.rateLimit();
    for (const { dataType, hostilityType } of FIGHT_STREAMS) {
      const row = tbody.insertRow();
      row.insertCell().textContent = dataType;
      const pagesCell = row.insertCell();
      const eventsCell = row.insertCell();
      pagesCell.className = eventsCell.className = "num";
      let events = 0;
      const pages = await client.eventPages(
        { code, fightID: fight.id, dataType, hostilityType, startTime: fight.startTime, endTime: fight.endTime },
        (page, i) => {
          events += page.data.length;
          pagesCell.textContent = String(i + 1);
          eventsCell.textContent = events.toLocaleString("en-US");
        },
      );
      counts[dataType] = events;
      pagesCell.textContent = String(pages.length);
    }
    const after = await client.rateLimit();
    status.textContent = `points spent: ${(after.pointsSpentThisHour - before.pointsSpentThisHour).toFixed(1)}; now ${after.pointsSpentThisHour.toFixed(1)}/${after.limitPerHour}`;
    console.log("eventCounts", JSON.stringify(counts));
  } catch (err) {
    showError(el, err);
  }
}
