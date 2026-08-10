import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDataCenter } from '../dist/config.js';
import { TokenManager } from '../dist/zoho/auth.js';
import { ZohoMailClient, ZohoApiError } from '../dist/zoho/client.js';

const DC = resolveDataCenter('us');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A token manager that hands out tokens without any network calls. */
function stubTokens(tokens = ['token-1', 'token-2']) {
  let index = 0;
  const manager = new TokenManager({
    clientId: 'c',
    clientSecret: 's',
    refreshToken: 'r',
    dataCenter: DC,
    fetchImpl: async () =>
      jsonResponse({ access_token: tokens[Math.min(index++, tokens.length - 1)], expires_in: 3600 }),
  });
  return manager;
}

function makeClient(fetchImpl, tokens) {
  return new ZohoMailClient({
    tokenManager: stubTokens(tokens),
    dataCenter: DC,
    fetchImpl,
  });
}

test('base URL follows the data center', () => {
  assert.equal(makeClient(async () => jsonResponse({})).baseUrl, 'https://mail.zoho.com/api');

  const eu = new ZohoMailClient({ tokenManager: stubTokens(), dataCenter: resolveDataCenter('eu') });
  assert.equal(eu.baseUrl, 'https://mail.zoho.eu/api');
});

test('requests carry the Zoho-oauthtoken scheme, not Bearer', async () => {
  let captured;
  const client = makeClient(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ data: { ok: true } });
  });

  await client.request('/accounts');
  assert.equal(captured.init.headers.Authorization, 'Zoho-oauthtoken token-1');
  assert.ok(!captured.init.headers.Authorization.startsWith('Bearer'));
});

test('the envelope is unwrapped so callers see only data', async () => {
  const client = makeClient(async () =>
    jsonResponse({ status: { code: 200, description: 'success' }, data: [{ accountId: '7' }] }),
  );
  assert.deepEqual(await client.request('/accounts'), [{ accountId: '7' }]);
});

test('query parameters are appended, skipping undefined and empty values', async () => {
  let captured;
  const client = makeClient(async (url) => {
    captured = url;
    return jsonResponse({ data: [] });
  });

  await client.request('/accounts/1/messages/view', {
    query: { folderId: '99', limit: 20, start: undefined, status: '' },
  });

  const url = new URL(captured);
  assert.equal(url.pathname, '/api/accounts/1/messages/view');
  assert.equal(url.searchParams.get('folderId'), '99');
  assert.equal(url.searchParams.get('limit'), '20');
  assert.equal(url.searchParams.has('start'), false);
  assert.equal(url.searchParams.has('status'), false);
});

test('a leading slash on the path is optional', async () => {
  const seen = [];
  const client = makeClient(async (url) => {
    seen.push(new URL(url).pathname);
    return jsonResponse({ data: null });
  });

  await client.request('/accounts');
  await client.request('accounts');
  assert.deepEqual(seen, ['/api/accounts', '/api/accounts']);
});

test('bodies are JSON-encoded with a matching content type', async () => {
  let captured;
  const client = makeClient(async (_url, init) => {
    captured = init;
    return jsonResponse({ data: {} });
  });

  await client.request('/accounts/1/messages', { method: 'POST', body: { subject: 'hi' } });
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.body), { subject: 'hi' });
});

test('GET requests send no body or content-type header', async () => {
  let captured;
  const client = makeClient(async (_url, init) => {
    captured = init;
    return jsonResponse({ data: {} });
  });

  await client.request('/accounts');
  assert.equal(captured.body, undefined);
  assert.equal(captured.headers['Content-Type'], undefined);
});

test('a 401 is retried once with a freshly minted token', async () => {
  const seen = [];
  const client = makeClient(async (_url, init) => {
    seen.push(init.headers.Authorization);
    return seen.length === 1
      ? jsonResponse({ status: { code: 401 } }, 401)
      : jsonResponse({ data: { ok: true } });
  });

  assert.deepEqual(await client.request('/accounts'), { ok: true });
  assert.deepEqual(seen, ['Zoho-oauthtoken token-1', 'Zoho-oauthtoken token-2']);
});

test('a second consecutive 401 is surfaced rather than looping', async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls++;
    return jsonResponse({ status: { code: 401, description: 'Invalid OAuth token' } }, 401);
  });

  await assert.rejects(
    () => client.request('/accounts'),
    (error) => {
      assert.ok(error instanceof ZohoApiError);
      assert.equal(error.httpStatus, 401);
      assert.match(error.message, /Invalid OAuth token/);
      return true;
    },
  );
  assert.equal(calls, 2, 'exactly one retry');
});

test('Zoho error descriptions and hints reach the caller', async () => {
  const client = makeClient(async () =>
    jsonResponse({ status: { code: 404, description: 'Folder does not exist' } }, 404),
  );

  await assert.rejects(
    () => client.request('/accounts/1/folders/2'),
    (error) => {
      assert.equal(error.httpStatus, 404);
      assert.equal(error.zohoCode, '404');
      assert.match(error.message, /Folder does not exist/);
      assert.match(error.hint, /ZOHO_DC matches the account/);
      return true;
    },
  );
});

test('rate limiting is reported with a wait-and-retry hint', async () => {
  const client = makeClient(async () => jsonResponse({ status: { code: 429 } }, 429));
  await assert.rejects(
    () => client.request('/accounts'),
    (error) => {
      assert.equal(error.httpStatus, 429);
      assert.match(error.hint, /rate limit/i);
      return true;
    },
  );
});

test('a non-JSON error body is still reported with its status', async () => {
  const client = makeClient(async () => new Response('<html>502</html>', { status: 502 }));
  await assert.rejects(
    () => client.request('/accounts'),
    (error) => {
      assert.equal(error.httpStatus, 502);
      assert.match(error.message, /non-JSON body/);
      return true;
    },
  );
});

test('a successful non-JSON body is returned verbatim', async () => {
  const client = makeClient(async () => new Response('From: a@b.com\r\nSubject: raw', { status: 200 }));
  const result = await client.request('/accounts/1/messages/2/originalmessage');
  assert.match(result, /Subject: raw/);
});

test('network errors name the host and do not leak an exception type', async () => {
  const client = makeClient(async () => {
    throw new Error('socket hang up');
  });

  await assert.rejects(
    () => client.request('/accounts'),
    (error) => {
      assert.ok(error instanceof ZohoApiError);
      assert.equal(error.httpStatus, 0);
      assert.match(error.message, /socket hang up/);
      assert.match(error.hint, /mail\.zoho\.com/);
      return true;
    },
  );
});

test('requestBinary returns bytes and the reported content type', async () => {
  const client = makeClient(
    async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
  );

  const result = await client.requestBinary('/accounts/1/messages/2/attachments/3');
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(result.contentType, 'application/pdf');
});
