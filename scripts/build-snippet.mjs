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

const outDir = join(root, 'dist-wp');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'immobilsesto-gallery-picker.snippet.php');
writeFileSync(outFile, output);

console.log(`wrote ${outFile} (${output.length} bytes)`);
