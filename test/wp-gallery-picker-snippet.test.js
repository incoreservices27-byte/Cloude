/**
 * The paste-in snippet is generated, so the risk is not the logic — it is that
 * generation mangles it. These tests render the snippet through PHP, check the
 * emitted script is byte-identical to the asset the other suite tests, and then
 * mount that emitted script to prove it still runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import jqueryFactory from 'jquery';

const SNIPPET = fileURLToPath(new URL('../dist-wp/immobilsesto-gallery-picker.snippet.php', import.meta.url));
const ASSET = fileURLToPath(new URL('../wordpress/immobilsesto-gallery-picker/assets/gallery-picker.js', import.meta.url));
const CSS_ASSET = fileURLToPath(new URL('../wordpress/immobilsesto-gallery-picker/assets/gallery-picker.css', import.meta.url));
const HARNESS = fileURLToPath(new URL('./fixtures/render-snippet.php', import.meta.url));

const hasPhp = spawnSync('php', ['-v']).status === 0;
const built = existsSync(SNIPPET);
const skip = !hasPhp
  ? 'php is not installed'
  : !built
    ? 'run `npm run build:wp-snippet` first'
    : false;

function render() {
  return execFileSync('php', [HARNESS, SNIPPET], { encoding: 'utf8' });
}

function section(html, id) {
  const match = html.match(new RegExp(`<(?:script|style) id="${id}">\\n?([\\s\\S]*?)\\n?</(?:script|style)>`));
  assert.ok(match, `missing block: ${id}`);
  return match[1];
}

test('the snippet emits the exact script that the picker tests cover', { skip }, () => {
  const emitted = section(render(), 'isgp-inline-script');

  assert.equal(
    emitted.trimEnd(),
    readFileSync(ASSET, 'utf8').trimEnd(),
    'generation must not alter the script',
  );
});

test('the snippet emits the exact stylesheet', { skip }, () => {
  const emitted = section(render(), 'isgp-inline-style');

  assert.equal(emitted.trimEnd(), readFileSync(CSS_ASSET, 'utf8').trimEnd());
});

test('the emitted config carries what the script reads', { skip }, () => {
  const raw = section(render(), 'isgp-inline-config')
    .replace(/^window\.ImmobilSestoGalleryPicker = /, '')
    .replace(/;$/, '');
  const config = JSON.parse(raw);

  assert.equal(config.action, 'immobilsesto_gallery_thumbs');
  assert.equal(config.nonce, 'stub-nonce');
  assert.match(config.ajaxUrl, /admin-ajax\.php$/);
  assert.ok(Array.isArray(config.selectors));
  assert.doesNotThrow(() => new RegExp(config.labelPattern, 'i'), 'label pattern must compile');
  assert.equal(typeof config.i18n.add, 'string');
});

test('the rendered snippet mounts the picker on a real listing form', { skip }, async () => {
  const html = render();
  const script = section(html, 'isgp-inline-script');
  const configLine = section(html, 'isgp-inline-config');

  const dom = new JSDOM(
    `<!doctype html><html><body><form id="post">
      <label for="gallery_ids">Gallery image IDs (comma separated)</label>
      <input type="text" id="gallery_ids" name="gallery_ids" value="18,19">
    </form></body></html>`,
    { runScripts: 'outside-only', url: 'https://example.test/wp-admin/post.php' },
  );
  const { window } = dom;

  const $ = jqueryFactory(window);
  window.jQuery = $;
  window.$ = $;
  $.post = () => ({
    done(fn) {
      fn({
        success: true,
        data: {
          items: [
            { id: 18, thumb: 'https://example.test/18.jpg', title: '', alt: '' },
            { id: 19, thumb: 'https://example.test/19.jpg', title: '', alt: '' },
          ],
          missing: [],
        },
      });
      return this;
    },
    fail() {
      return this;
    },
  });

  window.eval(configLine);
  window.eval(script);

  const deadline = Date.now() + 2000;
  while (!window.document.querySelector('.isgp-wrap')) {
    if (Date.now() > deadline) throw new Error('the snippet never mounted the picker');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(window.document.querySelectorAll('.isgp-item').length, 2, 'both images render');
  assert.ok(window.document.querySelector('.isgp-add'), 'the add/upload button is there');
  assert.equal(window.document.getElementById('gallery_ids').value, '18,19', 'IDs still stored');

  window.close();
});
