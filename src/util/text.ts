/**
 * Small text helpers. Message bodies arrive as HTML far more often than not,
 * and handing raw markup to a model burns context on markup it will ignore —
 * so the default read path converts to text.
 */

const BLOCK_TAGS = /<\/?(?:p|div|br|tr|li|h[1-6]|table|blockquote|section|article)\b[^>]*>/gi;

/**
 * `</li><li>` is one item boundary, not two. Collapsing the closing/opening
 * pair first keeps long lists and tables from acquiring a blank line between
 * every row, while paragraph breaks still survive as `\n\n`.
 */
const ITEM_BOUNDARIES = /<\/(li|tr|td|th)>\s*<\1\b[^>]*>/gi;

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
});

/** Converts an HTML mail body to readable plain text. */
export function htmlToText(html: string): string {
  return html
    // Drop anything whose text content is not prose.
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Preserve block structure as newlines before stripping the rest.
    .replace(ITEM_BOUNDARIES, '\n')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code: string) => safeFromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCharCode(Number.parseInt(hex, 16)))
    .replace(/&[a-z]+;|&#\d+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function safeFromCharCode(code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** Truncates long bodies, telling the reader what was cut rather than hiding it. */
export function truncateBody(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text:
      `${text.slice(0, maxChars)}\n\n[…truncated ${text.length - maxChars} more characters. ` +
      `Call get_email again with a larger max_chars to read the rest.]`,
    truncated: true,
  };
}

/** Naive but adequate check for whether a body is markup or already plain text. */
export function looksLikeHtml(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}
