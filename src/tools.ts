/**
 * MCP tool surface for Zoho Mail.
 *
 * Tools take human-friendly arguments (folder names, plain addresses) and do
 * the ID resolution internally, because the model calling them has only seen
 * what previous tool results showed it.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ZohoAuthError } from './zoho/auth.js';
import { ZohoApiError } from './zoho/client.js';
import {
  clampLimit,
  summarizeAccount,
  summarizeFolder,
  summarizeMessage,
  type UpdateMode,
  type ZohoMailApi,
} from './zoho/mail.js';
import { htmlToText, looksLikeHtml, truncateBody } from './util/text.js';

export interface ToolDeps {
  api: ZohoMailApi;
  readOnly: boolean;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const DEFAULT_BODY_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok(payload: unknown): ToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }] };
}

function fail(error: unknown): ToolResult {
  let text: string;
  if (error instanceof ZohoApiError || error instanceof ZohoAuthError) {
    const hint = error.hint ? `\n\nHint: ${error.hint}` : '';
    text = `${error.message}${hint}`;
  } else if (error instanceof Error) {
    text = error.message;
  } else {
    text = String(error);
  }
  return { content: [{ type: 'text', text }], isError: true };
}

/** Wraps a handler so a thrown Zoho error becomes a readable tool error. */
function handler<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (error) {
      return fail(error);
    }
  };
}

/** Comma-joins address input accepted as either a string or a list. */
function joinAddresses(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const joined = list
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(',');
  return joined || undefined;
}

/**
 * Built fresh per field on purpose: reusing one zod instance makes the emitted
 * JSON Schema collapse into `$ref` pointers, which some MCP clients do not
 * resolve. A distinct instance per field keeps every schema self-contained.
 */
const addressSchema = (description: string) =>
  z.union([z.string(), z.array(z.string())]).describe(description);

const accountIdSchema = () =>
  z
    .string()
    .optional()
    .describe('Zoho account ID. Omit to use the default mailbox on this login.');

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, deps: ToolDeps): void {
  registerReadTools(server, deps);
  if (!deps.readOnly) {
    registerWriteTools(server, deps);
  }
}

function registerReadTools(server: McpServer, { api }: ToolDeps): void {
  server.registerTool(
    'list_accounts',
    {
      title: 'List Zoho mailboxes',
      description:
        'List the Zoho Mail accounts this connection can access, with their account IDs and ' +
        'the addresses each one is allowed to send from. Call this first if you need an ' +
        'account ID or a valid from-address.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async () => {
      const accounts = await api.listAccounts();
      return ok({
        count: accounts.length,
        accounts: accounts.map(summarizeAccount),
      });
    }),
  );

  server.registerTool(
    'list_folders',
    {
      title: 'List mail folders',
      description:
        'List folders in a Zoho mailbox with unread and total message counts. Use this to ' +
        'discover folder names and IDs before listing or moving mail.',
      inputSchema: { account_id: accountIdSchema() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async ({ account_id }: { account_id?: string }) => {
      const accountId = await api.resolveAccountId(account_id);
      const folders = await api.listFolders(accountId);
      return ok({
        accountId,
        count: folders.length,
        folders: folders.map(summarizeFolder),
      });
    }),
  );

  server.registerTool(
    'list_emails',
    {
      title: 'List emails in a folder',
      description:
        'List email headers from a folder, newest first. Returns subjects, senders, dates and ' +
        'message IDs — not bodies. Use get_email to read one. Defaults to the Inbox.',
      inputSchema: {
        account_id: accountIdSchema(),
        folder: z
          .string()
          .optional()
          .describe('Folder name (e.g. "Inbox", "Sent") or folder ID. Defaults to "Inbox".'),
        limit: z
          .number()
          .int()
          .optional()
          .describe('How many messages to return (1-200). Default 20.'),
        start: z
          .number()
          .int()
          .optional()
          .describe('1-based offset for paging through older messages.'),
        status: z
          .enum(['unread', 'read', 'all'])
          .optional()
          .describe('Filter by read state. Default "all".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(
      async (args: {
        account_id?: string;
        folder?: string;
        limit?: number;
        start?: number;
        status?: 'unread' | 'read' | 'all';
      }) => {
        const accountId = await api.resolveAccountId(args.account_id);
        const folderId = await api.resolveFolderId(accountId, args.folder ?? 'Inbox');
        const messages = await api.listMessages(accountId, {
          folderId,
          limit: args.limit,
          start: args.start,
          status: args.status,
        });
        return ok({
          accountId,
          folderId,
          folder: args.folder ?? 'Inbox',
          count: messages.length,
          limit: clampLimit(args.limit),
          messages: messages.map(summarizeMessage),
        });
      },
    ),
  );

  server.registerTool(
    'search_emails',
    {
      title: 'Search emails',
      description:
        'Search the mailbox. `query` accepts Zoho search syntax such as ' +
        '`entire:invoice`, `from:alice@example.com`, `subject:report`, `to:bob@example.com`; ' +
        'plain text is also accepted and searched broadly. Returns headers, not bodies.',
      inputSchema: {
        account_id: accountIdSchema(),
        query: z.string().min(1).describe('Search expression, e.g. `from:alice@example.com`.'),
        folder: z
          .string()
          .optional()
          .describe('Restrict the search to this folder name or ID. Omit to search everywhere.'),
        limit: z.number().int().optional().describe('How many results to return (1-200). Default 20.'),
        start: z.number().int().optional().describe('1-based offset for paging.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(
      async (args: {
        account_id?: string;
        query: string;
        folder?: string;
        limit?: number;
        start?: number;
      }) => {
        const accountId = await api.resolveAccountId(args.account_id);
        const folderId = args.folder
          ? await api.resolveFolderId(accountId, args.folder)
          : undefined;
        const messages = await api.searchMessages(accountId, {
          searchKey: args.query,
          folderId,
          limit: args.limit,
          start: args.start,
        });
        return ok({
          accountId,
          query: args.query,
          count: messages.length,
          messages: messages.map(summarizeMessage),
        });
      },
    ),
  );

  server.registerTool(
    'get_email',
    {
      title: 'Read an email',
      description:
        'Fetch the full body of one email by message ID. HTML bodies are converted to plain ' +
        'text unless format is "html". Get message IDs from list_emails or search_emails.',
      inputSchema: {
        account_id: accountIdSchema(),
        message_id: z.string().min(1).describe('Message ID from list_emails or search_emails.'),
        folder: z
          .string()
          .optional()
          .describe(
            'Folder name or ID holding the message. Use the folderId from the listing; ' +
              'defaults to "Inbox".',
          ),
        format: z
          .enum(['text', 'html'])
          .optional()
          .describe('"text" (default) converts HTML to plain text; "html" returns raw markup.'),
        max_chars: z
          .number()
          .int()
          .optional()
          .describe(`Truncate the body at this many characters. Default ${DEFAULT_BODY_CHARS}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(
      async (args: {
        account_id?: string;
        message_id: string;
        folder?: string;
        format?: 'text' | 'html';
        max_chars?: number;
      }) => {
        const accountId = await api.resolveAccountId(args.account_id);
        const folderId = await api.resolveFolderId(accountId, args.folder ?? 'Inbox');
        const raw = await api.getMessageContent(accountId, folderId, args.message_id);

        const rawBody = typeof raw?.content === 'string' ? raw.content : '';
        const wantsHtml = args.format === 'html';
        const body = wantsHtml || !looksLikeHtml(rawBody) ? rawBody : htmlToText(rawBody);
        const limited = truncateBody(body, args.max_chars ?? DEFAULT_BODY_CHARS);

        return ok({
          accountId,
          folderId,
          messageId: args.message_id,
          subject: raw?.subject,
          format: wantsHtml ? 'html' : 'text',
          truncated: limited.truncated,
          body: limited.text,
        });
      },
    ),
  );

  server.registerTool(
    'list_attachments',
    {
      title: 'List email attachments',
      description:
        'List attachment metadata (names, sizes, attachment IDs) for one email. ' +
        'Does not download file contents.',
      inputSchema: {
        account_id: accountIdSchema(),
        message_id: z.string().min(1).describe('Message ID from list_emails or search_emails.'),
        folder: z.string().optional().describe('Folder name or ID holding the message. Defaults to "Inbox".'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(
      async (args: { account_id?: string; message_id: string; folder?: string }) => {
        const accountId = await api.resolveAccountId(args.account_id);
        const folderId = await api.resolveFolderId(accountId, args.folder ?? 'Inbox');
        const info = await api.getAttachmentInfo(accountId, folderId, args.message_id);
        return ok({ accountId, folderId, messageId: args.message_id, attachments: info });
      },
    ),
  );
}

function registerWriteTools(server: McpServer, { api }: ToolDeps): void {
  server.registerTool(
    'send_email',
    {
      title: 'Send an email',
      description:
        'Send an email from a Zoho mailbox. This delivers immediately and cannot be undone — ' +
        'confirm recipients and content with the user first. If from_address is omitted, the ' +
        "mailbox's default send address is used.",
      inputSchema: {
        account_id: accountIdSchema(),
        to: addressSchema('Recipient address(es).'),
        subject: z.string().describe('Subject line.'),
        body: z.string().describe('Message body. Interpreted per `format`.'),
        cc: addressSchema('CC address(es).').optional(),
        bcc: addressSchema('BCC address(es).').optional(),
        from_address: z
          .string()
          .optional()
          .describe('Sender address; must be one this mailbox may send from. See list_accounts.'),
        format: z
          .enum(['html', 'plaintext'])
          .optional()
          .describe('Body format. Default "html".'),
        ask_receipt: z.boolean().optional().describe('Request a read receipt. Default false.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler(async (args: SendArgs) => {
      const { accountId, fromAddress } = await resolveSender(api, args.account_id, args.from_address);
      const to = joinAddresses(args.to);
      if (!to) throw new ZohoApiError('At least one recipient is required.', { httpStatus: 400 });

      const result = await api.sendMail(accountId, {
        fromAddress,
        toAddress: to,
        ccAddress: joinAddresses(args.cc),
        bccAddress: joinAddresses(args.bcc),
        subject: args.subject,
        content: args.body,
        mailFormat: args.format ?? 'html',
        askReceipt: args.ask_receipt ?? false,
      });

      return ok({ sent: true, accountId, from: fromAddress, to, subject: args.subject, result });
    }),
  );

  server.registerTool(
    'save_draft',
    {
      title: 'Save a draft',
      description:
        'Save an email to the Drafts folder without sending it. Use this when the user wants ' +
        'to review before sending.',
      inputSchema: {
        account_id: accountIdSchema(),
        to: addressSchema('Recipient address(es).').optional(),
        subject: z.string().optional().describe('Subject line.'),
        body: z.string().optional().describe('Message body.'),
        cc: addressSchema('CC address(es).').optional(),
        bcc: addressSchema('BCC address(es).').optional(),
        from_address: z.string().optional().describe('Sender address. Defaults to the mailbox default.'),
        format: z.enum(['html', 'plaintext']).optional().describe('Body format. Default "html".'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler(async (args: Omit<SendArgs, 'to' | 'subject' | 'body'> & Partial<SendArgs>) => {
      const { accountId, fromAddress } = await resolveSender(api, args.account_id, args.from_address);
      const result = await api.sendMail(accountId, {
        fromAddress,
        toAddress: joinAddresses(args.to) ?? '',
        ccAddress: joinAddresses(args.cc),
        bccAddress: joinAddresses(args.bcc),
        subject: args.subject ?? '',
        content: args.body ?? '',
        mailFormat: args.format ?? 'html',
        mode: 'draft',
      });
      return ok({ saved: true, accountId, from: fromAddress, subject: args.subject, result });
    }),
  );

  server.registerTool(
    'reply_to_email',
    {
      title: 'Reply to or forward an email',
      description:
        'Reply, reply-all, or forward an existing message so it stays in the same thread. ' +
        'Sends immediately — confirm with the user first. Forwarding requires `to`.',
      inputSchema: {
        account_id: accountIdSchema(),
        message_id: z.string().min(1).describe('Message ID being replied to or forwarded.'),
        body: z.string().describe('Your message text.'),
        action: z
          .enum(['reply', 'replyall', 'forward'])
          .optional()
          .describe('Default "reply". Use "replyall" to include all recipients.'),
        to: addressSchema('Required for "forward"; overrides recipients otherwise.').optional(),
        cc: addressSchema('CC address(es).').optional(),
        from_address: z.string().optional().describe('Sender address. Defaults to the mailbox default.'),
        format: z.enum(['html', 'plaintext']).optional().describe('Body format. Default "html".'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler(
      async (args: {
        account_id?: string;
        message_id: string;
        body: string;
        action?: 'reply' | 'replyall' | 'forward';
        to?: string | string[];
        cc?: string | string[];
        from_address?: string;
        format?: 'html' | 'plaintext';
      }) => {
        const { accountId, fromAddress } = await resolveSender(
          api,
          args.account_id,
          args.from_address,
        );
        const action = args.action ?? 'reply';
        const to = joinAddresses(args.to);
        if (action === 'forward' && !to) {
          throw new ZohoApiError('Forwarding requires at least one recipient in `to`.', {
            httpStatus: 400,
          });
        }

        const result = await api.replyToMessage(accountId, args.message_id, {
          action,
          fromAddress,
          toAddress: to ?? '',
          ccAddress: joinAddresses(args.cc),
          content: args.body,
          mailFormat: args.format ?? 'html',
        });
        return ok({ sent: true, action, accountId, messageId: args.message_id, result });
      },
    ),
  );

  server.registerTool(
    'mark_emails',
    {
      title: 'Change email state',
      description:
        'Mark messages read or unread, flag them, archive them, or mark them as spam. ' +
        'Accepts several message IDs at once.',
      inputSchema: {
        account_id: accountIdSchema(),
        message_ids: z
          .array(z.string().min(1))
          .min(1)
          .describe('Message IDs to update, from list_emails or search_emails.'),
        action: z
          .enum(['read', 'unread', 'flag', 'archive', 'unarchive', 'spam', 'not_spam'])
          .describe('What to do with the messages.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handler(
      async (args: {
        account_id?: string;
        message_ids: string[];
        action: 'read' | 'unread' | 'flag' | 'archive' | 'unarchive' | 'spam' | 'not_spam';
      }) => {
        const accountId = await api.resolveAccountId(args.account_id);
        const modes: Record<typeof args.action, UpdateMode> = {
          read: 'markAsRead',
          unread: 'markAsUnread',
          flag: 'flag',
          archive: 'archive',
          unarchive: 'unArchive',
          spam: 'spam',
          not_spam: 'notSpam',
        };
        const result = await api.updateMessages(accountId, {
          mode: modes[args.action],
          messageIds: args.message_ids,
        });
        return ok({
          updated: args.message_ids.length,
          action: args.action,
          accountId,
          result,
        });
      },
    ),
  );

  server.registerTool(
    'move_emails',
    {
      title: 'Move emails to a folder',
      description:
        'Move messages into another folder. Moving to "Trash" is how mail is deleted in Zoho — ' +
        'treat that as destructive and confirm with the user first.',
      inputSchema: {
        account_id: accountIdSchema(),
        message_ids: z.array(z.string().min(1)).min(1).describe('Message IDs to move.'),
        destination_folder: z
          .string()
          .min(1)
          .describe('Target folder name (e.g. "Archive", "Trash") or folder ID.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handler(
      async (args: { account_id?: string; message_ids: string[]; destination_folder: string }) => {
        const accountId = await api.resolveAccountId(args.account_id);
        const destfolderId = await api.resolveFolderId(accountId, args.destination_folder);
        const result = await api.updateMessages(accountId, {
          mode: 'moveMessage',
          messageIds: args.message_ids,
          destfolderId,
        });
        return ok({
          moved: args.message_ids.length,
          destination: args.destination_folder,
          destfolderId,
          accountId,
          result,
        });
      },
    ),
  );
}

interface SendArgs {
  account_id?: string;
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  from_address?: string;
  format?: 'html' | 'plaintext';
  ask_receipt?: boolean;
}

/**
 * Zoho rejects a send whose fromAddress is not one the mailbox owns, so when the
 * caller omits it we look up the account's default rather than guessing.
 */
async function resolveSender(
  api: ZohoMailApi,
  accountIdArg: string | undefined,
  fromArg: string | undefined,
): Promise<{ accountId: string; fromAddress: string }> {
  const accountId = await api.resolveAccountId(accountIdArg);
  if (fromArg?.trim()) return { accountId, fromAddress: fromArg.trim() };

  const accounts = await api.listAccounts();
  const match = accounts.find((a) => String(a.accountId) === accountId) ?? accounts[0];
  const fromAddress = match ? summarizeAccount(match).defaultFromAddress : undefined;

  if (!fromAddress) {
    throw new ZohoApiError('Could not determine a from-address for this mailbox.', {
      httpStatus: 400,
      hint: 'Pass from_address explicitly — call list_accounts to see the allowed addresses.',
    });
  }
  return { accountId, fromAddress };
}
