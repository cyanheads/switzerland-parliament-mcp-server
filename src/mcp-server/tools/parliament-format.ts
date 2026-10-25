/**
 * @fileoverview Lossless Markdown rendering and complete-result whole-item page fitting.
 * @module mcp-server/tools/parliament-format
 */

import { escapeMarkdownInline, markdownImage, markdownLink } from '@cyanheads/mcp-ts-core/utils';

/** At-the-max collection replies fit below this complete MCP-result byte size. */
export const COLLECTION_RESULT_LIMIT_BYTES = 24_000;

/** Render a string whose JSON decoding preserves CR/LF, raw HTML, and control characters exactly. */
export function renderOriginalString(value: string): string {
  if (
    Array.from(value).some((character) => character.charCodeAt(0) < 32) ||
    /<[^>]*>/.test(value)
  ) {
    const encoded = JSON.stringify(value);
    let longest = 0;
    for (const match of encoded.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `\n\n${fence}json\n${encoded}\n${fence}`;
  }
  const target = URL.parse(value);
  if (target && (target.protocol === 'http:' || target.protocol === 'https:'))
    return markdownLink(value, value);
  return escapeMarkdownInline(value);
}

/** Render every present field recursively; HTML-reference image/link indexes remain usable Markdown. */
export function renderField(name: string, value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0
      ? `**${escapeMarkdownInline(name)}:** []`
      : value.map((item, index) => renderField(`${name}[${index}]`, item)).join('\n\n');
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `**${escapeMarkdownInline(name)}:** {}`;
    return entries
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => {
        if (
          key === 'url' &&
          typeof item === 'string' &&
          'kind' in value &&
          value.kind === 'image'
        ) {
          return `**${escapeMarkdownInline(`${name}.${key}`)}:** ${markdownImage('image', item)}`;
        }
        return renderField(name ? `${name}.${key}` : key, item);
      })
      .join('\n\n');
  }
  const text = typeof value === 'string' ? renderOriginalString(value) : String(value);
  return `**${escapeMarkdownInline(name)}:** ${text}`;
}

/** The domain formatter shared by every prepared-page measurement and the tool's format callback. */
export function formatParliamentResult(output: object): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: renderField('', output) }];
}

/** Measure the complete success result, including the framework's separate enrichment trailer block. */
export function completeResultBytes(output: object, enrichment: object): number {
  const trailer = Object.entries(enrichment)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => renderField(key, value))
    .join('\n');
  const content = formatParliamentResult(output);
  if (trailer) content.push({ type: 'text', text: `\n\n${trailer}` });
  return new TextEncoder().encode(
    JSON.stringify({ structuredContent: { ...output, ...enrichment }, content }),
  ).byteLength;
}

/** A prepared page contains the exact domain and enrichment used for its wire-size decision. */
export interface PreparedPage<D extends object, E extends object> {
  readonly enrichment: E;
  readonly output: D;
}

/**
 * Fit whole items using final notices, continuation, both surfaces, and enrichment overhead.
 * The builder must use renderField for every enrichmentTrailer renderer and formatParliamentResult
 * for domain content. A single indivisible oversized item stays reachable; the builder receives
 * oversized=true to disclose its exact retrieval path instead of returning an empty looping page.
 */
export function fitCollectionPage<T, D extends object, E extends object>(
  items: readonly T[],
  build: (delivered: T[], cut: boolean, oversized: boolean) => PreparedPage<D, E>,
): PreparedPage<D, E> {
  let count = items.length;
  let page = build([...items], false, false);
  while (
    completeResultBytes(page.output, page.enrichment) >= COLLECTION_RESULT_LIMIT_BYTES &&
    count > 1
  ) {
    count--;
    page = build(items.slice(0, count), true, false);
  }
  if (completeResultBytes(page.output, page.enrichment) >= COLLECTION_RESULT_LIMIT_BYTES) {
    page = build(items.slice(0, count), count < items.length, true);
  }
  return page;
}
