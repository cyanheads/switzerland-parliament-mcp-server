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
import {
  decodeParliamentMarkdown,
  parliamentHttp,
  resultBytes,
  textContent,
} from '../../helpers/parliament.js';

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
      query: ' ',
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
    expect(result.structuredContent).not.toHaveProperty('effectiveFilters.query');
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

  it.each([
    {
      topic: 'sessions',
      notice:
        'The requested offset is past the last matching reference entry. No reference entries occur on this page. Call chparl_list_reference for this topic with offset zero, or revise the session dates.',
    },
    {
      topic: 'committees',
      notice:
        'The requested offset is past the last matching reference entry. No reference entries occur on this page. Call chparl_list_reference for this topic with offset zero.',
    },
  ] as const)(
    'advises session dates past the end only for a dated topic: $topic',
    async ({ topic, notice }) => {
      serve({ d: { results: [], __count: '3' } });
      const result = await runToolContract(listReferenceTool, { topic, offset: 9 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        items: [],
        totalCount: 3,
        hasMore: false,
        notice,
      });
      expect(textContent(result)).toContain(notice);
    },
  );

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

  it('delivers every large label on a full page and measures the actual enriched result exactly', async () => {
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
    expect(output.items).toEqual(
      originals.map((item) => ({ id: String(item.ID), label: item.CouncilName })),
    );
    expect(result.structuredContent).toMatchObject({
      returnedCount: 20,
      effectiveLimit: 20,
      nextOffset: 25,
      totalCount: 40,
      hasMore: true,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    const enrichment = Object.fromEntries(
      Object.entries(result.structuredContent ?? {}).filter(
        ([key]) => !['topic', 'items', 'provenance'].includes(key),
      ),
    );
    const actualBytes = resultBytes(result);
    expect(completeResultBytes(output, enrichment)).toBe(actualBytes);
    expect(actualBytes).toBeGreaterThan(24_000);
    const decoded = decodeParliamentMarkdown(textContent(result));
    for (const original of originals) expect(decoded.strings).toContain(original.CouncilName);
  });

  it('returns a label over 24,000 bytes whole on a limit 1 page with no size notice', async () => {
    const label = `<p>${'é'.repeat(15_000)}</p>`;
    serve({ d: { results: [{ ID: 1, Language: 'DE', CouncilName: label }], __count: '2' } });
    const result = await runToolContract(listReferenceTool, { topic: 'councils', limit: 1 });
    expect(result.structuredContent).toMatchObject({
      items: [{ id: '1', label }],
      returnedCount: 1,
      nextOffset: 1,
      hasMore: true,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(resultBytes(result)).toBeGreaterThan(24_000);
    expect(decodeParliamentMarkdown(textContent(result)).strings).toContain(label);
  });

  it('pages a committee query over the filtered set and echoes query on both surfaces', async () => {
    const committee = (number: number, abbreviation: string, name: string) => ({
      ID: number * 10,
      Language: 'DE',
      CommitteeNumber: number,
      CommitteeName: name,
      Abbreviation1: abbreviation,
    });
    const pages: Record<string, unknown[]> = {
      '0': [
        committee(10, 'WAK-N', 'Kommission für Wirtschaft und Abgaben Nationalrat'),
        committee(23, 'WAK-S', 'Kommission für Wirtschaft und Abgaben Ständerat'),
      ],
      '2': [
        committee(1131, 'WAK-N WAK-N 17.400', 'Subkommission'),
        committee(10011, 'WAK-N SUBKO 23.462', 'Subkommission'),
      ],
      '4': [],
    };
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json({
          d: {
            results: pages[new URL(request.url).searchParams.get('$skip') ?? ''],
            __count: '4',
          },
        }),
    });
    const walk = [];
    for (const offset of [0, 2, 4])
      walk.push(
        await runToolContract(listReferenceTool, {
          topic: 'committees',
          query: ' WAK ',
          limit: 2,
          offset,
        }),
      );
    expect(
      walk.map((result) => listReferenceTool.output.parse(result.structuredContent).items),
    ).toEqual([
      [
        {
          id: '10',
          label: 'Kommission für Wirtschaft und Abgaben Nationalrat',
          abbreviation: 'WAK-N',
        },
        {
          id: '23',
          label: 'Kommission für Wirtschaft und Abgaben Ständerat',
          abbreviation: 'WAK-S',
        },
      ],
      [
        { id: '1131', label: 'Subkommission', abbreviation: 'WAK-N WAK-N 17.400' },
        { id: '10011', label: 'Subkommission', abbreviation: 'WAK-N SUBKO 23.462' },
      ],
      [],
    ]);
    expect(walk[0]?.structuredContent).toMatchObject({
      effectiveFilters: { topic: 'committees', language: 'de', query: 'WAK', limit: 2, offset: 0 },
      returnedCount: 2,
      totalCount: 4,
      nextOffset: 2,
      hasMore: true,
    });
    expect(walk[1]?.structuredContent).toMatchObject({ totalCount: 4, hasMore: false });
    expect(walk[1]?.structuredContent).not.toHaveProperty('nextOffset');
    expect(walk[2]?.structuredContent).toMatchObject({
      totalCount: 4,
      hasMore: false,
      notice: expect.stringContaining('past the last matching reference entry'),
    });
    expect(decodeParliamentMarkdown(textContent(walk[0]!)).strings).toContain(
      'effectiveFilters.query: WAK',
    );
    expect(
      http.calls.map((call) => {
        const url = new URL(call.request.url);
        return [url.searchParams.get('$filter'), url.searchParams.get('$skip')];
      }),
    ).toEqual(
      ['0', '2', '4'].map((skip) => [
        "Language eq 'DE' and ((substringof('WAK',CommitteeName) or substringof('WAK',Abbreviation1)))",
        skip,
      ]),
    );
  });

  it('names query and its metadata language in the zero-hit notice', async () => {
    serve({ d: { results: [], __count: '0' } });
    const result = await runToolContract(listReferenceTool, {
      topic: 'parties',
      language: 'fr',
      query: 'SP',
    });
    expect(result.structuredContent).toMatchObject({
      items: [],
      totalCount: 0,
      effectiveFilters: { topic: 'parties', language: 'fr', query: 'SP' },
      notice: expect.stringContaining('No reference entries matched the query'),
    });
    const notice = (result.structuredContent as { notice: string }).notice;
    expect(notice).toContain('query');
    expect(notice).toContain('language fr');
    expect(textContent(result)).toContain(notice);
  });

  it('lists live business topic tags without abbreviations and keeps an unpublished name unknown', async () => {
    serve({
      d: {
        results: [
          { ID: 4, Language: 'IT', TagName: 'Politica istituzionale' },
          { ID: 66, Language: 'IT', TagName: 'Energia' },
          { ID: 1216, Language: 'IT', TagName: null },
        ],
        __count: '28',
      },
    });
    const result = await runToolContract(listReferenceTool, {
      topic: 'tags',
      language: 'it',
      limit: 3,
    });
    expect(result.isError).not.toBe(true);
    expect(listReferenceTool.output.parse(result.structuredContent).items).toEqual([
      { id: '4', label: 'Politica istituzionale' },
      { id: '66', label: 'Energia' },
      { id: '1216' },
    ]);
    expect(result.structuredContent).toMatchObject({
      topic: 'tags',
      returnedCount: 3,
      totalCount: 28,
      nextOffset: 3,
      hasMore: true,
    });
    const decoded = decodeParliamentMarkdown(textContent(result));
    expect(decoded.strings).toContain('items[1].id: 66');
    expect(decoded.strings).toContain('items[1].label: Energia');
    expect(decoded.strings).toContain('items[2].id: 1216');
    expect(decoded.strings.some((line) => line.startsWith('items[2].label'))).toBe(false);
    expect(new URL(http.calls[0]?.request.url ?? '').pathname).toBe('/odata.svc/Tags');
    expect(listReferenceTool.description).toContain('chparl_search_business tagId');
  });

  it('refuses a query past the 2048-byte source query string before any request', async () => {
    const result = await runToolContract(listReferenceTool, {
      topic: 'committees',
      query: 'x'.repeat(1_000),
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'request_too_long',
          recovery: { hint: expect.stringContaining('Shorten query') },
        },
      },
    });
    expect(textContent(result)).toContain('request_too_long');
    expect(textContent(result)).toContain('Shorten query');
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    'identifiers',
    'coverage',
    'languages',
    'statuses',
    'business_types',
    'tags',
    'councils',
    'cantons',
    'sessions',
  ] as const)(
    'rejects query on topic %s as incompatible_fields before any request',
    async (topic) => {
      const result = await runToolContract(listReferenceTool, { topic, query: 'WAK' });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'incompatible_fields',
            recovery: { hint: expect.stringContaining('committees, parties, or groups') },
          },
        },
      });
      expect(textContent(result)).toContain('committees, parties, or groups');
      expect(http.calls).toHaveLength(0);
    },
  );

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
