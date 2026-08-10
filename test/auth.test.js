import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDataCenter } from '../dist/config.js';
import { TokenManager, ZohoAuthError, buildAuthorizeUrl, exchangeCodeForTokens } from '../dist/zoho/auth.js';

const DC = resolveDataCenter('us');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeManager(fetchImpl, now = () => 0) {
  return new TokenManager({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    dataCenter: DC,
    fetchImpl,
    now,
  });
}

test('token URL targets the configured data center', () => {
  const manager = makeManager(async () => jsonResponse({ access_token: 'a', expires_in: 3600 }));
  assert.equal(manager.tokenUrl, 'https://accounts.zoho.com/oauth/v2/token');

  const eu = new TokenManager({
    clientId: 'c',
    clientSecret: 's',
    refreshToken: 'r',
    dataCenter: resolveDataCenter('eu'),
  });
  assert.equal(eu.tokenUrl, 'https://accounts.zoho.eu/oauth/v2/token');
});

test('refresh posts the grant as form-encoded credentials', async () => {
  let captured;
  const manager = makeManager(async (url, init) => {
    captured = { url, init };
    return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
  });

  assert.equal(await manager.getAccessToken(), 'token-1');
  assert.equal(captured.url, 'https://accounts.zoho.com/oauth/v2/token');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'application/x-www-form-urlencoded');

  const body = new URLSearchParams(captured.init.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'refresh-token');
  assert.equal(body.get('client_id'), 'client-id');
  assert.equal(body.get('client_secret'), 'client-secret');
});

test('access tokens are cached until shortly before they expire', async () => {
  let calls = 0;
  let clock = 0;
  const manager = makeManager(
    async () => {
      calls++;
      return jsonResponse({ access_token: `token-${calls}`, expires_in: 3600 });
    },
    () => clock,
  );

  assert.equal(await manager.getAccessToken(), 'token-1');
  clock = 3_500_000; // still inside the hour, minus the 60s skew
  assert.equal(await manager.getAccessToken(), 'token-1');
  assert.equal(calls, 1, 'cached token should not trigger a second refresh');

  clock = 3_541_000; // past expiry - skew
  assert.equal(await manager.getAccessToken(), 'token-2');
  assert.equal(calls, 2);
});

test('concurrent callers share a single refresh round-trip', async () => {
  let calls = 0;
  const manager = makeManager(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return jsonResponse({ access_token: 'token', expires_in: 3600 });
  });

  const tokens = await Promise.all([
    manager.getAccessToken(),
    manager.getAccessToken(),
    manager.getAccessToken(),
  ]);

  assert.deepEqual(tokens, ['token', 'token', 'token']);
  assert.equal(calls, 1, 'in-flight refresh should be de-duplicated');
});

test('invalidate forces the next call to re-mint', async () => {
  let calls = 0;
  const manager = makeManager(async () => {
    calls++;
    return jsonResponse({ access_token: `token-${calls}`, expires_in: 3600 });
  });

  assert.equal(await manager.getAccessToken(), 'token-1');
  manager.invalidate();
  assert.equal(await manager.getAccessToken(), 'token-2');
});

test('an OAuth error returned with HTTP 200 is still treated as a failure', async () => {
  const manager = makeManager(async () => jsonResponse({ error: 'invalid_client' }));

  await assert.rejects(
    () => manager.getAccessToken(),
    (error) => {
      assert.ok(error instanceof ZohoAuthError);
      assert.equal(error.code, 'invalid_client');
      assert.match(error.hint, /ZOHO_DC matches the region/);
      return true;
    },
  );
});

test('a revoked refresh token surfaces actionable guidance', async () => {
  const manager = makeManager(async () => jsonResponse({ error: 'invalid_grant' }));
  await assert.rejects(
    () => manager.getAccessToken(),
    (error) => {
      assert.equal(error.code, 'invalid_grant');
      assert.match(error.hint, /npm run auth/);
      return true;
    },
  );
});

test('a failed refresh is not cached as an in-flight promise', async () => {
  let calls = 0;
  const manager = makeManager(async () => {
    calls++;
    return calls === 1
      ? jsonResponse({ error: 'invalid_client' })
      : jsonResponse({ access_token: 'recovered', expires_in: 3600 });
  });

  await assert.rejects(() => manager.getAccessToken());
  assert.equal(await manager.getAccessToken(), 'recovered', 'retry after failure should work');
});

test('non-JSON token responses are reported with the status code', async () => {
  const manager = makeManager(async () => new Response('<html>gateway error</html>', { status: 502 }));
  await assert.rejects(
    () => manager.getAccessToken(),
    (error) => {
      assert.equal(error.code, 'invalid_response');
      assert.match(error.message, /HTTP 502/);
      return true;
    },
  );
});

test('network failures name the endpoint that was unreachable', async () => {
  const manager = makeManager(async () => {
    throw new Error('ECONNREFUSED');
  });
  await assert.rejects(
    () => manager.getAccessToken(),
    (error) => {
      assert.equal(error.code, 'network_error');
      assert.match(error.message, /accounts\.zoho\.com/);
      return true;
    },
  );
});

test('buildAuthorizeUrl requests offline access so a refresh token comes back', () => {
  const url = new URL(
    buildAuthorizeUrl({
      dataCenter: DC,
      clientId: 'abc',
      redirectUri: 'http://localhost:53682/callback',
      scopes: ['ZohoMail.accounts.READ', 'ZohoMail.messages.ALL'],
      state: 'nonce-1',
    }),
  );

  assert.equal(url.origin + url.pathname, 'https://accounts.zoho.com/oauth/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('state'), 'nonce-1');
  assert.equal(
    url.searchParams.get('scope'),
    'ZohoMail.accounts.READ,ZohoMail.messages.ALL',
    'Zoho expects comma-separated scopes',
  );
});

test('exchangeCodeForTokens returns the refresh token on success', async () => {
  const result = await exchangeCodeForTokens({
    dataCenter: DC,
    clientId: 'c',
    clientSecret: 's',
    redirectUri: 'http://localhost:53682/callback',
    code: 'one-time-code',
    fetchImpl: async () =>
      jsonResponse({ refresh_token: 'rt', access_token: 'at', expires_in: 3600 }),
  });

  assert.equal(result.refreshToken, 'rt');
  assert.equal(result.accessToken, 'at');
});

test('a code exchange without a refresh token explains the single-use rule', async () => {
  await assert.rejects(
    () =>
      exchangeCodeForTokens({
        dataCenter: DC,
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'http://localhost:53682/callback',
        code: 'reused-code',
        fetchImpl: async () => jsonResponse({ access_token: 'at', expires_in: 3600 }),
      }),
    (error) => {
      assert.equal(error.code, 'no_refresh_token');
      assert.match(error.hint, /single-use/);
      return true;
    },
  );
});
