/**
 * @fileoverview Reference tool contract, both consumption surfaces, and recovery boundaries.
 * @module tests/mcp-server/tools/list-reference.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { completeResultBytes } from '@/mcp-server/tools/parliament-format.js';
import { initParliamentService } from '@/services/parliament/parliament-service.js';
import { decodeParliamentMarkdown, parliamentHttp, textContent } from '../../helpers/parliament.js';

let http: ReturnType<typeof parliamentHttp>;
beforeEach(() => {
  initParliamentService();
  http = parliamentHttp(() => {
    throw new Error('Unexpected Parliament request.');
  });
});
afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

function serve(body: unknown, status = 200, headers?: Record<string, string>) {
  http.reset();
  http.route({
    match: () => true,
    respond: () => Response.json(body, { status, ...(headers && { headers }) }),
  });
}

describe('chparl_list_reference', () => {
  it.each(['identifiers', 'coverage', 'languages', 'statuses'] as const)(
    'publishes complete static %s with defaults, attribution and snapshot dates',
    async (topic) => {
      const result = await runToolContract(listReferenceTool, { topic });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        topic,
        effectiveFilters: { topic, language: 'de', limit: 50, offset: 0 },
        effectiveLimit: 50,
        hasMore: false,
        provenance: {
          attribution: 'Parlamentsdienste der Bundesversammlung, Bern',
          officialPublication: false,
        },
      });
      const text = textContent(result);
      expect(text).toContain('Parlamentsdienste der Bundesversammlung, Bern');
      expect(text).toContain(topic);
      expect(text).toContain('effectiveFilters');
      const decoded = decodeParliamentMarkdown(text);
      const parsed = listReferenceTool.output.parse(result.structuredContent);
      for (const item of parsed.items) {
        for (const value of Object.values(item)) {
          if (typeof value === 'string')
            expect(
              decoded.strings.some((line) => line.includes(value)),
              value,
            ).toBe(true);
        }
      }
      for (const source of parsed.provenance.sources) {
        expect(decoded.links).toContain(source.url);
        expect(text).toContain(source.retrievedAt);
      }
      expect(http.calls).toHaveLength(0);
    },
  );

  it('clamps above-max requests, normalizes form fields, and combines past-end guidance', async () => {
    serve({ d: { results: [], __count: '3' } });
    const result = await runToolContract(listReferenceTool, {
      topic: 'sessions',
      language: ' FR ',
      dateFrom: ' ',
      dateTo: '',
      limit: 10_000,
      offset: 9,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      items: [],
      effectiveFilters: { topic: 'sessions', language: 'fr', limit: 100, offset: 9 },
      returnedCount: 0,
      totalCount: 3,
      hasMore: false,
      notice: expect.stringContaining('clamped to 100'),
    });
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    const text = textContent(result);
    expect(text).toContain('past the last matching reference entry');
    expect(text).toContain('offset zero');
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.searchParams.get('$filter')).toBe("Language eq 'FR'");
    expect(url.searchParams.get('$top')).toBe('100');
  });

  it('distinguishes zero hits from past end while retaining empty source provenance', async () => {
    serve({ d: { results: [], __count: '0' } });
    const result = await runToolContract(listReferenceTool, {
      topic: 'sessions',
      dateFrom: '2099-01-01',
      dateTo: '2099-12-31',
    });
    expect(result.structuredContent).toMatchObject({
      items: [],
      totalCount: 0,
      hasMore: false,
      returnedCount: 0,
      provenance: { sources: [{ url: expect.any(String), retrievedAt: expect.any(String) }] },
    });
    expect(textContent(result)).toContain('No reference entries matched the query');
    expect(textContent(result)).not.toContain('past the last');
  });

  it('delivers a maximum page and a caller continuation from actual rows', async () => {
    serve({
      d: {
        results: Array.from({ length: 100 }, (_, index) => ({ ID: index + 1, Language: 'DE' })),
        __count: '101',
      },
    });
    const result = await runToolContract(listReferenceTool, { topic: 'councils', limit: 100 });
    expect(result.structuredContent).toMatchObject({
      returnedCount: 100,
      effectiveLimit: 100,
      nextOffset: 100,
      totalCount: 101,
      hasMore: true,
    });
    expect(listReferenceTool.output.parse(result.structuredContent).items).toHaveLength(100);
    expect(textContent(result)).toContain('100');
  });

  it('fits whole reference labels and measures the actual enriched result exactly', async () => {
    const originals = Array.from({ length: 20 }, (_, index) => ({
      ID: index + 1,
      Language: 'DE',
      CouncilName: `<p>${'原'.repeat(200)}\r\n\t${index}</p>`,
    }));
    serve({ d: { results: originals, __count: '40' } });
    const result = await runToolContract(listReferenceTool, {
      topic: 'councils',
      limit: 20,
      offset: 5,
    });
    expect(result.isError).not.toBe(true);
    const output = listReferenceTool.output.parse(result.structuredContent);
    const count = output.items.length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(20);
    expect(output.items).toEqual(
      originals.slice(0, count).map((item) => ({ id: String(item.ID), label: item.CouncilName })),
    );
    expect(result.structuredContent).toMatchObject({
      returnedCount: count,
      nextOffset: 5 + count,
      totalCount: 40,
      hasMore: true,
    });
    const enrichment = Object.fromEntries(
      Object.entries(result.structuredContent ?? {}).filter(
        ([key]) => !['topic', 'items', 'provenance'].includes(key),
      ),
    );
    const actualBytes = new TextEncoder().encode(
      JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
    ).byteLength;
    expect(completeResultBytes(output, enrichment)).toBe(actualBytes);
    expect(actualBytes).toBeLessThan(24_000);
    const decoded = decodeParliamentMarkdown(textContent(result));
    for (const original of originals.slice(0, count))
      expect(decoded.strings).toContain(original.CouncilName);
  });

  it('returns an oversized indivisible source label whole with its exact retrieval path', async () => {
    const label = `<p>${'é'.repeat(15_000)}</p>`;
    serve({ d: { results: [{ ID: 1, Language: 'DE', CouncilName: label }], __count: '1' } });
    const result = await runToolContract(listReferenceTool, { topic: 'councils', limit: 1 });
    expect(result.structuredContent).toMatchObject({
      items: [{ id: '1', label }],
      returnedCount: 1,
      hasMore: false,
      notice: expect.stringContaining('topic=councils, language=de, offset=0, limit=1'),
    });
    expect(decodeParliamentMarkdown(textContent(result)).strings).toContain(label);
  });

  it.each([
    { topic: 'councils', dateFrom: '2026-01-01' },
    { topic: 'sessions', dateFrom: '2026-02-01', dateTo: '2026-01-01' },
  ] as const)(
    'publishes incompatible-fields reason and actionable recovery for %o',
    async (input) => {
      const result = await runToolContract(listReferenceTool, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'incompatible_fields', recovery: { hint: expect.any(String) } },
        },
      });
      expect(textContent(result)).toContain('incompatible_fields');
      expect(textContent(result)).toContain('Recovery:');
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([
    { topic: 'councils', limit: 0 },
    { topic: 'councils', limit: 10_001 },
    { topic: 'councils', offset: -1 },
    { topic: 'councils', offset: Number.MAX_SAFE_INTEGER + 1 },
    { topic: 'sessions', dateFrom: '2026-02-30' },
    { topic: 'councils', language: 'en' },
  ] as const)('rejects invalid input before I/O (%o)', async (input) => {
    const result = await runToolContract(listReferenceTool, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('publishes rate-limit reason, Retry-After and recovery without source stack traces', async () => {
    serve({ error: { innererror: 'secret-dotnet-stack' } }, 429, { 'Retry-After': '999' });
    const result = await runToolContract(listReferenceTool, { topic: 'councils' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'upstream_rate_limited',
          retryAfter: '999',
          recovery: { hint: expect.stringContaining('topic coverage') },
        },
      },
    });
    const text = textContent(result);
    expect(text).toContain('upstream_rate_limited');
    expect(text).toContain('topic coverage');
    expect(JSON.stringify(result)).not.toContain('secret-dotnet-stack');
    expect(http.calls).toHaveLength(1);
  });

  it('settles caller cancellation on both public error surfaces', async () => {
    const reason = new DOMException('Stop Parliament research.', 'AbortError');
    const result = await runToolContract(
      listReferenceTool,
      { topic: 'councils' },
      { context: { signal: AbortSignal.abort(reason) } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled, message: 'Stop Parliament research.' },
    });
    expect(textContent(result)).toContain('Stop Parliament research.');
    expect(http.calls).toHaveLength(0);
  });
});
