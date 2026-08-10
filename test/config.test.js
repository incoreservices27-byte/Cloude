import test from 'node:test';
import assert from 'node:assert/strict';

import { DATA_CENTERS, resolveDataCenter, parseBoolean } from '../dist/config.js';

test('resolveDataCenter defaults to the US region', () => {
  assert.equal(resolveDataCenter(undefined).key, 'us');
  assert.equal(resolveDataCenter('').key, 'us');
});

test('resolveDataCenter accepts canonical keys, aliases, and stray dots', () => {
  assert.equal(resolveDataCenter('eu').apiHost, 'mail.zoho.eu');
  assert.equal(resolveDataCenter('IN').apiHost, 'mail.zoho.in');
  assert.equal(resolveDataCenter('india').key, 'in');
  assert.equal(resolveDataCenter('.com').key, 'us');
  assert.equal(resolveDataCenter('zoho.com.au').key, 'au');
  assert.equal(resolveDataCenter('canada').accountsHost, 'accounts.zohocloud.ca');
});

test('resolveDataCenter rejects unknown regions and lists the valid ones', () => {
  assert.throws(() => resolveDataCenter('mars'), /Unknown Zoho data center "mars"/);
  assert.throws(() => resolveDataCenter('mars'), /us, eu, in, au, jp, ca, sa, uk/);
});

test('every data center pairs an accounts host with an API host', () => {
  for (const [key, dc] of Object.entries(DATA_CENTERS)) {
    assert.equal(dc.key, key, `${key} key mismatch`);
    assert.match(dc.accountsHost, /^accounts\./, `${key} accounts host`);
    assert.match(dc.apiHost, /^mail\./, `${key} api host`);
    assert.match(dc.consoleUrl, /^https:\/\//, `${key} console url`);
  }
});

test('parseBoolean understands the usual spellings and falls back otherwise', () => {
  for (const truthy of ['1', 'true', 'TRUE', 'yes', 'y', 'on']) {
    assert.equal(parseBoolean(truthy, false), true, truthy);
  }
  for (const falsy of ['0', 'false', 'no', 'n', 'off']) {
    assert.equal(parseBoolean(falsy, true), false, falsy);
  }
  assert.equal(parseBoolean(undefined, true), true);
  assert.equal(parseBoolean('banana', true), true, 'unparseable input keeps the fallback');
});
