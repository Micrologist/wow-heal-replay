// Browser transport: the user's own WCL client id + secret, kept in localStorage, token fetched
// directly from WCL (its endpoints send CORS headers for any origin — see CLAUDE.md §3).

import { clientCredentialsTokenProvider } from "./auth.ts";
import { WclClient } from "./WclClient.ts";

export interface WclCredentials {
  clientId: string;
  clientSecret: string;
}

const STORAGE_KEY = "wcl.credentials";

export function loadCredentials(): WclCredentials | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const creds = raw ? (JSON.parse(raw) as WclCredentials) : null;
    return creds?.clientId && creds.clientSecret ? creds : null;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: WclCredentials | null): void {
  try {
    if (creds) localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode etc.): credentials just last for this page view.
  }
}

export function createBrowserClient(creds: WclCredentials): WclClient {
  const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  const tokens = clientCredentialsTokenProvider(fetchImpl, creds.clientId.trim(), creds.clientSecret.trim());
  return new WclClient(fetchImpl, tokens);
}
