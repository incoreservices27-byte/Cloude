/**
 * Configuration and Zoho data-center resolution.
 *
 * Zoho is region-sharded: an account created in the EU cannot be reached through
 * the US hosts, and an OAuth token minted at one accounts host is only valid
 * against that region's API host. Everything therefore hangs off a data centre.
 */

export interface DataCenter {
  /** Short key used in config, e.g. "eu". */
  readonly key: string;
  /** Human label for error messages. */
  readonly label: string;
  /** OAuth authorize/token host. */
  readonly accountsHost: string;
  /** Mail REST API host. */
  readonly apiHost: string;
  /** Developer console where the OAuth client is registered. */
  readonly consoleUrl: string;
}

export const DATA_CENTERS: Readonly<Record<string, DataCenter>> = Object.freeze({
  us: {
    key: 'us',
    label: 'United States (.com)',
    accountsHost: 'accounts.zoho.com',
    apiHost: 'mail.zoho.com',
    consoleUrl: 'https://api-console.zoho.com',
  },
  eu: {
    key: 'eu',
    label: 'Europe (.eu)',
    accountsHost: 'accounts.zoho.eu',
    apiHost: 'mail.zoho.eu',
    consoleUrl: 'https://api-console.zoho.eu',
  },
  in: {
    key: 'in',
    label: 'India (.in)',
    accountsHost: 'accounts.zoho.in',
    apiHost: 'mail.zoho.in',
    consoleUrl: 'https://api-console.zoho.in',
  },
  au: {
    key: 'au',
    label: 'Australia (.com.au)',
    accountsHost: 'accounts.zoho.com.au',
    apiHost: 'mail.zoho.com.au',
    consoleUrl: 'https://api-console.zoho.com.au',
  },
  jp: {
    key: 'jp',
    label: 'Japan (.jp)',
    accountsHost: 'accounts.zoho.jp',
    apiHost: 'mail.zoho.jp',
    consoleUrl: 'https://api-console.zoho.jp',
  },
  ca: {
    key: 'ca',
    label: 'Canada (.zohocloud.ca)',
    accountsHost: 'accounts.zohocloud.ca',
    apiHost: 'mail.zohocloud.ca',
    consoleUrl: 'https://api-console.zohocloud.ca',
  },
  sa: {
    key: 'sa',
    label: 'Saudi Arabia (.sa)',
    accountsHost: 'accounts.zoho.sa',
    apiHost: 'mail.zoho.sa',
    consoleUrl: 'https://api-console.zoho.sa',
  },
  uk: {
    key: 'uk',
    label: 'United Kingdom (.uk)',
    accountsHost: 'accounts.zoho.uk',
    apiHost: 'mail.zoho.uk',
    consoleUrl: 'https://api-console.zoho.uk',
  },
});

/** Aliases people actually type, mapped onto the canonical keys above. */
const DC_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  com: 'us',
  usa: 'us',
  'zoho.com': 'us',
  'zoho.eu': 'eu',
  europe: 'eu',
  'zoho.in': 'in',
  india: 'in',
  'com.au': 'au',
  'zoho.com.au': 'au',
  australia: 'au',
  'zoho.jp': 'jp',
  japan: 'jp',
  'zohocloud.ca': 'ca',
  canada: 'ca',
  'zoho.sa': 'sa',
  'zoho.uk': 'uk',
});

export function resolveDataCenter(input: string | undefined): DataCenter {
  // An empty or whitespace-only value means "unset" — `ZOHO_DC=` in a .env file
  // should fall back to the default, not fail startup.
  const raw = (input ?? '').trim().toLowerCase().replace(/^\./, '') || 'us';
  const key = DC_ALIASES[raw] ?? raw;
  const dc = DATA_CENTERS[key];
  if (!dc) {
    const valid = Object.keys(DATA_CENTERS).join(', ');
    throw new Error(`Unknown Zoho data center "${input}". Expected one of: ${valid}.`);
  }
  return dc;
}

export interface Config {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly dataCenter: DataCenter;
  /** Pin the connector to one mailbox; otherwise the first account is used. */
  readonly accountId?: string;
  /** When true, no mutating tools are registered at all. */
  readonly readOnly: boolean;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * Load `.env` from the current working directory if one exists. Callers that
 * manage their own environment (Claude Desktop, systemd) are unaffected.
 */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // No .env file, or unreadable — environment variables are the source of truth.
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Run \`npm run auth\` to generate credentials, or see SETUP.md.`,
    );
  }
  return value;
}

export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): Config {
  return {
    clientId: required('ZOHO_CLIENT_ID'),
    clientSecret: required('ZOHO_CLIENT_SECRET'),
    refreshToken: required('ZOHO_REFRESH_TOKEN'),
    dataCenter: resolveDataCenter(process.env.ZOHO_DC),
    accountId: process.env.ZOHO_ACCOUNT_ID?.trim() || undefined,
    readOnly: parseBoolean(process.env.ZOHO_MAIL_READ_ONLY, false),
    timeoutMs: parsePositiveInt(process.env.ZOHO_TIMEOUT_MS, 30_000),
  };
}

/**
 * The OAuth scopes this connector needs. `.ALL` covers read+write for a scope
 * family; the read-only build still requests the same set because Zoho ties
 * scopes to the refresh token, not to individual calls — the `readOnly` flag is
 * enforced locally by not registering mutating tools.
 */
export const OAUTH_SCOPES = [
  'ZohoMail.accounts.READ',
  'ZohoMail.folders.READ',
  'ZohoMail.messages.ALL',
  'ZohoMail.attachments.READ',
] as const;

export const READ_ONLY_SCOPES = [
  'ZohoMail.accounts.READ',
  'ZohoMail.folders.READ',
  'ZohoMail.messages.READ',
  'ZohoMail.attachments.READ',
] as const;
