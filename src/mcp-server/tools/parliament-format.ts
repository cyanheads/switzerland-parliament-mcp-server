/**
 * @fileoverview Lossless Markdown rendering and complete-result size measurement.
 * @module mcp-server/tools/parliament-format
 */

import { escapeMarkdownInline, markdownImage, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { utf8ByteLength } from '@/services/parliament/normalization.js';

/**
 * A single-record result at or above this complete MCP-result byte size carries a size notice naming
 * its narrower retrieval; nothing is cut. Collection pages are sized by the caller's limit alone.
 */
export const WHOLE_RESULT_NOTICE_BYTES = 24_000;

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
function renderField(name: string, value: unknown): string {
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

/** The domain formatter shared by every size measurement and the tool's format callback. */
export function formatParliamentResult(output: object): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: renderField('', output) }];
}

/** Trailer renderers for every enrichment field, rendering exactly what completeResultBytes measures. */
export function fieldTrailer<S extends object>(shape: S) {
  return Object.fromEntries(
    Object.keys(shape).map((key) => [key, { render: (value: unknown) => renderField(key, value) }]),
  ) as { [K in keyof S]: { render: (value: unknown) => string } };
}

/** Join the applicable notices in disclosure order; undefined when none apply. */
export function joinNotices(...notices: (string | false | undefined)[]): string | undefined {
  const applicable = notices.filter((notice) => typeof notice === 'string');
  return applicable.length > 0 ? applicable.join(' ') : undefined;
}

/** Disclose a requested page size reduced to the effective limit. */
export function clampNotice(requested: number, limit: number): string | undefined {
  return requested > limit ? `Requested limit ${requested} was clamped to ${limit}.` : undefined;
}

/** Whether an empty page's offset lies at or beyond a known nonzero total. */
export function isPastEnd(totalCount: number | undefined, offset: number): boolean {
  return totalCount !== undefined && totalCount > 0 && offset >= totalCount;
}

/** Measure the complete success result, including the framework's separate enrichment trailer block. */
export function completeResultBytes(output: object, enrichment: object): number {
  const trailer = Object.entries(enrichment)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => renderField(key, value))
    .join('\n');
  const content = formatParliamentResult(output);
  if (trailer) content.push({ type: 'text', text: `\n\n${trailer}` });
  return utf8ByteLength(
    JSON.stringify({ structuredContent: { ...output, ...enrichment }, content }),
  );
}
