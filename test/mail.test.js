import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ZohoMailApi,
  summarizeAccount,
  summarizeFolder,
  summarizeMessage,
  readStatusToUnread,
  toIsoDate,
  clampLimit,
  MAX_PAGE_SIZE,
} from '../dist/zoho/mail.js';
import { ZohoApiError } from '../dist/zoho/client.js';

/** Records every call so tests can assert on paths, methods, and bodies. */
function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, ...options });
      return responder(path, options);
    },
    async requestBinary(path, options = {}) {
      calls.push({ path, ...options });
      return responder(path, options);
    },
  };
}

const ACCOUNTS = [
  {
    accountId: '1000',
    accountName: 'Work',
    primaryEmailAddress: 'ada@example.com',
    sendMailDetails: [
      { fromAddress: 'ada@example.com', default: 'false' },
      { fromAddress: 'billing@example.com', default: 'true' },
    ],
  },
  { accountId: '2000', primaryEmailAddress: 'second@example.com' },
];

const FOLDERS = [
  { folderId: '11', folderName: 'Inbox', path: '/Inbox', folderType: 'Inbox', unreadCount: '3', messageCount: '42' },
  { folderId: '22', folderName: 'Sent', path: '/Sent', folderType: 'Sent' },
  { folderId: '33', folderName: 'Acme', path: '/Clients/Acme' },
  { folderId: '44', folderName: 'Trash', path: '/Trash', folderType: 'Trash' },
];

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

test('summarizeAccount prefers the address flagged as default', () => {
  const summary = summarizeAccount(ACCOUNTS[0]);
  assert.equal(summary.accountId, '1000');
  assert.equal(summary.primaryEmailAddress, 'ada@example.com');
  assert.deepEqual(summary.fromAddresses, ['ada@example.com', 'billing@example.com']);
  assert.equal(summary.defaultFromAddress, 'billing@example.com');
});

test('summarizeAccount falls back to the primary address when none is flagged', () => {
  assert.equal(summarizeAccount(ACCOUNTS[1]).defaultFromAddress, 'second@example.com');
  assert.deepEqual(summarizeAccount(ACCOUNTS[1]).fromAddresses, []);
});

test('summarizeAccount honours a boolean default flag as well as the string form', () => {
  const summary = summarizeAccount({
    accountId: '3',
    sendMailDetails: [{ fromAddress: 'a@x.com' }, { fromAddress: 'b@x.com', default: true }],
  });
  assert.equal(summary.defaultFromAddress, 'b@x.com');
});

test('summarizeAccount coerces a numeric account id to a string', () => {
  assert.equal(summarizeAccount({ accountId: 4321 }).accountId, '4321');
});

test('summarizeFolder converts count strings to numbers', () => {
  const summary = summarizeFolder(FOLDERS[0]);
  assert.equal(summary.folderId, '11');
  assert.equal(summary.name, 'Inbox');
  assert.equal(summary.unreadCount, 3);
  assert.equal(summary.totalCount, 42);
});

test('summarizeFolder reports missing counts as undefined rather than zero', () => {
  const summary = summarizeFolder(FOLDERS[1]);
  assert.equal(summary.unreadCount, undefined);
  assert.equal(summary.totalCount, undefined);
});

test('summarizeMessage maps the fields a mail assistant reasons over', () => {
  const summary = summarizeMessage({
    messageId: '555',
    folderId: '11',
    threadId: '999',
    fromAddress: 'bob@example.com',
    toAddress: 'ada@example.com',
    ccAddress: '',
    subject: 'Q3 report',
    summary: '  Attached is the report  ',
    status: '0',
    hasAttachment: '1',
    receivedTime: '1700000000000',
    size: '2048',
  });

  assert.equal(summary.messageId, '555');
  assert.equal(summary.from, 'bob@example.com');
  assert.equal(summary.cc, undefined, 'empty cc should be dropped, not reported as ""');
  assert.equal(summary.snippet, 'Attached is the report');
  assert.equal(summary.isUnread, true);
  assert.equal(summary.hasAttachment, true);
  assert.equal(summary.receivedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(summary.sizeBytes, 2048);
});

test('summarizeMessage falls back to sender and sent date when absent', () => {
  const summary = summarizeMessage({ sender: 'noreply@x.com', sentDateInGMT: 1700000000000 });
  assert.equal(summary.from, 'noreply@x.com');
  assert.equal(summary.receivedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(summary.hasAttachment, false);
});

test('read state is only reported when Zoho actually stated it', () => {
  assert.equal(readStatusToUnread('0'), true);
  assert.equal(readStatusToUnread('1'), false);
  assert.equal(readStatusToUnread(undefined), undefined);
  assert.equal(readStatusToUnread('7'), undefined);
});

test('toIsoDate rejects junk instead of inventing 1970', () => {
  assert.equal(toIsoDate(1700000000000), '2023-11-14T22:13:20.000Z');
  assert.equal(toIsoDate('1700000000000'), '2023-11-14T22:13:20.000Z');
  assert.equal(toIsoDate(undefined), undefined);
  assert.equal(toIsoDate(''), undefined);
  assert.equal(toIsoDate(0), undefined);
  assert.equal(toIsoDate('not-a-date'), undefined);
});

test('clampLimit keeps requests inside the page ceiling', () => {
  assert.equal(clampLimit(undefined), 20);
  assert.equal(clampLimit(5), 5);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-10), 1);
  assert.equal(clampLimit(10_000), MAX_PAGE_SIZE);
  assert.equal(clampLimit(7.9), 7);
  assert.equal(clampLimit(Number.NaN), 20);
});

// ---------------------------------------------------------------------------
// Account + folder resolution
// ---------------------------------------------------------------------------

test('an explicit account id wins over the configured pin', async () => {
  const api = new ZohoMailApi(fakeClient(() => ACCOUNTS), { accountId: '2000' });
  assert.equal(await api.resolveAccountId('9999'), '9999');
});

test('the configured pin is used when no argument is given', async () => {
  const client = fakeClient(() => ACCOUNTS);
  const api = new ZohoMailApi(client, { accountId: '2000' });
  assert.equal(await api.resolveAccountId(), '2000');
  assert.equal(client.calls.length, 0, 'a pinned account needs no lookup');
});

test('with no pin, the first account on the login is used', async () => {
  const api = new ZohoMailApi(fakeClient(() => ACCOUNTS));
  assert.equal(await api.resolveAccountId(), '1000');
});

test('a login with no mailbox produces an actionable error', async () => {
  const api = new ZohoMailApi(fakeClient(() => []));
  await assert.rejects(
    () => api.resolveAccountId(),
    (error) => {
      assert.ok(error instanceof ZohoApiError);
      assert.match(error.message, /No Zoho Mail accounts/);
      assert.match(error.hint, /ZohoMail\.accounts\.READ/);
      return true;
    },
  );
});

test('a single (non-array) account object is accepted', async () => {
  const api = new ZohoMailApi(fakeClient(() => ({ accountId: '77' })));
  assert.equal(await api.resolveAccountId(), '77');
});

test('accounts are cached across calls and cleared on demand', async () => {
  let calls = 0;
  const api = new ZohoMailApi(
    fakeClient(() => {
      calls++;
      return ACCOUNTS;
    }),
  );

  await api.listAccounts();
  await api.listAccounts();
  assert.equal(calls, 1);

  api.clearCache();
  await api.listAccounts();
  assert.equal(calls, 2);
});

test('the account cache expires after its TTL', async () => {
  let calls = 0;
  let clock = 0;
  const api = new ZohoMailApi(
    fakeClient(() => {
      calls++;
      return ACCOUNTS;
    }),
    { now: () => clock },
  );

  await api.listAccounts();
  clock = 4 * 60_000;
  await api.listAccounts();
  assert.equal(calls, 1, 'still fresh at 4 minutes');

  clock = 6 * 60_000;
  await api.listAccounts();
  assert.equal(calls, 2, 'refetched after 5 minutes');
});

test('folders resolve by name, case-insensitively', async () => {
  const api = new ZohoMailApi(fakeClient(() => FOLDERS));
  assert.equal(await api.resolveFolderId('1000', 'Inbox'), '11');
  assert.equal(await api.resolveFolderId('1000', 'inbox'), '11');
  assert.equal(await api.resolveFolderId('1000', 'SENT'), '22');
});

test('folders resolve by path, with or without the leading slash', async () => {
  const api = new ZohoMailApi(fakeClient(() => FOLDERS));
  assert.equal(await api.resolveFolderId('1000', '/Clients/Acme'), '33');
  assert.equal(await api.resolveFolderId('1000', 'Clients/Acme'), '33');
});

test('a known numeric folder id passes straight through', async () => {
  const api = new ZohoMailApi(fakeClient(() => FOLDERS));
  assert.equal(await api.resolveFolderId('1000', '22'), '22');
});

test('an unknown numeric id is trusted rather than rejected on a stale cache', async () => {
  const api = new ZohoMailApi(fakeClient(() => FOLDERS));
  assert.equal(await api.resolveFolderId('1000', '987654321'), '987654321');
});

test('an unknown folder name lists what is actually available', async () => {
  const api = new ZohoMailApi(fakeClient(() => FOLDERS));
  await assert.rejects(
    () => api.resolveFolderId('1000', 'Archives'),
    (error) => {
      assert.match(error.message, /No folder named "Archives"/);
      assert.match(error.hint, /Inbox, Sent, Acme, Trash/);
      return true;
    },
  );
});

test('an empty folder reference is rejected', async () => {
  const api = new ZohoMailApi(fakeClient(() => FOLDERS));
  await assert.rejects(() => api.resolveFolderId('1000', '   '), /Folder reference is empty/);
});

test('folders are cached per account', async () => {
  let calls = 0;
  const api = new ZohoMailApi(
    fakeClient(() => {
      calls++;
      return FOLDERS;
    }),
  );

  await api.listFolders('1000');
  await api.listFolders('1000');
  assert.equal(calls, 1);

  await api.listFolders('2000');
  assert.equal(calls, 2, 'a different mailbox is fetched separately');
});

// ---------------------------------------------------------------------------
// Endpoint shapes
// ---------------------------------------------------------------------------

test('listMessages omits the status filter when asked for everything', async () => {
  const client = fakeClient(() => []);
  const api = new ZohoMailApi(client);

  await api.listMessages('1000', { folderId: '11', status: 'all', limit: 50 });
  assert.equal(client.calls[0].path, '/accounts/1000/messages/view');
  assert.equal(client.calls[0].query.status, undefined);
  assert.equal(client.calls[0].query.limit, 50);
  assert.equal(client.calls[0].query.folderId, '11');
});

test('listMessages passes through an unread filter and clamps the limit', async () => {
  const client = fakeClient(() => []);
  const api = new ZohoMailApi(client);

  await api.listMessages('1000', { folderId: '11', status: 'unread', limit: 5000 });
  assert.equal(client.calls[0].query.status, 'unread');
  assert.equal(client.calls[0].query.limit, MAX_PAGE_SIZE);
});

test('listMessages drops a non-positive start offset', async () => {
  const client = fakeClient(() => []);
  const api = new ZohoMailApi(client);

  await api.listMessages('1000', { folderId: '11', start: 0 });
  assert.equal(client.calls[0].query.start, undefined);
});

test('listMessages tolerates a non-array payload', async () => {
  const api = new ZohoMailApi(fakeClient(() => null));
  assert.deepEqual(await api.listMessages('1000', {}), []);
});

test('searchMessages sends the query as searchKey', async () => {
  const client = fakeClient(() => []);
  const api = new ZohoMailApi(client);

  await api.searchMessages('1000', { searchKey: 'from:bob@example.com', limit: 10 });
  assert.equal(client.calls[0].path, '/accounts/1000/messages/search');
  assert.equal(client.calls[0].query.searchKey, 'from:bob@example.com');
  assert.equal(client.calls[0].query.limit, 10);
});

test('getMessageContent addresses the message inside its folder', async () => {
  const client = fakeClient(() => ({ content: '<p>hi</p>' }));
  const api = new ZohoMailApi(client);

  await api.getMessageContent('1000', '11', '555');
  assert.equal(client.calls[0].path, '/accounts/1000/folders/11/messages/555/content');
});

test('ids are URL-encoded so a stray slash cannot rewrite the path', async () => {
  const client = fakeClient(() => ({}));
  const api = new ZohoMailApi(client);

  await api.getMessageContent('1000', '11', '../../evil');
  assert.equal(client.calls[0].path, '/accounts/1000/folders/11/messages/..%2F..%2Fevil/content');
});

test('sendMail POSTs the compose payload to the messages endpoint', async () => {
  const client = fakeClient(() => ({ messageId: 'new' }));
  const api = new ZohoMailApi(client);

  await api.sendMail('1000', {
    fromAddress: 'ada@example.com',
    toAddress: 'bob@example.com',
    subject: 'Hi',
    content: 'Body',
    mailFormat: 'html',
  });

  const call = client.calls[0];
  assert.equal(call.path, '/accounts/1000/messages');
  assert.equal(call.method, 'POST');
  assert.equal(call.body.fromAddress, 'ada@example.com');
  assert.equal(call.body.toAddress, 'bob@example.com');
  assert.equal(call.body.mailFormat, 'html');
});

test('a draft is the same endpoint with mode=draft', async () => {
  const client = fakeClient(() => ({}));
  const api = new ZohoMailApi(client);

  await api.sendMail('1000', { fromAddress: 'a@x.com', toAddress: '', mode: 'draft' });
  assert.equal(client.calls[0].body.mode, 'draft');
});

test('replies POST to the message being replied to', async () => {
  const client = fakeClient(() => ({}));
  const api = new ZohoMailApi(client);

  await api.replyToMessage('1000', '555', {
    action: 'replyall',
    fromAddress: 'ada@example.com',
    toAddress: '',
    content: 'Thanks',
  });

  assert.equal(client.calls[0].path, '/accounts/1000/messages/555');
  assert.equal(client.calls[0].method, 'POST');
  assert.equal(client.calls[0].body.action, 'replyall');
});

test('updateMessages PUTs a mode with an array of message ids', async () => {
  const client = fakeClient(() => ({}));
  const api = new ZohoMailApi(client);

  await api.updateMessages('1000', { mode: 'markAsRead', messageIds: ['1', '2'] });
  const call = client.calls[0];
  assert.equal(call.path, '/accounts/1000/updatemessage');
  assert.equal(call.method, 'PUT');
  assert.equal(call.body.mode, 'markAsRead');
  assert.deepEqual(call.body.messageId, ['1', '2']);
  assert.equal('destfolderId' in call.body, false, 'no destination unless moving');
});

test('a move carries the destination folder id', async () => {
  const client = fakeClient(() => ({}));
  const api = new ZohoMailApi(client);

  await api.updateMessages('1000', {
    mode: 'moveMessage',
    messageIds: ['1'],
    destfolderId: '44',
  });
  assert.equal(client.calls[0].body.destfolderId, '44');
});
