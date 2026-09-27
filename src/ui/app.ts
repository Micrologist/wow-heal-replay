// Milestone 1 app shell: credentials → report → fight list → load a fight (cached in IndexedDB).
// Nothing is replayed yet; the loaded view shows the roster and event counts.

import { createBrowserClient, loadCredentials, saveCredentials, type WclCredentials } from "../api/browser.ts";
import type { FightStore } from "../api/cache.ts";
import { loadFightData } from "../api/fightData.ts";
import { parseReportRef } from "../api/reportUrl.ts";
import { DIFFICULTY } from "../api/streams.ts";
import type { FightData, Report, ReportFight } from "../api/types.ts";
import classColors from "../data/classColors.json";
import { buildRoster, type Player, type Role } from "../model/roster.ts";
import { fmtAgo, fmtDuration, h } from "./dom.ts";
import { friendlyError } from "./errors.ts";
import { formatHash, parseHash } from "./hashState.ts";

const COLORS = classColors as Record<string, string>;

interface State {
  creds: WclCredentials | null;
  report: Report | null;
  reportFetchedAt: number | null;
  cachedIDs: Set<number>;
  selectedFight: number | null;
  /** Incremented per fight load so a slow, superseded load can't overwrite a newer one. */
  loadSeq: number;
}

export function startApp(root: HTMLElement, store: FightStore, persistentCache: boolean) {
  const state: State = { creds: loadCredentials(), report: null, reportFetchedAt: null, cachedIDs: new Set(), selectedFight: null, loadSeq: 0 };

  const credsEl = h("section", { class: "panel" });
  const reportInput = h("input", { placeholder: "https://www.warcraftlogs.com/reports/…  or a report code", required: true, autocomplete: "off" });
  const reportStatus = h("span", { class: "muted" });
  const reportForm = h("form", { class: "panel", on: { submit: (ev) => { ev.preventDefault(); void openReport(reportInput.value, false); } } },
    h("h2", null, "Report"),
    h("div", { class: "row" }, reportInput, h("button", null, "Load")),
    reportStatus,
  );
  const fightsEl = h("section", { class: "panel", hidden: true });
  const fightEl = h("section", { class: "panel", hidden: true });

  root.replaceChildren(
    h("header", null, h("h1", null, "Heal Replay"), h("span", { class: "muted" }, "Warcraft Logs healer replay")),
    credsEl, reportForm, fightsEl, fightEl,
    ...(persistentCache ? [] : [h("p", { class: "muted" }, "IndexedDB is unavailable in this browser mode: loaded fights are cached for this tab only.")]),
  );

  // ---- credentials ----
  function renderCreds(editing = !state.creds) {
    if (!editing && state.creds) {
      credsEl.replaceChildren(h("div", { class: "row" },
        h("span", null, "WCL API client "), h("code", null, `${state.creds.clientId.slice(0, 8)}…`),
        h("button", { class: "link", type: "button", on: { click: () => renderCreds(true) } }, "change"),
      ));
      return;
    }
    const id = h("input", { autocomplete: "off", required: true, value: state.creds?.clientId ?? "" });
    const secret = h("input", { type: "password", autocomplete: "off", required: true });
    credsEl.replaceChildren(h("form", { class: "stack", on: { submit: (ev) => {
      ev.preventDefault();
      state.creds = { clientId: id.value.trim(), clientSecret: secret.value.trim() };
      saveCredentials(state.creds);
      renderCreds();
      if (reportInput.value) void openReport(reportInput.value, false);
    } } },
      h("h2", null, "WCL API client"),
      h("p", { class: "muted" }, "Create one at ", h("a", { href: "https://www.warcraftlogs.com/api/clients", target: "_blank", rel: "noopener" }, "warcraftlogs.com/api/clients"),
        " (any name, any redirect URL). Stored in this browser only; requests go straight to Warcraft Logs."),
      h("label", null, "Client ID", id),
      h("label", null, "Client secret", secret),
      h("div", { class: "row" },
        h("button", null, "Save"),
        state.creds ? h("button", { type: "button", class: "secondary", on: { click: () => renderCreds(false) } }, "Cancel") : null,
        state.creds ? h("button", { type: "button", class: "secondary", on: { click: () => { state.creds = null; saveCredentials(null); renderCreds(); } } }, "Forget") : null,
      ),
    ));
  }

  // ---- report + fight list ----
  async function openReport(input: string, refresh: boolean, preselect?: number) {
    let ref;
    try {
      ref = parseReportRef(input);
    } catch (err) {
      reportStatus.textContent = friendlyError(err);
      return;
    }
    const fightID = preselect ?? ref.fightID;
    reportInput.value = ref.code;
    const cached = refresh ? undefined : await store.getReport(ref.code);
    if (cached) {
      state.report = cached.report;
      state.reportFetchedAt = cached.fetchedAt;
    } else {
      if (!state.creds) {
        reportStatus.textContent = "Save your WCL API client first.";
        renderCreds(true);
        return;
      }
      reportStatus.textContent = "Loading report…";
      try {
        state.report = await createBrowserClient(state.creds).report(ref.code);
        state.reportFetchedAt = Date.now();
        await store.putReport(state.report).catch(() => {});
      } catch (err) {
        reportStatus.textContent = friendlyError(err);
        return;
      }
    }
    reportStatus.textContent = "";
    state.cachedIDs = new Set(await store.cachedFightIDs(ref.code).catch(() => []));
    setHash({ code: ref.code, fight: fightID });
    renderFights();
    const fight = fightID !== undefined ? state.report.fights.find((f) => f.id === fightID) : undefined;
    if (fight) void openFight(fight);
    else fightEl.hidden = true;
  }

  function renderFights() {
    const report = state.report!;
    const groups = new Map<string, ReportFight[]>();
    for (const f of report.fights) {
      if (!f.encounterID) continue;
      const key = `${f.encounterID}:${f.difficulty}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    fightsEl.hidden = false;
    fightsEl.replaceChildren(
      h("div", { class: "row spread" },
        h("h2", null, report.title, report.zone && report.zone.name !== report.title ? h("span", { class: "muted" }, ` · ${report.zone.name}`) : null),
        h("span", { class: "muted small" }, `report loaded ${fmtAgo(state.reportFetchedAt!)} · `,
          h("button", { class: "link", type: "button", on: { click: () => void openReport(report.code, true, state.selectedFight ?? undefined) } }, "refresh")),
      ),
      ...(groups.size === 0 ? [h("p", { class: "muted" }, "No boss encounters in this report.")] : []),
      ...[...groups.values()].map((pulls) => h("div", { class: "encounter" },
        h("h3", null, pulls[0].name, " ", h("span", { class: "muted" }, DIFFICULTY[pulls[0].difficulty ?? 0] ?? "")),
        h("div", { class: "pulls" }, ...pulls.map((f, i) => h("button", {
          class: `pull${f.id === state.selectedFight ? " selected" : ""}`,
          type: "button",
          title: `Fight #${f.id}`,
          on: { click: () => void openFight(f) },
        },
          h("span", null, `Pull ${i + 1}`),
          h("span", { class: f.kill ? "kill" : "wipe" }, f.kill ? "Kill" : `${f.bossPercentage?.toFixed(1)}%`),
          h("span", { class: "muted" }, fmtDuration(f.endTime - f.startTime)),
          state.cachedIDs.has(f.id) ? h("span", { class: "cached", title: "Cached: opens without API points" }, "●") : null,
        ))),
      )),
    );
  }

  // ---- one fight ----
  async function openFight(fight: ReportFight) {
    const report = state.report!;
    const seq = ++state.loadSeq;
    state.selectedFight = fight.id;
    setHash({ code: report.code, fight: fight.id });
    renderFights();

    const bar = h("progress", { max: 1, value: 0 });
    const label = h("span", { class: "muted" }, "Checking cache…");
    fightEl.hidden = false;
    fightEl.replaceChildren(fightTitle(fight), h("div", { class: "stack" }, bar, label));
    fightEl.scrollIntoView({ behavior: "smooth", block: "start" });

    if (!state.cachedIDs.has(fight.id) && !state.creds) {
      label.textContent = "Save your WCL API client to fetch this fight.";
      return;
    }
    try {
      const client = state.creds ? createBrowserClient(state.creds) : null;
      const before = client && !state.cachedIDs.has(fight.id) ? await client.rateLimit().catch(() => null) : null;
      const { data, fromCache } = await loadFightData({
        client,
        store,
        report,
        fight,
        onProgress: (p) => {
          if (seq !== state.loadSeq) return;
          bar.value = p.fraction;
          label.textContent = p.label === "done" ? "Saving…" : `Fetching ${p.label}… ${Math.round(p.fraction * 100)}%`;
        },
      });
      const after = !fromCache && client ? await client.rateLimit().catch(() => null) : null;
      if (seq !== state.loadSeq) return;
      if (!fromCache) {
        state.cachedIDs.add(fight.id);
        renderFights();
      }
      renderFight(data, fromCache ? null : { spent: before && after ? after.pointsSpentThisHour - before.pointsSpentThisHour : null, now: after });
    } catch (err) {
      if (seq !== state.loadSeq) return;
      fightEl.replaceChildren(fightTitle(fight), h("p", { class: "error" }, friendlyError(err)));
    }
  }

  function fightTitle(f: ReportFight) {
    return h("h2", null, f.name, " ",
      h("span", { class: "muted" }, `${DIFFICULTY[f.difficulty ?? 0] ?? ""} · `),
      h("span", { class: f.kill ? "kill" : "wipe" }, f.kill ? "Kill" : `Wipe ${f.bossPercentage?.toFixed(1)}%`),
      h("span", { class: "muted" }, ` · ${fmtDuration(f.endTime - f.startTime)}`));
  }

  function renderFight(data: FightData, fetched: { spent: number | null; now: { pointsSpentThisHour: number; limitPerHour: number } | null } | null) {
    const roster = buildRoster(data);
    const byRole = (role: Role) => roster.filter((p) => p.role === role);
    const total = Object.values(data.events).reduce((n, e) => n + e.length, 0);
    fightEl.replaceChildren(
      fightTitle(data.fight),
      h("p", { class: "muted small" },
        fetched
          ? `Fetched from Warcraft Logs${fetched.spent !== null ? ` · ${fetched.spent.toFixed(1)} points` : ""}${fetched.now ? ` · ${fetched.now.pointsSpentThisHour.toFixed(0)}/${fetched.now.limitPerHour} this hour` : ""} · cached for next time`
          : `From cache (fetched ${fmtAgo(data.fetchedAt)}) · no API points used · `,
        fetched ? null : h("button", { class: "link", type: "button", on: { click: async () => {
          await store.deleteFight(data.code, data.fight.id);
          state.cachedIDs.delete(data.fight.id);
          renderFights();
          void openFight(data.fight);
        } } }, "re-fetch"),
      ),
      h("div", { class: "roster" },
        rosterGroup("Healers", byRole("healer"), true),
        rosterGroup("Tanks", byRole("tank")),
        rosterGroup("DPS", [...byRole("dps"), ...byRole("unknown")]),
      ),
      h("details", null,
        h("summary", null, `${total.toLocaleString("en-US")} events`),
        h("table", null, h("tbody", null, ...Object.entries(data.events).map(([k, v]) =>
          h("tr", null, h("td", null, k), h("td", { class: "num" }, v.length.toLocaleString("en-US"))))))),
      h("p", { class: "muted small" }, "Replay (raid frames, healer panels) comes in the next milestones."),
    );
  }

  function rosterGroup(title: string, players: Player[], big = false) {
    return h("div", { class: `role${big ? " healers" : ""}` },
      h("h3", null, title, h("span", { class: "muted" }, ` ${players.length}`)),
      ...players.map((p) => h("div", { class: "player" },
        h("span", { class: "name", style: { color: COLORS[p.className] ?? "inherit" } }, p.name),
        h("span", { class: "muted" }, p.spec ? `${p.spec} ${p.className.replace(/([a-z])([A-Z])/g, "$1 $2")}` : p.className),
      )),
    );
  }

  function setHash(s: { code: string; fight?: number }) {
    const hash = formatHash(s);
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname);
  }

  // ---- boot ----
  renderCreds();
  const initial = parseHash(location.hash);
  if (initial.code) void openReport(initial.code, false, initial.fight);
  window.addEventListener("hashchange", () => {
    const s = parseHash(location.hash);
    if (s.code && (s.code !== state.report?.code || s.fight !== state.selectedFight)) void openReport(s.code, false, s.fight);
  });
}
