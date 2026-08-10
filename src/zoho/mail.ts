/**
 * Typed wrappers over the Zoho Mail REST endpoints used by this connector,
 * plus the name→ID resolution that lets tools accept "Inbox" instead of a
 * 16-digit folder ID.
 *
 * Responses are normalised before they leave this module: Zoho returns dozens
 * of fields per message and dumping them raw into a model's context is mostly
 * waste, so each shape keeps the fields a mail assistant actually reasons over.
 */

import { ZohoApiError, type ZohoMailClient } from './client.js';

/** Zoho caps a single list/search page; asking for more silently truncates. */
export const MAX_PAGE_SIZE = 200;

export interface ZohoAccount {
  accountId: string;
  accountName?: string;
  primaryEmailAddress?: string;
  mailboxAddress?: string;
  sendMailDetails?: Array<{
    sendMailId?: string;
    fromAddress?: string;
    displayName?: string;
    default?: boolean | string;
    validated?: boolean | string;
  }>;
}

export interface AccountSummary {
  accountId: string;
  accountName: string | undefined;
  primaryEmailAddress: string | undefined;
  fromAddresses: string[];
  defaultFromAddress: string | undefined;
}

export interface ZohoFolder {
  folderId: string;
  folderName?: string;
  path?: string;
  folderType?: string;
  unreadCount?: number | string;
  messageCount?: number | string;
  parentFolderId?: string;
}

export interface FolderSummary {
  folderId: string;
  name: string | undefined;
  path: string | undefined;
  type: string | undefined;
  unreadCount: number | undefined;
  totalCount: number | undefined;
}

export interface ZohoMessage {
  messageId?: string;
  folderId?: string;
  threadId?: string;
  fromAddress?: string;
  toAddress?: string;
  ccAddress?: string;
  bccAddress?: string;
  sender?: string;
  subject?: string;
  summary?: string;
  status?: string;
  status2?: string;
  hasAttachment?: string | boolean;
  priority?: string;
  size?: string | number;
  receivedTime?: string | number;
  sentDateInGMT?: string | number;
  flagid?: string;
}

export interface MessageSummary {
  messageId: string | undefined;
  folderId: string | undefined;
  threadId: string | undefined;
  from: string | undefined;
  to: string | undefined;
  cc: string | undefined;
  subject: string | undefined;
  snippet: string | undefined;
  isUnread: boolean | undefined;
  hasAttachment: boolean;
  receivedAt: string | undefined;
  sizeBytes: number | undefined;
}

export type UpdateMode =
  | 'markAsRead'
  | 'markAsUnread'
  | 'moveMessage'
  | 'flag'
  | 'archive'
  | 'unArchive'
  | 'spam'
  | 'notSpam';

export interface SendMailInput {
  fromAddress: string;
  toAddress: string;
  ccAddress?: string;
  bccAddress?: string;
  subject?: string;
  content?: string;
  mailFormat?: 'html' | 'plaintext';
  askReceipt?: boolean;
  /** Present only for drafts. */
  mode?: 'draft';
}

/** Cache entries live briefly — folder lists change, but not mid-conversation. */
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class ZohoMailApi {
  readonly #client: ZohoMailClient;
  readonly #pinnedAccountId: string | undefined;
  readonly #now: () => number;

  #accountsCache: CacheEntry<ZohoAccount[]> | undefined;
  #folderCache = new Map<string, CacheEntry<ZohoFolder[]>>();

  constructor(client: ZohoMailClient, options: { accountId?: string; now?: () => number } = {}) {
    this.#client = client;
    this.#pinnedAccountId = options.accountId;
    this.#now = options.now ?? Date.now;
  }

  /** Clears cached accounts and folders — exposed for tests and long-lived servers. */
  clearCache(): void {
    this.#accountsCache = undefined;
    this.#folderCache.clear();
  }

  async listAccounts(): Promise<ZohoAccount[]> {
    if (this.#accountsCache && this.#now() < this.#accountsCache.expiresAt) {
      return this.#accountsCache.value;
    }
    const data = await this.#client.request<ZohoAccount[] | ZohoAccount>('/accounts');
    const accounts = Array.isArray(data) ? data : data ? [data] : [];
    this.#accountsCache = { value: accounts, expiresAt: this.#now() + CACHE_TTL_MS };
    return accounts;
  }

  /**
   * Resolves the account to operate on: an explicit argument wins, then the
   * `ZOHO_ACCOUNT_ID` pin, then the sole/first account on the login.
   */
  async resolveAccountId(explicit?: string): Promise<string> {
    if (explicit?.trim()) return explicit.trim();
    if (this.#pinnedAccountId) return this.#pinnedAccountId;

    const accounts = await this.listAccounts();
    const first = accounts[0];
    if (!first?.accountId) {
      throw new ZohoApiError('No Zoho Mail accounts are visible to this token.', {
        httpStatus: 404,
        hint: 'The token may be scoped to an organization without a mailbox. ' +
          'Check ZohoMail.accounts.READ was granted.',
      });
    }
    return first.accountId;
  }

  async listFolders(accountId: string): Promise<ZohoFolder[]> {
    const cached = this.#folderCache.get(accountId);
    if (cached && this.#now() < cached.expiresAt) return cached.value;

    const data = await this.#client.request<ZohoFolder[]>(`/accounts/${enc(accountId)}/folders`);
    const folders = Array.isArray(data) ? data : [];
    this.#folderCache.set(accountId, { value: folders, expiresAt: this.#now() + CACHE_TTL_MS });
    return folders;
  }

  /**
   * Accepts a folder ID, a folder name ("Inbox"), or a path ("/Clients/Acme")
   * and returns the ID. Names are matched case-insensitively.
   */
  async resolveFolderId(accountId: string, folderRef: string): Promise<string> {
    const ref = folderRef.trim();
    if (!ref) throw new ZohoApiError('Folder reference is empty.', { httpStatus: 400 });

    const folders = await this.listFolders(accountId);

    // Zoho folder IDs are long numeric strings; treat an exact ID hit as final.
    if (/^\d+$/.test(ref)) {
      const byId = folders.find((f) => String(f.folderId) === ref);
      if (byId) return String(byId.folderId);
      // Unknown numeric ref may still be a valid ID from a stale cache — pass through.
      return ref;
    }

    const needle = ref.toLowerCase().replace(/^\//, '');
    const byName = folders.find((f) => f.folderName?.toLowerCase() === needle);
    if (byName) return String(byName.folderId);

    const byPath = folders.find(
      (f) => f.path?.toLowerCase().replace(/^\//, '') === needle,
    );
    if (byPath) return String(byPath.folderId);

    const available = folders
      .map((f) => f.folderName)
      .filter(Boolean)
      .slice(0, 25)
      .join(', ');
    throw new ZohoApiError(`No folder named "${folderRef}" in this mailbox.`, {
      httpStatus: 404,
      hint: available ? `Available folders: ${available}` : undefined,
    });
  }

  async listMessages(
    accountId: string,
    params: {
      folderId?: string;
      limit?: number;
      start?: number;
      status?: 'unread' | 'read' | 'all';
      sortorder?: boolean;
    } = {},
  ): Promise<ZohoMessage[]> {
    const query: Record<string, string | number | boolean | undefined> = {
      folderId: params.folderId,
      limit: clampLimit(params.limit),
      start: params.start && params.start > 0 ? params.start : undefined,
    };
    // Zoho only understands the filter for unread/read; "all" means omit it.
    if (params.status && params.status !== 'all') query.status = params.status;
    if (params.sortorder !== undefined) query.sortorder = params.sortorder;

    const data = await this.#client.request<ZohoMessage[]>(
      `/accounts/${enc(accountId)}/messages/view`,
      { query },
    );
    return Array.isArray(data) ? data : [];
  }

  async searchMessages(
    accountId: string,
    params: { searchKey: string; limit?: number; start?: number; folderId?: string },
  ): Promise<ZohoMessage[]> {
    const data = await this.#client.request<ZohoMessage[]>(
      `/accounts/${enc(accountId)}/messages/search`,
      {
        query: {
          searchKey: params.searchKey,
          limit: clampLimit(params.limit),
          start: params.start && params.start > 0 ? params.start : undefined,
          folderId: params.folderId,
        },
      },
    );
    return Array.isArray(data) ? data : [];
  }

  async getMessageContent(
    accountId: string,
    folderId: string,
    messageId: string,
  ): Promise<{ content?: string; subject?: string; [key: string]: unknown }> {
    return this.#client.request(
      `/accounts/${enc(accountId)}/folders/${enc(folderId)}/messages/${enc(messageId)}/content`,
    );
  }

  async getOriginalMessage(accountId: string, messageId: string): Promise<unknown> {
    return this.#client.request(
      `/accounts/${enc(accountId)}/messages/${enc(messageId)}/originalmessage`,
    );
  }

  async getAttachmentInfo(
    accountId: string,
    folderId: string,
    messageId: string,
  ): Promise<unknown> {
    return this.#client.request(
      `/accounts/${enc(accountId)}/folders/${enc(folderId)}/messages/${enc(messageId)}/attachmentinfo`,
    );
  }

  async sendMail(accountId: string, input: SendMailInput): Promise<unknown> {
    return this.#client.request(`/accounts/${enc(accountId)}/messages`, {
      method: 'POST',
      body: input,
    });
  }

  /** Reply / reply-all / forward, threaded onto an existing message. */
  async replyToMessage(
    accountId: string,
    messageId: string,
    input: SendMailInput & { action: 'reply' | 'replyall' | 'forward' },
  ): Promise<unknown> {
    return this.#client.request(`/accounts/${enc(accountId)}/messages/${enc(messageId)}`, {
      method: 'POST',
      body: input,
    });
  }

  async updateMessages(
    accountId: string,
    params: { mode: UpdateMode; messageIds: string[]; destfolderId?: string },
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      mode: params.mode,
      messageId: params.messageIds,
    };
    if (params.destfolderId) body.destfolderId = params.destfolderId;

    return this.#client.request(`/accounts/${enc(accountId)}/updatemessage`, {
      method: 'PUT',
      body,
    });
  }
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

export function summarizeAccount(account: ZohoAccount): AccountSummary {
  const details = account.sendMailDetails ?? [];
  const fromAddresses = details
    .map((d) => d.fromAddress)
    .filter((a): a is string => Boolean(a));
  const preferred = details.find((d) => d.default === true || d.default === 'true');

  return {
    accountId: String(account.accountId),
    accountName: account.accountName,
    primaryEmailAddress: account.primaryEmailAddress ?? account.mailboxAddress,
    fromAddresses,
    defaultFromAddress:
      preferred?.fromAddress ?? fromAddresses[0] ?? account.primaryEmailAddress,
  };
}

export function summarizeFolder(folder: ZohoFolder): FolderSummary {
  return {
    folderId: String(folder.folderId),
    name: folder.folderName,
    path: folder.path,
    type: folder.folderType,
    unreadCount: toNumber(folder.unreadCount),
    totalCount: toNumber(folder.messageCount),
  };
}

export function summarizeMessage(message: ZohoMessage): MessageSummary {
  return {
    messageId: message.messageId,
    folderId: message.folderId,
    threadId: message.threadId,
    from: message.fromAddress ?? message.sender,
    to: message.toAddress,
    cc: message.ccAddress || undefined,
    subject: message.subject,
    snippet: message.summary?.trim() || undefined,
    isUnread: readStatusToUnread(message.status),
    hasAttachment: message.hasAttachment === '1' || message.hasAttachment === true,
    receivedAt: toIsoDate(message.receivedTime ?? message.sentDateInGMT),
    sizeBytes: toNumber(message.size),
  };
}

/**
 * Zoho encodes read state in `status`: "0" is unread, "1" is read. Anything
 * else (absent, or a value from an endpoint that omits it) is reported as
 * unknown rather than guessed.
 */
export function readStatusToUnread(status: string | undefined): boolean | undefined {
  if (status === '0') return true;
  if (status === '1') return false;
  return undefined;
}

export function toIsoDate(value: string | number | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function clampLimit(limit: number | undefined, fallback = 20): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

/** Zoho IDs are opaque; encode them so a stray slash cannot rewrite the path. */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}
