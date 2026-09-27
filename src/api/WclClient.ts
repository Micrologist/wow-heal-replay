// Transport-agnostic WCL v2 client. Browser and Node inject their own fetch + token source;
// the query strings and the paging loop live here, once.

import type { FetchImpl, TokenProvider } from "./auth.ts";
import { EVENTS_QUERY, RATE_LIMIT_QUERY, REPORT_QUERY, SCHEMA_QUERY, SUMMARY_TABLE_QUERY } from "./queries.ts";
import type { EventDataType, EventPage, HostilityType, RateLimitData, Report } from "./types.ts";

export const WCL_API_URL = "https://www.warcraftlogs.com/api/v2/client";
export const EVENTS_PAGE_LIMIT = 10000;
const MAX_RETRY_WAIT_MS = 30_000;

export class WclError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
  }
}

export interface EventsRequest {
  code: string;
  fightID: number;
  dataType: EventDataType;
  hostilityType?: HostilityType;
  startTime: number;
  endTime: number;
}

export interface WclClientOptions {
  apiUrl?: string;
  /** Retries on HTTP 429 before giving up. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class WclClient {
  private readonly apiUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly fetchImpl: FetchImpl,
    private readonly tokenProvider: TokenProvider,
    opts: WclClientOptions = {},
  ) {
    this.apiUrl = opts.apiUrl ?? WCL_API_URL;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = await this.tokenProvider();
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(this.apiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
        // Long Retry-After means an hourly/IP block, not a burst: fail fast instead of hanging.
        if (attempt >= this.maxRetries || waitMs > MAX_RETRY_WAIT_MS) {
          throw new WclError(`rate limited (HTTP 429), retry after ${Math.round(waitMs / 1000)}s`, 429);
        }
        await this.sleep(waitMs);
        continue;
      }
      const text = await res.text();
      let body: { data?: T; errors?: { message: string }[] } | undefined;
      try {
        body = JSON.parse(text);
      } catch {
        throw new WclError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, text);
      }
      if (!res.ok || body?.errors?.length || !body?.data) {
        const msg = body?.errors?.map((e) => e.message).join("; ") || text.slice(0, 300);
        throw new WclError(`HTTP ${res.status}: ${msg}`, res.status, body);
      }
      return body.data;
    }
  }

  async rateLimit(): Promise<RateLimitData> {
    return (await this.query<{ rateLimitData: RateLimitData }>(RATE_LIMIT_QUERY)).rateLimitData;
  }

  async report(code: string): Promise<Report> {
    const data = await this.query<{ reportData: { report: Report | null } }>(REPORT_QUERY, { code });
    if (!data.reportData.report) throw new WclError(`report ${code} not found (private or bad code?)`);
    return data.reportData.report;
  }

  async summaryTable(code: string, fightID: number, startTime: number, endTime: number): Promise<unknown> {
    const data = await this.query<{ reportData: { report: { table: unknown } } }>(SUMMARY_TABLE_QUERY, {
      code, fightIDs: [fightID], startTime, endTime,
    });
    return data.reportData.report.table;
  }

  async schema(): Promise<unknown> {
    return this.query(SCHEMA_QUERY);
  }

  /** Fetches every page of one dataType, following nextPageTimestamp until null. Pages are returned untouched. */
  async eventPages(req: EventsRequest, onPage?: (page: EventPage, index: number) => void): Promise<EventPage[]> {
    const pages: EventPage[] = [];
    let startTime: number | null = req.startTime;
    while (startTime !== null) {
      const data: { reportData: { report: { events: EventPage } } } = await this.query(EVENTS_QUERY, {
        code: req.code,
        fightIDs: [req.fightID],
        dataType: req.dataType,
        hostilityType: req.hostilityType ?? "Friendlies",
        startTime,
        endTime: req.endTime,
        limit: EVENTS_PAGE_LIMIT,
      });
      const page = data.reportData.report.events;
      pages.push(page);
      onPage?.(page, pages.length - 1);
      if (page.nextPageTimestamp !== null && page.nextPageTimestamp <= startTime) {
        throw new WclError(`paging did not advance (${startTime} → ${page.nextPageTimestamp})`);
      }
      startTime = page.nextPageTimestamp;
    }
    return pages;
  }
}
