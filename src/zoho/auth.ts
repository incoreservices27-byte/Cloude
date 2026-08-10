/**
 * Zoho OAuth 2.0 access-token management.
 *
 * The connector stores only a long-lived refresh token. Access tokens live for
 * an hour, so they are minted on demand and cached in memory until shortly
 * before expiry. Refreshes are de-duplicated: concurrent tool calls that all
 * find an expired token share a single network round-trip.
 */

import type { DataCenter } from '../config.js';

/** Refresh this many ms before the token actually expires, to absorb clock skew. */
const EXPIRY_SKEW_MS = 60_000;

export class ZohoAuthError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'ZohoAuthError';
    this.code = code;
    this.hint = hint;
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  api_domain?: string;
  token_type?: string;
  error?: string;
}

/** Maps Zoho's terse OAuth error codes onto something a user can act on. */
const AUTH_ERROR_HINTS: Readonly<Record<string, string>> = Object.freeze({
  invalid_client:
    'ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET do not match a client in this data center. ' +
    'Confirm ZOHO_DC matches the region where you registered the client.',
  invalid_code:
    'The refresh token was rejected. Re-run `npm run auth` to mint a new one — ' +
    'refresh tokens are revoked when the client secret is regenerated or the grant is removed.',
  invalid_grant:
    'The refresh token is expired or revoked. Re-run `npm run auth` to mint a new one.',
  invalid_client_secret: 'ZOHO_CLIENT_SECRET is wrong. Copy it again from the Zoho API console.',
  access_denied: 'The Zoho account denied this grant. Re-authorize with `npm run auth`.',
});

export interface TokenManagerOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  dataCenter: DataCenter;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  now?: () => number;
}

export class TokenManager {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #refreshToken: string;
  readonly #dataCenter: DataCenter;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  #accessToken: string | undefined;
  #expiresAt = 0;
  #inFlight: Promise<string> | undefined;

  constructor(options: TokenManagerOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#refreshToken = options.refreshToken;
    this.#dataCenter = options.dataCenter;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  get tokenUrl(): string {
    return `https://${this.#dataCenter.accountsHost}/oauth/v2/token`;
  }

  /** Returns a valid access token, refreshing only when the cached one is stale. */
  async getAccessToken(): Promise<string> {
    if (this.#accessToken && this.#now() < this.#expiresAt) {
      return this.#accessToken;
    }
    // Collapse concurrent refreshes onto one request.
    this.#inFlight ??= this.#refresh().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  /** Drops the cached token so the next call re-mints one. */
  invalidate(): void {
    this.#accessToken = undefined;
    this.#expiresAt = 0;
  }

  async #refresh(): Promise<string> {
    const body = new URLSearchParams({
      refresh_token: this.#refreshToken,
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
      grant_type: 'refresh_token',
    });

    let response: Response;
    try {
      response = await this.#fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new ZohoAuthError(
        'network_error',
        `Could not reach ${this.tokenUrl}: ${reason}`,
        'Check network access and that ZOHO_DC names the right region.',
      );
    }

    const text = await response.text();
    let payload: TokenResponse;
    try {
      payload = JSON.parse(text) as TokenResponse;
    } catch {
      throw new ZohoAuthError(
        'invalid_response',
        `Token endpoint returned non-JSON (HTTP ${response.status}): ${truncate(text, 200)}`,
      );
    }

    // Zoho reports OAuth failures as HTTP 200 with an `error` field, so the
    // status code alone is not enough to decide success.
    if (payload.error) {
      throw new ZohoAuthError(
        payload.error,
        `Zoho rejected the token refresh: ${payload.error}`,
        AUTH_ERROR_HINTS[payload.error],
      );
    }
    if (!response.ok) {
      throw new ZohoAuthError(
        `http_${response.status}`,
        `Token endpoint returned HTTP ${response.status}: ${truncate(text, 200)}`,
      );
    }
    if (!payload.access_token) {
      throw new ZohoAuthError(
        'no_access_token',
        `Token endpoint returned no access_token: ${truncate(text, 200)}`,
      );
    }

    const lifetimeMs = (payload.expires_in ?? 3600) * 1000;
    this.#accessToken = payload.access_token;
    this.#expiresAt = this.#now() + Math.max(lifetimeMs - EXPIRY_SKEW_MS, 0);
    return payload.access_token;
  }
}

/**
 * Builds the consent URL a user visits to authorize the connector.
 * `access_type=offline` with `prompt=consent` is what makes Zoho return a
 * refresh token rather than an access token alone.
 */
export function buildAuthorizeUrl(options: {
  dataCenter: DataCenter;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state?: string;
}): string {
  const url = new URL(`https://${options.dataCenter.accountsHost}/oauth/v2/auth`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('scope', options.scopes.join(','));
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (options.state) url.searchParams.set('state', options.state);
  return url.toString();
}

/** Exchanges a one-time authorization code for a refresh token. */
export async function exchangeCodeForTokens(options: {
  dataCenter: DataCenter;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<{ refreshToken: string; accessToken: string; expiresIn: number }> {
  const doFetch = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    code: options.code,
  });

  const response = await doFetch(`https://${options.dataCenter.accountsHost}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const text = await response.text();
  let payload: TokenResponse & { refresh_token?: string };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ZohoAuthError(
      'invalid_response',
      `Token endpoint returned non-JSON (HTTP ${response.status}): ${truncate(text, 200)}`,
    );
  }

  if (payload.error) {
    throw new ZohoAuthError(
      payload.error,
      `Zoho rejected the code exchange: ${payload.error}`,
      AUTH_ERROR_HINTS[payload.error],
    );
  }
  if (!payload.refresh_token) {
    throw new ZohoAuthError(
      'no_refresh_token',
      'Zoho returned no refresh_token. The authorization code was likely already used, ' +
        'or the consent screen was opened without access_type=offline.',
      'Re-run the flow and complete it in one pass — codes are single-use and expire in ~1 minute.',
    );
  }

  return {
    refreshToken: payload.refresh_token,
    accessToken: payload.access_token ?? '',
    expiresIn: payload.expires_in ?? 3600,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
