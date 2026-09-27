// Client-credentials token exchange. Transport-agnostic: the caller injects fetch
// and the token URL (WCL directly, or a token-exchange worker if CORS forces one).

export type FetchImpl = typeof fetch;
export type TokenProvider = () => Promise<string>;

export const WCL_TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function exchangeClientCredentials(
  fetchImpl: FetchImpl,
  clientId: string,
  clientSecret: string,
  tokenUrl = WCL_TOKEN_URL,
): Promise<TokenResponse> {
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as TokenResponse;
}

/** Caches the token in memory and refreshes it a minute before expiry. */
export function clientCredentialsTokenProvider(
  fetchImpl: FetchImpl,
  clientId: string,
  clientSecret: string,
  tokenUrl = WCL_TOKEN_URL,
): TokenProvider & { lastResponse?: TokenResponse } {
  let token: string | undefined;
  let expiresAt = 0;
  const provider: TokenProvider & { lastResponse?: TokenResponse } = async () => {
    if (token && Date.now() < expiresAt - 60_000) return token;
    const res = await exchangeClientCredentials(fetchImpl, clientId, clientSecret, tokenUrl);
    provider.lastResponse = res;
    token = res.access_token;
    expiresAt = Date.now() + res.expires_in * 1000;
    return token;
  };
  return provider;
}
