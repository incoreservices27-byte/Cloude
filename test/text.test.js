import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlToText, truncateBody, looksLikeHtml } from '../dist/util/text.js';

test('htmlToText keeps prose and drops markup', () => {
  const html = '<div><p>Hello <b>Ada</b>,</p><p>The report is ready.</p></div>';
  assert.equal(htmlToText(html), 'Hello Ada,\n\nThe report is ready.');
});

test('htmlToText discards script, style, and comment content entirely', () => {
  const html =
    '<style>.x{color:red}</style><script>alert(1)</script><!-- hidden --><p>Visible</p>';
  const text = htmlToText(html);
  assert.equal(text, 'Visible');
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('hidden'));
});

test('htmlToText decodes named and numeric entities', () => {
  assert.equal(htmlToText('<p>Tom &amp; Jerry&nbsp;&mdash; 100&#37; done</p>'), 'Tom & Jerry — 100% done');
  assert.equal(htmlToText('<p>&#x41;&#x42;</p>'), 'AB');
});

test('htmlToText turns table and list structure into line breaks', () => {
  assert.equal(htmlToText('<ul><li>one</li><li>two</li></ul>'), 'one\ntwo');
});

test('htmlToText collapses runaway blank lines', () => {
  assert.equal(htmlToText('<p>a</p><br><br><br><br><p>b</p>'), 'a\n\nb');
});

test('truncateBody leaves short bodies alone', () => {
  const result = truncateBody('short', 100);
  assert.equal(result.truncated, false);
  assert.equal(result.text, 'short');
});

test('truncateBody cuts long bodies and says how much was dropped', () => {
  const result = truncateBody('x'.repeat(150), 100);
  assert.equal(result.truncated, true);
  assert.ok(result.text.startsWith('x'.repeat(100)));
  assert.match(result.text, /truncated 50 more characters/);
});

test('looksLikeHtml distinguishes markup from plain text', () => {
  assert.equal(looksLikeHtml('<p>hi</p>'), true);
  assert.equal(looksLikeHtml('plain text, 3 < 5 and 9 > 2'), false);
});
