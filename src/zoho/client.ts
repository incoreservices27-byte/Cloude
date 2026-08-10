/**
 * Thin HTTP client for the Zoho Mail REST API.
 *
 * Zoho wraps every response in `{ status: { code, description }, data: ... }`
 * and authenticates with a `Zoho-oauthtoken` (not `Bearer`) authorization
 * header. Both quirks are handled here so the tool layer only ever sees
 * unwrapped `data` or a thrown `ZohoApiError`.
 */

import type { DataCenter } from '../config.js';
import { TokenManager, ZohoAuthError } from './auth.js';

export class ZohoApiError extends Error {
  readonly httpStatus: number;
  readonly zohoCode: string | undefined;
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { httpStatus: number; zohoCode?: string; hint?: string },
  ) {
    super(message);
    this.name = 'ZohoApiError';
    this.httpStatus = options.httpStatus;
    this.zohoCode = options.zohoCode;
    this.hint = options.hint;
  }
}

/** Guidance for the failures users actually hit, keyed by HTTP status. */
const STATUS_HINTS: Readonly<Record<number, string>> = Object.freeze({
  400: 'The request was malformed — check folder/message IDs, they are opaque strings from a list call.',
  401: 'The access token was rejected. If this persists, re-run `npm run auth`.',
  403: 'The token lacks the scope for this call, or the mailbox is not permitted. ' +
    'Re-authorize with the scopes listed in SETUP.md.',
  404: 'No such account, folder, or message in this mailbox. IDs are region-specific — ' +
    'confirm ZOHO_DC matches the account.',
  405: 'Method not allowed for this endpoint.',
  413: 'Payload too large — Zoho caps message size, attach via upload instead of inline content.',
  429: 'Zoho rate limit hit. Wait before retrying; limits are per-account per-minute.',
  500: 'Zoho reported an internal error. Retry shortly.',
});

export interface ZohoEnvelope<T> {
  status?: { code?: number; description?: string };
  data?: T;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface ZohoMailClientOptions {
  tokenManager: TokenManager;
  dataCenter: DataCenter;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ZohoMailClient {
  readonly #tokens: TokenManager;
  readonly #dataCenter: DataCenter;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ZohoMailClientOptions) {
    this.#tokens = options.tokenManager;
    this.#dataCenter = options.dataCenter;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get baseUrl(): string {
    return `https://${this.#dataCenter.apiHost}/api`;
  }

  /** Performs a request and returns the unwrapped `data` payload. */
  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.#send(path, options);
    const text = await response.text();

    let parsed: ZohoEnvelope<T> | undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as ZohoEnvelope<T>;
      } catch {
        if (!response.ok) {
          throw new ZohoApiError(
            `Zoho returned HTTP ${response.status} with a non-JSON body: ${truncate(text, 300)}`,
            { httpStatus: response.status, hint: STATUS_HINTS[response.status] },
          );
        }
        // A 2xx non-JSON body is a legitimate raw payload (e.g. RFC822 source).
        return text as unknown as T;
      }
    }

    if (!response.ok) {
      throw new ZohoApiError(describeFailure(response.status, parsed, text), {
        httpStatus: response.status,
        zohoCode: parsed?.status?.code !== undefined ? String(parsed.status.code) : undefined,
        hint: STATUS_HINTS[response.status],
      });
    }

    return (parsed?.data ?? parsed ?? null) as T;
  }

  /** Performs a request and returns the raw bytes — used for attachment downloads. */
  async requestBinary(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await this.#send(path, options);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ZohoApiError(describeFailure(response.status, undefined, text), {
        httpStatus: response.status,
        hint: STATUS_HINTS[response.status],
      });
    }
    const buffer = await response.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async #send(path: string, options: RequestOptions): Promise<Response> {
    const url = this.#buildUrl(path, options.query);
    const method = options.method ?? 'GET';

    // One retry on 401: the cached token may have been revoked server-side
    // before its nominal expiry.
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#tokens.getAccessToken();
      const headers: Record<string, string> = {
        Authorization: `Zoho-oauthtoken ${token}`,
        Accept: 'application/json',
      };
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }

      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        if (cause instanceof ZohoAuthError) throw cause;
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new ZohoApiError(`Request to ${url} failed: ${reason}`, {
          httpStatus: 0,
          hint: 'Network or timeout error. Check connectivity to ' + this.#dataCenter.apiHost + '.',
        });
      }

      if (response.status === 401 && attempt === 0) {
        this.#tokens.invalidate();
        continue;
      }
      return response;
    }

    /* c8 ignore next */
    throw new ZohoApiError('Unreachable: retry loop exhausted', { httpStatus: 0 });
  }

  #buildUrl(path: string, query: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

function describeFailure(
  httpStatus: number,
  parsed: ZohoEnvelope<unknown> | undefined,
  rawText: string,
): string {
  const description = parsed?.status?.description;
  const code = parsed?.status?.code;
  if (description) {
    return `Zoho Mail API error (HTTP ${httpStatus}${code !== undefined ? `, code ${code}` : ''}): ${description}`;
  }
  return `Zoho Mail API error (HTTP ${httpStatus}): ${truncate(rawText, 300) || 'no response body'}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
