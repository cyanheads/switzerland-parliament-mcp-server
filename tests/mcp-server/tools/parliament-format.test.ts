/**
 * @fileoverview Lossless CommonMark reconstruction and complete-result whole-item fitting.
 * @module tests/mcp-server/tools/parliament-format.test
 */

import { describe, expect, it } from 'vitest';
import {
  completeResultBytes,
  fitCollectionPage,
  formatParliamentResult,
  renderOriginalString,
} from '@/mcp-server/tools/parliament-format.js';
import { decodeParliamentMarkdown } from '../../helpers/parliament.js';

describe('Parliament content rendering', () => {
  it.each([
    'Été & _emphasis_ [link](https://example.test) ![image](x) < > \\ * ~ # + - . |',
    'line 1\r\nline 2\n\t\u0000\b',
    '<pd_text>原文 <a href="https://example.test/x">été</a></pd_text>',
    '<p>before `````` after</p>\r\n',
    ' leading and trailing ',
    '',
  ])('reconstructs original string bytes from CommonMark (%j)', (value) => {
    const rendered = renderOriginalString(value);
    const decoded = decodeParliamentMarkdown(rendered);
    expect(decoded.strings.join('')).toBe(value);
  });

  it('renders nested optional arms, empty collections, links and images together', () => {
    const output = {
      records: [
        {
          id: '9007199254740993',
          html: '<p>Original\r\ntexte</p>',
          references: [
            {
              kind: 'image',
              originalUrl: 'https://example.test/image.png',
              url: 'https://example.test/image.png',
            },
            {
              kind: 'link',
              originalUrl: 'https://example.test/page',
              url: 'https://example.test/page',
            },
          ],
        },
      ],
      empty: [],
      emptyObject: {},
      falseValue: false,
      zero: 0,
      missing: undefined,
    };
    const text = formatParliamentResult(output)[0]?.text ?? '';
    const decoded = decodeParliamentMarkdown(text);
    expect(decoded.strings).toContain('<p>Original\r\ntexte</p>');
    expect(decoded.links).toContain('https://example.test/page');
    expect(decoded.images).toEqual(['https://example.test/image.png']);
    expect(text).toContain('9007199254740993');
    expect(text).toContain('[]');
    expect(text).toContain('{}');
    expect(text).toContain('false');
    expect(text).not.toContain('missing');
  });

  it('preserves a large original HTML field with many distinct backtick runs', () => {
    const original = `<p>${'a`'.repeat(150_000)}</p>`;
    expect(decodeParliamentMarkdown(renderOriginalString(original)).strings).toEqual([original]);
  });

  it('fits final notices and duplicated UTF-8 content by removing only whole items', () => {
    const originals = Array.from({ length: 8 }, (_, index) => ({
      id: String(index + 1),
      text: '原'.repeat(1200),
    }));
    const prepared = fitCollectionPage(originals, (items, cut, oversized) => ({
      output: { items },
      enrichment: {
        returnedCount: items.length,
        totalCount: 8,
        hasMore: cut,
        ...(cut && {
          nextOffset: 10 + items.length,
          notice: 'Continue with nextOffset. Whole fields retained.',
        }),
        ...(oversized && { oversized: true }),
      },
    }));
    expect(prepared.output.items.length).toBeGreaterThan(0);
    expect(prepared.output.items.length).toBeLessThan(8);
    expect(prepared.output.items).toEqual(originals.slice(0, prepared.output.items.length));
    expect(prepared.enrichment.nextOffset).toBe(10 + prepared.output.items.length);
    expect(completeResultBytes(prepared.output, prepared.enrichment)).toBeLessThan(24_000);
    expect(originals).toHaveLength(8);
  });

  it('keeps one indivisible oversized item reachable and accepts an empty page', () => {
    const item = { id: '1', text: 'é'.repeat(20_000) };
    const build = (items: (typeof item)[], cut: boolean, oversized: boolean) => ({
      output: { items },
      enrichment: { cut, oversized },
    });
    const prepared = fitCollectionPage([item, { id: '2', text: 'small' }], build);
    expect(prepared).toEqual({
      output: { items: [item] },
      enrichment: { cut: true, oversized: true },
    });
    expect(completeResultBytes(prepared.output, prepared.enrichment)).toBeGreaterThan(24_000);
    expect(fitCollectionPage([], build)).toEqual({
      output: { items: [] },
      enrichment: { cut: false, oversized: false },
    });
  });
});
