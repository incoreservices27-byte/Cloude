/**
 * Builds the single-file snippet from the plugin's assets, so the paste-in
 * version and the zip version can never drift apart.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'wordpress', 'immobilsesto-gallery-picker');

const css = readFileSync(join(pluginDir, 'assets', 'gallery-picker.css'), 'utf8').trimEnd();
const js = readFileSync(join(pluginDir, 'assets', 'gallery-picker.js'), 'utf8').trimEnd();
const template = readFileSync(join(root, 'wordpress', 'snippet', 'template.php'), 'utf8');

/**
 * A nowdoc ends at a line that is exactly its terminator, and inlined JS ends at
 * the first `</script`. Either appearing in the assets would produce a file that
 * looks fine and breaks at runtime, so fail the build instead.
 */
function assertSafe(name, source, terminator) {
  const clash = source.split('\n').findIndex((line) => line.trimStart().startsWith(terminator));
  if (clash !== -1) {
    throw new Error(`${name}: line ${clash + 1} would close the heredoc early`);
  }
  if (/<\/script/i.test(source)) {
    throw new Error(`${name}: contains a script-tag terminator and cannot be inlined`);
  }
}

assertSafe('gallery-picker.css', css, 'ISGP_CSS;');
assertSafe('gallery-picker.js', js, 'ISGP_JS;');

if (!template.includes('__GALLERY_PICKER_CSS__') || !template.includes('__GALLERY_PICKER_JS__')) {
  throw new Error('template.php is missing one of its placeholders');
}

// Replacer functions, not strings: a string replacement expands `$&`, `$'` and
// friends, and the script contains a literal '\\$&' in its CSS-escape fallback.
const output = template
  .replace('__GALLERY_PICKER_CSS__', () => css)
  .replace('__GALLERY_PICKER_JS__', () => js);

/**
 * Code Snippets strips PHP tags from pasted code, so anything after the opening
 * tag that leaves PHP mode comes back as bare markup inside a PHP block — which
 * surfaces as a misleading "Unmatched '}'". The snippet must therefore be one
 * uninterrupted PHP block.
 */
const openTags = output.match(/<\?(?:php|=)?/g) || [];
const closeTags = output.match(/\?>/g) || [];
if (openTags.length !== 1 || !output.startsWith('<?php')) {
  throw new Error(`snippet must contain exactly one opening PHP tag, at the very start (found ${openTags.length})`);
}
if (closeTags.length !== 0) {
  throw new Error(`snippet must not close PHP mode (found ${closeTags.length} \`?>\`)`);
}

const outDir = join(root, 'dist-wp');
mkdirSync(outDir, { recursive: true });

const outFile = join(outDir, 'immobilsesto-gallery-picker.snippet.php');
writeFileSync(outFile, output);

// Code Snippets supplies its own opening tag and expects the body without one.
// Shipping that variant removes a manual edit step, which is a step that can go
// wrong.
const pasteFile = join(outDir, 'immobilsesto-gallery-picker.code-snippets.txt');
const paste = output.replace(/^<\?php\r?\n/, '');
if (/<\?(?:php|=)?|\?>/.test(paste)) {
  throw new Error('the paste variant still contains a PHP tag');
}
writeFileSync(pasteFile, paste);

console.log(`wrote ${outFile} (${output.length} bytes)`);
console.log(`wrote ${pasteFile} (${paste.length} bytes, no opening tag)`);
