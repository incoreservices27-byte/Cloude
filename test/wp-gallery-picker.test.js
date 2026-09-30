/**
 * Exercises the gallery picker against a DOM shaped like the real listing form:
 * a features select, a long-description textarea, and the comma-separated
 * gallery ID input it is meant to take over. Only the AJAX call and the media
 * modal are faked — the field detection, rendering and value syncing are the
 * real code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import jqueryFactory from 'jquery';

const SCRIPT = readFileSync(
  new URL('../wordpress/immobilsesto-gallery-picker/assets/gallery-picker.js', import.meta.url),
  'utf8',
);

const LONG_DESCRIPTION =
  'Villino indipendente disposto su due livelli con giardino privato su tre lati.\n' +
  'Al primo piano tre camere da letto luminose, bagno principale con vasca e ripostiglio.';

const FORM = `<!doctype html><html><body>
  <form id="post">
    <div class="postbox">
      <p>
        <label for="listing_features">Features</label>
        <select id="listing_features" name="listing_features" multiple>
          <option selected>Doppi servizi</option>
          <option selected>Aria condizionata</option>
        </select>
      </p>
      <p>
        <label for="listing_long_desc">Long description (one paragraph per line)</label>
        <textarea id="listing_long_desc" name="listing_long_desc">${LONG_DESCRIPTION}</textarea>
      </p>
      <p>
        <label for="listing_gallery_ids">Gallery image IDs (comma separated)</label>
        <input type="text" id="listing_gallery_ids" name="listing_gallery_ids" value="18,19,20,21">
      </p>
    </div>
  </form>
</body></html>`;

/** Polls until `check` is truthy, so tests never depend on timer ordering. */
async function waitFor(check, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('timed out waiting for the picker to mount');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A jqXHR stand-in that resolves synchronously, so tests stay deterministic. */
function settled(response, succeed = true) {
  const api = {
    done(fn) {
      if (succeed) fn(response);
      return api;
    },
    fail(fn) {
      if (!succeed) fn();
      return api;
    },
  };
  return api;
}

function installMediaStub(window) {
  const frames = [];

  window.wp = {
    media(options) {
      const handlers = Object.create(null);
      let selection = [];

      const frame = {
        options,
        opened: 0,
        on(event, cb) {
          (handlers[event] ||= []).push(cb);
          return frame;
        },
        open() {
          frame.opened += 1;
          (handlers.open || []).forEach((fn) => fn());
        },
        state() {
          return {
            get() {
              return {
                each(cb) {
                  selection.forEach((model) => cb({ toJSON: () => model }));
                },
                reset() {
                  selection = [];
                },
              };
            },
          };
        },
        /** Test hook: pretend the user ticked these and hit "Add to gallery". */
        choose(models) {
          selection = models;
          (handlers.select || []).forEach((fn) => fn());
        },
      };

      frames.push(frame);
      return frame;
    },
  };

  return frames;
}

const DEFAULT_RESPONSE = {
  success: true,
  data: {
    items: [
      { id: 18, thumb: 'https://example.test/18-150x150.jpg', title: 'Facciata', alt: 'Facciata' },
      { id: 19, thumb: 'https://example.test/19-150x150.jpg', title: 'Soggiorno', alt: '' },
      { id: 20, thumb: 'https://example.test/20-150x150.jpg', title: 'Cucina', alt: '' },
    ],
    missing: [21],
  },
};

async function setup({ response = DEFAULT_RESPONSE, succeed = true, html = FORM, inputId = 'listing_gallery_ids' } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://example.test/wp-admin/post.php' });
  const { window } = dom;

  const $ = jqueryFactory(window);
  window.jQuery = $;
  window.$ = $;

  const posts = [];
  $.post = (url, data) => {
    posts.push({ url, data });
    return settled(response, succeed);
  };

  const confirmations = [];
  window.confirm = (message) => {
    confirmations.push(message);
    return true;
  };

  const frames = installMediaStub(window);

  window.ImmobilSestoGalleryPicker = {
    ajaxUrl: 'https://example.test/wp-admin/admin-ajax.php',
    action: 'immobilsesto_gallery_thumbs',
    nonce: 'test-nonce',
    selectors: ['[data-gallery-picker]'],
    labelPattern: 'galler(y|ia)\\s*(image|immagin\\w*)?\\s*(id|ids)?',
    i18n: {},
  };

  window.eval(SCRIPT);
  // jQuery defers its ready callback onto the window's own timer queue, which
  // is not ordered against Node's — so wait for the widget rather than a tick.
  await waitFor(() => window.document.querySelector('.isgp-wrap'));

  const document = window.document;
  const input = document.getElementById(inputId);

  return {
    window,
    document,
    input,
    posts,
    frames,
    confirmations,
    tiles: () => [...document.querySelectorAll('.isgp-item')],
    ids: () => input.value,
    close: () => window.close(),
  };
}

function clickIn(tile, selector) {
  tile.querySelector(selector).dispatchEvent(new tile.ownerDocument.defaultView.MouseEvent('click', { bubbles: true }));
}

test('takes over the gallery field and hides the raw input', async () => {
  const ctx = await setup();

  assert.equal(ctx.document.querySelectorAll('.isgp-wrap').length, 1, 'one widget');
  assert.ok(ctx.input.classList.contains('isgp-source'), 'raw input is hidden by class');
  assert.equal(ctx.input.dataset.isgpBound, '1', 'field is marked so it is not enhanced twice');
  assert.ok(ctx.document.querySelector('.isgp-add'), 'an add/upload button exists');

  ctx.close();
});

test('asks the server for every saved ID in one request', async () => {
  const ctx = await setup();

  assert.equal(ctx.posts.length, 1, 'one round trip, not one per image');
  assert.equal(ctx.posts[0].data.ids, '18,19,20,21');
  assert.equal(ctx.posts[0].data.nonce, 'test-nonce');
  assert.equal(ctx.posts[0].data.action, 'immobilsesto_gallery_thumbs');

  ctx.close();
});

test('renders a tile per ID in the order the field stored them', async () => {
  const ctx = await setup();
  const tiles = ctx.tiles();

  assert.deepEqual(
    tiles.map((tile) => tile.getAttribute('data-id')),
    ['18', '19', '20', '21'],
  );
  assert.equal(tiles[0].querySelector('img').src, 'https://example.test/18-150x150.jpg');
  assert.equal(tiles[0].querySelector('img').alt, 'Facciata');
  assert.ok(tiles[0].querySelector('.isgp-main'), 'first tile is marked as the main image');

  ctx.close();
});

test('flags a deleted attachment instead of silently dropping its ID', async () => {
  const ctx = await setup();
  const missing = ctx.tiles()[3];

  assert.ok(missing.classList.contains('isgp-item-missing'));
  assert.equal(ctx.ids(), '18,19,20,21', 'the ID survives so it can be fixed, not lost on save');

  ctx.close();
});

test('leaves the long-description textarea alone', async () => {
  const ctx = await setup();
  const textarea = ctx.document.getElementById('listing_long_desc');

  assert.equal(textarea.dataset.isgpBound, undefined, 'prose is never mistaken for an ID list');
  assert.ok(!textarea.classList.contains('isgp-source'));
  assert.equal(textarea.value, LONG_DESCRIPTION, 'and its content is untouched');

  ctx.close();
});

test('removing a tile rewrites the stored IDs', async () => {
  const ctx = await setup();

  clickIn(ctx.tiles()[1], '.isgp-remove');

  assert.equal(ctx.ids(), '18,20,21');
  assert.deepEqual(
    ctx.tiles().map((tile) => tile.getAttribute('data-id')),
    ['18', '20', '21'],
  );

  ctx.close();
});

test('the arrow controls reorder the gallery for keyboard users', async () => {
  const ctx = await setup();

  clickIn(ctx.tiles()[0], '.isgp-right');
  assert.equal(ctx.ids(), '19,18,20,21');

  clickIn(ctx.tiles()[2], '.isgp-left');
  assert.equal(ctx.ids(), '19,20,18,21');

  const first = ctx.tiles()[0];
  assert.ok(first.querySelector('.isgp-left').disabled, 'cannot move the first tile earlier');
  assert.ok(ctx.tiles()[3].querySelector('.isgp-right').disabled, 'nor the last one later');

  ctx.close();
});

test('choosing images in the media modal appends them without duplicating', async () => {
  const ctx = await setup();

  ctx.document.querySelector('.isgp-add').click();
  assert.equal(ctx.frames.length, 1, 'one frame is built');
  assert.equal(ctx.frames[0].options.library.type, 'image', 'restricted to images');
  assert.equal(ctx.frames[0].options.multiple, true, 'multi-select is on');

  ctx.frames[0].choose([
    { id: 33, url: 'https://example.test/33.jpg', sizes: { thumbnail: { url: 'https://example.test/33-150.jpg' } } },
    { id: 18, url: 'https://example.test/18.jpg' },
  ]);

  assert.equal(ctx.ids(), '18,19,20,21,33', 'the new one is appended, the existing one ignored');
  assert.equal(ctx.tiles()[4].querySelector('img').src, 'https://example.test/33-150.jpg');

  ctx.document.querySelector('.isgp-add').click();
  assert.equal(ctx.frames.length, 1, 'the frame is reused, not rebuilt');

  ctx.close();
});

test('reopening the modal does not re-add the previous selection', async () => {
  const ctx = await setup();

  ctx.document.querySelector('.isgp-add').click();
  ctx.frames[0].choose([{ id: 33, url: 'https://example.test/33.jpg' }]);
  assert.equal(ctx.ids(), '18,19,20,21,33');

  // Opening clears the frame's selection; selecting nothing must change nothing.
  ctx.document.querySelector('.isgp-add').click();
  ctx.frames[0].choose([]);

  assert.equal(ctx.ids(), '18,19,20,21,33');

  ctx.close();
});

test('remove all empties the field once confirmed', async () => {
  const ctx = await setup();

  ctx.document.querySelector('.isgp-clear').click();

  assert.equal(ctx.confirmations.length, 1, 'destructive action is confirmed first');
  assert.equal(ctx.ids(), '');
  assert.equal(ctx.tiles().length, 0);
  assert.notEqual(
    ctx.document.querySelector('.isgp-empty').style.display,
    'none',
    'the empty-state note comes back',
  );

  ctx.close();
});

test('the manual escape hatch reveals the ID field and re-reads it', async () => {
  const ctx = await setup();
  const toggle = ctx.document.querySelector('.isgp-toggle');

  toggle.click();
  assert.ok(ctx.input.classList.contains('isgp-source-visible'), 'raw field is shown');

  ctx.input.value = '7; 8  9';
  ctx.input.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));

  assert.equal(ctx.posts.length, 2, 'the typed IDs are looked up');
  assert.equal(ctx.posts[1].data.ids, '7,8,9', 'semicolons and spaces parse like commas');

  ctx.close();
});

test('a failed lookup keeps the IDs and says so', async () => {
  const ctx = await setup({ succeed: false });

  assert.equal(ctx.ids(), '18,19,20,21', 'nothing is destroyed when the server is unreachable');
  assert.equal(ctx.tiles().length, 4, 'the IDs still render as tiles');
  assert.ok(
    ctx.document.querySelector('.isgp-status').classList.contains('isgp-status-error'),
    'the failure is visible rather than silent',
  );

  ctx.close();
});

test('an empty field starts with no tiles and no lookup', async () => {
  const html = FORM.replace('value="18,19,20,21"', 'value=""');
  const ctx = await setup({ html });

  assert.equal(ctx.posts.length, 0, 'nothing to look up');
  assert.equal(ctx.tiles().length, 0);
  assert.ok(ctx.document.querySelector('.isgp-add'), 'but the picker is still offered');

  ctx.close();
});

test('the field is found by name when its label says nothing useful', async () => {
  const html = FORM.replace(
    '<label for="listing_gallery_ids">Gallery image IDs (comma separated)</label>',
    '<label for="listing_gallery_ids">Immagini</label>',
  );
  const ctx = await setup({ html });

  assert.equal(ctx.input.dataset.isgpBound, '1', 'the name attribute carries it');
  assert.equal(ctx.tiles().length, 4);

  ctx.close();
});

test('editing through the grid does not re-query the server', async () => {
  const ctx = await setup();

  ctx.document.querySelector('.isgp-toggle').click();
  const before = ctx.posts.length;

  clickIn(ctx.tiles()[0], '.isgp-remove');

  assert.equal(ctx.posts.length, before, 'the grid already has the thumbnails it needs');
  assert.equal(ctx.ids(), '19,20,21');

  ctx.close();
});

test('the arrow keeps focus so it can be pressed again', async () => {
  const ctx = await setup();

  clickIn(ctx.tiles()[0], '.isgp-right');
  assert.equal(ctx.ids(), '19,18,20,21');

  const focused = ctx.document.activeElement;
  assert.ok(focused.classList.contains('isgp-right'), 'focus follows the tile that moved');

  focused.click();
  assert.equal(ctx.ids(), '19,20,18,21', 'a second press moves it on rather than back');

  ctx.close();
});

test('an explicit selector overrides the looks-like-IDs guard', async () => {
  const html = FORM.replace(
    '<input type="text" id="listing_gallery_ids" name="listing_gallery_ids" value="18,19,20,21">',
    '<input type="text" id="odd_field" name="odd_field" value="img-18" data-gallery-picker>',
  );
  const ctx = await setup({ html, inputId: 'odd_field' });

  assert.equal(ctx.input.dataset.isgpBound, '1', 'opting in beats the heuristic');
  assert.equal(ctx.tiles().length, 1, 'the one parseable ID still renders');

  ctx.close();
});

/**
 * The real form is a flat run of label/control pairs inside one container, so a
 * backwards label search must stop at the previous control — otherwise the
 * field *after* the gallery input inherits the gallery's label.
 */
const FLAT_FORM = `<!doctype html><html><body>
  <form id="post">
    <div class="postbox">
      <label for="year_built">Year built</label>
      <input type="text" id="year_built" name="year_built" value="1998">
      <label for="energy_class">Energy class</label>
      <input type="text" id="energy_class" name="energy_class" value="C">
      <label for="heating">Heating</label>
      <input type="text" id="heating" name="heating" value="Autonomo a gas">
      <label for="map_query">Map query (address for map)</label>
      <input type="text" id="map_query" name="map_query" value="Sesto Fiorentino, Firenze">
      <label for="features">Features (one per line)</label>
      <textarea id="features" name="features">Giardino privato
Box auto
Camino</textarea>
      <label for="long_desc">Long description (one paragraph per line)</label>
      <textarea id="long_desc" name="long_desc">${LONG_DESCRIPTION}</textarea>
      <label for="gallery_ids">Gallery image IDs (comma separated)</label>
      <input type="text" id="gallery_ids" name="gallery_ids" value="18,19,20,21">
      <label for="price">Price</label>
      <input type="text" id="price" name="price" value="450000">
    </div>
  </form>
</body></html>`;

test('enhances only the gallery field in a flat form', async () => {
  const ctx = await setup({ html: FLAT_FORM, inputId: 'gallery_ids' });

  assert.equal(ctx.input.dataset.isgpBound, '1', 'the gallery field is taken over');
  assert.equal(ctx.document.querySelectorAll('.isgp-wrap').length, 1, 'exactly one widget');

  for (const id of ['year_built', 'energy_class', 'heating', 'map_query', 'features', 'long_desc', 'price']) {
    const field = ctx.document.getElementById(id);
    assert.equal(field.dataset.isgpBound, undefined, `${id} must be left alone`);
  }

  ctx.close();
});

test('a numeric field following the gallery does not inherit its label', async () => {
  const ctx = await setup({ html: FLAT_FORM, inputId: 'gallery_ids' });
  const price = ctx.document.getElementById('price');

  assert.equal(price.dataset.isgpBound, undefined, 'the next field is not the gallery');
  assert.equal(price.value, '450000', 'and its value is untouched');

  ctx.close();
});

test('a field named only "gallery" is still recognised', async () => {
  const html = FORM
    .replace(
      '<label for="listing_gallery_ids">Gallery image IDs (comma separated)</label>',
      '<label for="listing_gallery_ids">Immagini</label>',
    )
    .replace('name="listing_gallery_ids"', 'name="gallery"');
  const ctx = await setup({ html });

  assert.equal(ctx.input.dataset.isgpBound, '1', 'no "id" part needed in the name');
  assert.equal(ctx.tiles().length, 4);

  ctx.close();
});

test('isgpReport lists every field and which one was taken over', async () => {
  const ctx = await setup();

  const rows = ctx.window.isgpReport();
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

  assert.ok(rows.length >= 2, 'reports the fields on the page');
  assert.equal(byName.listing_gallery_ids.enhanced, true, 'says which field it took');
  assert.equal(byName.listing_long_desc.enhanced, false, 'and which it did not');
  assert.match(byName.listing_gallery_ids.label, /Gallery image IDs/, 'shows the label it judged');

  ctx.close();
});
