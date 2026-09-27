// Turn client errors into something a user can act on.

import { WclError } from "../api/WclClient.ts";

export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/invalid_client|Client authentication failed/i.test(msg)) return "Warcraft Logs rejected the client ID / secret. Check them under “API client”.";
  if (err instanceof WclError && err.status === 429) return `Warcraft Logs is rate-limiting this API client. ${msg.replace(/^.*?retry after/i, "Try again in")}.`;
  if (/not found \(private or bad code\?\)/.test(msg)) return "Report not found. It may be private (only public reports work) or the code is wrong.";
  if (err instanceof TypeError) return `Network error talking to Warcraft Logs: ${msg}`;
  return msg;
}
