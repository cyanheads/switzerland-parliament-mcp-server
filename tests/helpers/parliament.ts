/**
 * @fileoverview Strict synthetic Parliament HTTP fixtures and public Markdown decoding.
 * @module tests/helpers/parliament
 */

import { createFetchMock, type FetchMockResponder } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt from 'markdown-it';

/** Install a strict GET-only fake at Parliament's fixed upstream origin. */
export function parliamentHttp(respond: FetchMockResponder) {
  const http = createFetchMock([
    {
      method: 'GET',
      match: (request) => {
        const url = new URL(request.url);
        return (
          url.origin === 'https://ws.parlament.ch' && /^\/(?:odata|OData)\.svc\//.test(url.pathname)
        );
      },
      respond,
    },
  ]);
  http.install();
  return http;
}

/** Join the text blocks exposed to a content-only MCP consumer. */
export function textContent(result: {
  content: readonly { type: string; text?: string }[];
}): string {
  return result.content
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

/** Decode CommonMark text, JSON string fences, and usable link/image destinations independently. */
export function decodeParliamentMarkdown(markdown: string) {
  const tokens = new MarkdownIt('commonmark').parse(markdown, {});
  const strings: string[] = [];
  const links: string[] = [];
  const images: string[] = [];
  for (const token of tokens) {
    if (token.type === 'fence' && token.info === 'json') {
      const value: unknown = JSON.parse(token.content);
      if (typeof value !== 'string') throw new Error('Expected a JSON string fence.');
      strings.push(value);
    }
    if (token.type !== 'inline') continue;
    let line = '';
    for (const child of token.children ?? []) {
      if (child.type === 'text' || child.type === 'code_inline') line += child.content;
      if (child.type === 'softbreak' || child.type === 'hardbreak') line += '\n';
      if (child.type === 'link_open') links.push(String(child.attrGet('href') ?? ''));
      if (child.type === 'image') images.push(String(child.attrGet('src') ?? ''));
    }
    strings.push(line);
  }
  return { strings, links, images };
}
