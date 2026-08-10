/**
 * End-to-end exercise of the MCP surface: a real client talks to a real server
 * over an in-memory transport, with only the Zoho HTTP layer faked. This is
 * what catches schema mistakes that unit tests on the API layer cannot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerTools } from '../dist/tools.js';
import { ZohoMailApi } from '../dist/zoho/mail.js';

const ACCOUNTS = [
  {
    accountId: '1000',
    accountName: 'Work',
    primaryEmailAddress: 'ada@example.com',
    sendMailDetails: [
      { fromAddress: 'ada@example.com', default: 'true' },
      { fromAddress: 'billing@example.com' },
    ],
  },
];

const FOLDERS = [
  { folderId: '11', folderName: 'Inbox', path: '/Inbox', unreadCount: '2', messageCount: '10' },
  { folderId: '44', folderName: 'Trash', path: '/Trash' },
];

const MESSAGES = [
  {
    messageId: '555',
    folderId: '11',
    fromAddress: 'bob@example.com',
    toAddress: 'ada@example.com',
    subject: 'Q3 report',
    summary: 'Attached is the report',
    status: '0',
    hasAttachment: '1',
    receivedTime: '1700000000000',
    size: '2048',
  },
];

/** Routes fake responses by path, and records every request for assertions. */
function fakeClient() {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, ...options });
      if (path === '/accounts') return ACCOUNTS;
      if (path.endsWith('/folders')) return FOLDERS;
      if (path.endsWith('/messages/view')) return MESSAGES;
      if (path.endsWith('/messages/search')) return MESSAGES;
      if (path.endsWith('/content')) {
        return { subject: 'Q3 report', content: '<p>Hello <b>Ada</b>,</p><p>See attached.</p>' };
      }
      if (path.endsWith('/attachmentinfo')) {
        return [{ attachmentName: 'report.pdf', attachmentId: 'att-1', size: '1024' }];
      }
      if (path.endsWith('/updatemessage')) return { success: true };
      return { messageId: 'new-1' };
    },
    async requestBinary() {
      return { bytes: new Uint8Array(), contentType: 'application/octet-stream' };
    },
  };
}

async function connect({ readOnly = false } = {}) {
  const http = fakeClient();
  const api = new ZohoMailApi(http);
  const server = new McpServer({ name: 'zoho-mail', version: 'test' }, { capabilities: { tools: {} } });
  registerTools(server, { api, readOnly });

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { client, http, close: () => Promise.all([client.close(), server.close()]) };
}

/** Tool results are JSON text; parse the single text block back out. */
function payload(result) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

test('read-write mode exposes the full tool set', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'get_email',
    'list_accounts',
    'list_attachments',
    'list_emails',
    'list_folders',
    'mark_emails',
    'move_emails',
    'reply_to_email',
    'save_draft',
    'search_emails',
    'send_email',
  ]);
});

test('read-only mode registers no mutating tools at all', async (t) => {
  const { client, close } = await connect({ readOnly: true });
  t.after(close);

  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'get_email',
    'list_accounts',
    'list_attachments',
    'list_emails',
    'list_folders',
    'search_emails',
  ]);
});

test('every tool advertises a description and read-only hint', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const { tools } = await client.listTools();
  for (const tool of tools) {
    assert.ok(tool.description?.length > 20, `${tool.name} needs a usable description`);
    assert.equal(
      typeof tool.annotations?.readOnlyHint,
      'boolean',
      `${tool.name} must declare readOnlyHint`,
    );
  }

  const move = tools.find((tool) => tool.name === 'move_emails');
  assert.equal(move.annotations.destructiveHint, true, 'moving to Trash is destructive');
});

test('list_accounts reports mailboxes and their allowed from-addresses', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const data = payload(await client.callTool({ name: 'list_accounts', arguments: {} }));
  assert.equal(data.count, 1);
  assert.equal(data.accounts[0].accountId, '1000');
  assert.equal(data.accounts[0].defaultFromAddress, 'ada@example.com');
});

test('list_emails defaults to the Inbox and normalises messages', async (t) => {
  const { client, http, close } = await connect();
  t.after(close);

  const data = payload(await client.callTool({ name: 'list_emails', arguments: {} }));
  assert.equal(data.folder, 'Inbox');
  assert.equal(data.folderId, '11');
  assert.equal(data.count, 1);
  assert.equal(data.messages[0].subject, 'Q3 report');
  assert.equal(data.messages[0].isUnread, true);
  assert.equal(data.messages[0].receivedAt, '2023-11-14T22:13:20.000Z');

  const view = http.calls.find((call) => call.path.endsWith('/messages/view'));
  assert.equal(view.query.folderId, '11', 'the folder name was resolved to an id');
});

test('list_emails resolves a folder name the caller supplied', async (t) => {
  const { client, http, close } = await connect();
  t.after(close);

  await client.callTool({ name: 'list_emails', arguments: { folder: 'Trash', limit: 5 } });
  const view = http.calls.find((call) => call.path.endsWith('/messages/view'));
  assert.equal(view.query.folderId, '44');
  assert.equal(view.query.limit, 5);
});

test('an unknown folder comes back as a tool error, not a crash', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const result = await client.callTool({ name: 'list_emails', arguments: { folder: 'Nope' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No folder named "Nope"/);
  assert.match(result.content[0].text, /Hint: Available folders: Inbox, Trash/);
});

test('get_email converts HTML bodies to plain text by default', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const data = payload(
    await client.callTool({ name: 'get_email', arguments: { message_id: '555' } }),
  );
  assert.equal(data.format, 'text');
  assert.equal(data.body, 'Hello Ada,\n\nSee attached.');
  assert.equal(data.truncated, false);
});

test('get_email returns raw markup when html is requested', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const data = payload(
    await client.callTool({ name: 'get_email', arguments: { message_id: '555', format: 'html' } }),
  );
  assert.equal(data.format, 'html');
  assert.match(data.body, /<b>Ada<\/b>/);
});

test('get_email truncates at max_chars and says so', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const data = payload(
    await client.callTool({ name: 'get_email', arguments: { message_id: '555', max_chars: 5 } }),
  );
  assert.equal(data.truncated, true);
  assert.match(data.body, /truncated/);
});

test('search_emails forwards the query as Zoho searchKey', async (t) => {
  const { client, http, close } = await connect();
  t.after(close);

  const data = payload(
    await client.callTool({
      name: 'search_emails',
      arguments: { query: 'from:bob@example.com' },
    }),
  );
  assert.equal(data.count, 1);

  const search = http.calls.find((call) => call.path.endsWith('/messages/search'));
  assert.equal(search.query.searchKey, 'from:bob@example.com');
  assert.equal(search.query.folderId, undefined, 'no folder means search everywhere');
});

test('send_email fills in the default from-address and joins recipients', async (t) => {
  const { client, http, close } = await connect();
  t.after(close);

  const data = payload(
    await client.callTool({
      name: 'send_email',
      arguments: {
        to: ['bob@example.com', 'carol@example.com'],
        cc: 'dave@example.com, erin@example.com',
        subject: 'Status',
        body: 'All good.',
      },
    }),
  );

  assert.equal(data.sent, true);
  assert.equal(data.from, 'ada@example.com');

  const send = http.calls.find((call) => call.method === 'POST');
  assert.equal(send.body.toAddress, 'bob@example.com,carol@example.com');
  assert.equal(send.body.ccAddress, 'dave@example.com,erin@example.com');
  assert.equal(send.body.subject, 'Status');
  assert.equal(send.body.mailFormat, 'html');
  assert.equal(send.body.askReceipt, false);
});

test('send_email honours an explicit from-address and plaintext format', async (t) => {
  const { client, http, close } = await connect();
  t.after(close);

  await client.callTool({
    name: 'send_email',
    arguments: {
      to: 'bob@example.com',
      subject: 'Plain',
      body: 'text only',
      from_address: 'billing@example.com',
      format: 'plaintext',
    },
  });

  const send = http.calls.find((call) => call.method === 'POST');
  assert.equal(send.body.fromAddress, 'billing@example.com');
  assert.equal(send.body.mailFormat, 'plaintext');
});

test('send_email rejects a recipient list that is empty after trimming', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const result = await client.callTool({
    name: 'send_email',
    arguments: { to: ['  ', ','], subject: 'x', body: 'y' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /At least one recipient is required/);
});

test('send_email requires to, subject, and body', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const result = await client.callTool({ name: 'send_email', arguments: { to: 'a@b.com' } });
  assert.equal(result.isError, true, 'schema validation should reject the call');
});

test('save_draft posts with mode=draft rather than sending', async (t) => {
  const { client, http, close } = await connect();
  t.after(close);

  const data = payload(
    await client.callTool({
      name: 'save_draft',
      arguments: { to: 'bob@example.com', subject: 'Later', body: 'Draft body' },
    }),
  );

  assert.equal(data.saved, true);
  const draft = http.calls.find((call) => call.method === 'POST');
  assert.equal(draft.body.mode, 'draft');
  assert.equal(draft.body.subject, 'Later');
});

test('reply_to_email threads onto the original message', async (t) => {
  const { client, http, close } = await connect();
  t.after(close);

  const data = payload(
    await client.callTool({
      name: 'reply_to_email',
      arguments: { message_id: '555', body: 'Thanks!', action: 'replyall' },
    }),
  );

  assert.equal(data.sent, true);
  assert.equal(data.action, 'replyall');
  const reply = http.calls.find((call) => call.path === '/accounts/1000/messages/555');
  assert.equal(reply.body.action, 'replyall');
  assert.equal(reply.body.content, 'Thanks!');
});

test('forwarding without a recipient is refused', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const result = await client.callTool({
    name: 'reply_to_email',
    arguments: { message_id: '555', body: 'FYI', action: 'forward' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Forwarding requires at least one recipient/);
});

test('mark_emails maps friendly actions onto Zoho update modes', async (t) => {
  const cases = [
    ['read', 'markAsRead'],
    ['unread', 'markAsUnread'],
    ['flag', 'flag'],
    ['archive', 'archive'],
    ['unarchive', 'unArchive'],
    ['spam', 'spam'],
    ['not_spam', 'notSpam'],
  ];

  for (const [action, mode] of cases) {
    const { client, http, close } = await connect();
    const data = payload(
      await client.callTool({
        name: 'mark_emails',
        arguments: { message_ids: ['555', '556'], action },
      }),
    );
    assert.equal(data.updated, 2, action);

    const update = http.calls.find((call) => call.path.endsWith('/updatemessage'));
    assert.equal(update.body.mode, mode, action);
    assert.deepEqual(update.body.messageId, ['555', '556'], action);
    await close();
  }
});

test('mark_emails rejects an empty id list', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const result = await client.callTool({
    name: 'mark_emails',
    arguments: { message_ids: [], action: 'read' },
  });
  assert.equal(result.isError, true);
});

test('move_emails resolves the destination folder name to an id', async (t) => {
  const { client, http, close } = await connect();
  t.after(close);

  const data = payload(
    await client.callTool({
      name: 'move_emails',
      arguments: { message_ids: ['555'], destination_folder: 'Trash' },
    }),
  );

  assert.equal(data.moved, 1);
  assert.equal(data.destfolderId, '44');

  const update = http.calls.find((call) => call.path.endsWith('/updatemessage'));
  assert.equal(update.body.mode, 'moveMessage');
  assert.equal(update.body.destfolderId, '44');
});

test('list_attachments returns metadata without downloading files', async (t) => {
  const { client, close } = await connect();
  t.after(close);

  const data = payload(
    await client.callTool({ name: 'list_attachments', arguments: { message_id: '555' } }),
  );
  assert.equal(data.attachments[0].attachmentName, 'report.pdf');
});

test('mutating tools are unreachable in read-only mode', async (t) => {
  const { client, close } = await connect({ readOnly: true });
  t.after(close);

  const result = await client.callTool({
    name: 'send_email',
    arguments: { to: 'bob@example.com', subject: 'x', body: 'y' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /send_email not found/);
});
