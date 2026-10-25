/**
 * @fileoverview Business discovery network queries, keyset continuations, and wire contracts.
 * @module tests/mcp-server/tools/business-search.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchBusinessTool } from '@/mcp-server/tools/definitions/search-business.tool.js';
import {
  businessNextCursor,
  businessRow,
  businessSummary,
  expectBusinessParity,
} from '../../helpers/business.js';
import { parliamentHttp, textContent } from '../../helpers/parliament.js';

let http: ReturnType<typeof parliamentHttp>;
beforeEach(() => {
  http = parliamentHttp(() => {
    throw new Error('Unexpected Parliament request.');
  });
});
afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

function serve(body: unknown) {
  http.reset();
  http.route({ match: () => true, respond: () => Response.json(body) });
}

const conjunction = {
  query: " O'Brien é ",
  author: '  A & B ',
  typeId: '3',
  statusId: '9999',
  sessionId: '50',
  submittedFrom: '2026-01-01',
  submittedTo: '2026-02-28',
};
const clauses =
  "substringof('O''Brien é',Title) and substringof('A & B',SubmittedBy) and BusinessType eq 3 and BusinessStatus eq 9999 and SubmissionSession eq 50 and SubmissionDate ge datetime'2026-01-01T00:00:00' and SubmissionDate le datetime'2026-02-28T23:59:59.999'";

describe('chparl_search_business', () => {
  it('hydrates exact-date committee identifiers without expanding the slow role query', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/odata.svc/Business')
          return Response.json({
            d: {
              results: [
                { ...businessRow, ID: 20264707 },
                { ...businessRow, ID: 20264708 },
              ],
              __count: '2',
            },
          });
        if (
          url.searchParams.has('$expand') ||
          url.searchParams.get('$select')?.includes('Businesses/')
        )
          return Response.json(
            { error: 'Role summary expansion is unavailable.' },
            { status: 400 },
          );
        return Response.json({
          d: {
            results: url.searchParams.get('$filter')?.includes('BusinessNumber lt')
              ? []
              : [
                  {
                    ID: '00000000-0000-4000-8000-000000000001',
                    Language: 'DE',
                    BusinessNumber: 20264708,
                  },
                  {
                    ID: '00000000-0000-4000-8000-000000000002',
                    Language: 'DE',
                    BusinessNumber: 20264707,
                  },
                ],
            __count: url.searchParams.get('$filter')?.includes('BusinessNumber lt') ? '0' : '2',
          },
        });
      },
    });
    const result = await runToolContract(searchBusinessTool, {
      committeeId: '4',
      submittedFrom: '2026-10-21',
      submittedTo: '2026-10-21',
      limit: 100,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      businesses: [
        {
          ...businessSummary,
          businessId: '20264708',
          sourceUrl:
            "https://ws.parlament.ch/odata.svc/Business(ID=20264708,Language='DE')?$format=json",
        },
        {
          ...businessSummary,
          businessId: '20264707',
          sourceUrl:
            "https://ws.parlament.ch/odata.svc/Business(ID=20264707,Language='DE')?$format=json",
        },
      ],
      returnedCount: 2,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(result.structuredContent).toMatchObject({
      provenance: {
        sources: [
          { url: expect.stringContaining('/BusinessRole?') },
          { url: expect.stringContaining('/Business?') },
          { url: expect.stringContaining('/BusinessRole?') },
        ],
      },
    });
    expectBusinessParity(result);
  });

  it('maps a normalized conjunction and preserves every selected source value on both surfaces', async () => {
    serve({ d: { results: [businessRow], __count: '1' } });
    const result = await runToolContract(searchBusinessTool, { ...conjunction, language: ' DE ' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      businesses: [businessSummary],
      effectiveFilters: {
        ...conjunction,
        query: "O'Brien é",
        author: 'A & B',
        language: 'de',
        limit: 20,
      },
      returnedCount: 1,
      totalCount: 1,
      hasMore: false,
    });
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.pathname).toBe('/odata.svc/Business');
    expect(url.searchParams.get('$filter')).toBe(`Language eq 'DE' and (${clauses})`);
    expect(url.searchParams.get('$orderby')).toBe('ID desc');
    expect(url.searchParams.get('$inlinecount')).toBe('allpages');
    expect(url.searchParams.get('$top')).toBe('20');
    expect(url.searchParams.get('$select')).not.toContain('Description');
    const decoded = expectBusinessParity(result);
    expect(decoded.links).toContain(businessSummary.sourceUrl);
  });

  it('counts the original whole query separately on a direct continuation', async () => {
    serve({ d: { results: [businessRow], __count: '3' } });
    const first = await runToolContract(searchBusinessTool, { ...conjunction, limit: 1 });
    const cursor = businessNextCursor(first);
    expect(typeof cursor).toBe('string');
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const filter = new URL(request.url).searchParams.get('$filter');
        return Response.json({
          d: {
            results: [{ ID: filter?.includes('ID lt') ? 20991233 : 20991234, Language: 'DE' }],
            __count: filter?.includes('ID lt') ? '2' : '3',
          },
        });
      },
    });
    const result = await runToolContract(searchBusinessTool, { ...conjunction, limit: 1, cursor });
    expect(result.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991233' }],
      totalCount: 3,
      returnedCount: 1,
      hasMore: true,
    });
    expect(http.calls).toHaveLength(2);
    const urls = http.calls.map((call) => new URL(call.request.url));
    expect(urls[0]?.searchParams.get('$filter')).toBe(
      `Language eq 'DE' and (${clauses} and ID lt 20991234)`,
    );
    expect(urls[1]?.searchParams.get('$filter')).toBe(`Language eq 'DE' and (${clauses})`);
    expect(urls[1]?.searchParams.get('$select')).toBe('ID,Language');
    expectBusinessParity(result);
  });

  it('deduplicates committee candidates across source pages and skips the whole boundary group', async () => {
    const role = (id: string, businessId: number) => ({
      ID: id,
      Language: 'DE',
      BusinessNumber: businessId,
      Businesses: { ID: businessId, Language: 'DE' },
    });
    const roles = [
      role('00000000-0000-4000-8000-000000000001', 20991234),
      role('00000000-0000-4000-8000-000000000002', 20991233),
      role('00000000-0000-4000-8000-000000000003', 20991233),
    ];
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/odata.svc/Business')
          return Response.json({
            d: {
              results: [
                { ID: 20991233, Language: 'DE' },
                { ID: 20991234, Language: 'DE' },
              ],
              __count: '2',
            },
          });
        if (url.searchParams.get('$filter')?.includes('BusinessNumber lt')) {
          return Response.json({
            d: { results: [role('00000000-0000-4000-8000-000000000005', 20991232)], __count: '9' },
          });
        }
        const skip = Number(url.searchParams.get('$skip'));
        return Response.json({
          d: { results: skip === 0 ? roles.slice(0, 2) : roles.slice(2), __count: '20' },
        });
      },
    });
    const result = await runToolContract(searchBusinessTool, {
      ...conjunction,
      committeeId: '7',
      limit: 3,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991234' }, { businessId: '20991233' }],
      returnedCount: 2,
      effectiveLimit: 3,
      hasMore: true,
      notice: expect.stringContaining('distinct business total is unavailable'),
    });
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(http.calls).toHaveLength(4);
    const urls = http.calls.map((call) => new URL(call.request.url));
    const filter = urls[0]?.searchParams.get('$filter');
    expect(filter).toBe(
      `Language eq 'DE' and (CommitteeNumber eq 7 and Businesses/Language eq 'DE' and ${clauses.replaceAll(',Title)', ',Businesses/Title)').replaceAll(',SubmittedBy)', ',Businesses/SubmittedBy)').replaceAll('BusinessType eq', 'Businesses/BusinessType eq').replaceAll('BusinessStatus eq', 'Businesses/BusinessStatus eq').replaceAll('SubmissionSession eq', 'Businesses/SubmissionSession eq').replaceAll('SubmissionDate ', 'Businesses/SubmissionDate ')})`,
    );
    expect(urls[0]?.searchParams.has('$expand')).toBe(false);
    expect(urls[0]?.searchParams.get('$select')).toBe('ID,Language,BusinessNumber');
    expect(urls[0]?.searchParams.get('$orderby')).toBe('BusinessNumber desc,ID asc');
    expect(urls[1]?.searchParams.get('$skip')).toBe('2');
    expect(urls[1]?.searchParams.get('$top')).toBe('1');
    expect(urls[3]?.searchParams.get('$filter')).toBe(
      filter?.replace(/\)$/, ' and BusinessNumber lt 20991233)'),
    );
    expect(urls[3]?.searchParams.get('$top')).toBe('1');
    const cursor = businessNextCursor(result);
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') throw new Error('Expected nextCursor.');
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toMatchObject({
      lastBusinessId: '20991233',
      route: 'committee',
    });
    http.reset();
    http.route({
      match: () => true,
      respond: () => Response.json({ d: { results: [], __count: '0' } }),
    });
    const end = await runToolContract(searchBusinessTool, {
      ...conjunction,
      committeeId: '7',
      limit: 3,
      cursor,
    });
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toContain(
      'BusinessNumber lt 20991233',
    );
    expect(end.structuredContent).toMatchObject({
      businesses: [],
      hasMore: false,
      returnedCount: 0,
    });
    expect(textContent(end)).toContain('No business remains after this cursor');
    expectBusinessParity(result);
    expectBusinessParity(end);
  });

  it('fits whole businesses and bases the next cursor on the last delivered item', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      ID: 20991234 - index,
      Language: 'DE',
      Title: `<p>${'界'.repeat(200)}\r\n${index}</p>`,
    }));
    serve({ d: { results: rows, __count: '101' } });
    const result = await runToolContract(searchBusinessTool, {
      limit: 10_000,
      query: '',
      author: ' ',
    });
    const output = searchBusinessTool.output.parse(result.structuredContent);
    expect(output.businesses.length).toBeGreaterThan(0);
    expect(output.businesses.length).toBeLessThan(100);
    expect(output.businesses.map((item) => item.title)).toEqual(
      rows.slice(0, output.businesses.length).map((row) => row.Title),
    );
    expect(result.structuredContent).toMatchObject({
      returnedCount: output.businesses.length,
      effectiveLimit: 100,
      totalCount: 101,
      hasMore: true,
    });
    const cursor = businessNextCursor(result);
    if (typeof cursor !== 'string') throw new Error('Expected cursor.');
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toMatchObject({
      lastBusinessId: String(20991235 - output.businesses.length),
    });
    expect(
      new TextEncoder().encode(
        JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
      ).byteLength,
    ).toBeLessThan(24_000);
    expect(textContent(result)).toContain('clamped to 100');
    expect(textContent(result)).toContain('no business fields were shortened');
    expectBusinessParity(result);
  });

  it('batches 100 committee candidates and drains fitted continuations across a duplicate boundary', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => 20991234 - index);
    const candidates = [...ids.slice(0, 99), 20991136, ...ids.slice(99)].map((id, index) => ({
      ID: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      Language: 'DE',
      BusinessNumber: id,
    }));
    const batchSizes: number[] = [];
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        const filter = url.searchParams.get('$filter') ?? '';
        const skip = Number(url.searchParams.get('$skip'));
        const top = Number(url.searchParams.get('$top'));
        if (url.pathname === '/odata.svc/Business') {
          const selected = [...filter.matchAll(/ID eq (\d+)/g)].map((match) => Number(match[1]));
          batchSizes.push(selected.length);
          expect(url.href.length).toBeLessThan(2048);
          return Response.json({
            d: {
              results: selected
                .slice()
                .reverse()
                .slice(skip, skip + Math.min(top, 25))
                .map((ID) => ({ ID, Language: 'DE', Title: `Business ${ID}` })),
              __count: String(selected.length),
            },
          });
        }
        expect(url.searchParams.has('$expand')).toBe(false);
        expect(url.searchParams.get('$select')).toBe('ID,Language,BusinessNumber');
        expect(filter).toContain("CommitteeNumber eq 7 and Businesses/Language eq 'DE'");
        const after = /BusinessNumber lt (\d+)/.exec(filter)?.[1];
        const selected = candidates.filter(
          (candidate) => after === undefined || candidate.BusinessNumber < Number(after),
        );
        return Response.json({
          d: { results: selected.slice(skip, skip + top), __count: String(selected.length) },
        });
      },
    });
    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const result = await runToolContract(searchBusinessTool, {
        committeeId: '7',
        limit: cursor ? 100 : 101,
        ...(cursor && { cursor }),
      });
      expect(result.isError).not.toBe(true);
      const items = searchBusinessTool.output.parse(result.structuredContent).businesses;
      expect(items.map((item) => item.businessId)).toEqual(
        ids.slice(collected.length, collected.length + items.length).map(String),
      );
      expect(result.structuredContent).not.toHaveProperty('totalCount');
      expect(result.structuredContent).toMatchObject({
        returnedCount: items.length,
        effectiveLimit: 100,
        hasMore: collected.length + items.length < 101,
      });
      expect(
        new TextEncoder().encode(
          JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
        ).byteLength,
      ).toBeLessThan(24_000);
      expectBusinessParity(result);
      collected.push(...items.map((item) => item.businessId));
      if (collected.length === 101) break;
      expect(items.length).toBeGreaterThan(0);
      cursor = businessNextCursor(result);
      expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toMatchObject({
        lastBusinessId: String(ids[collected.length - 1]),
      });
    }
    expect(collected).toEqual(ids.map(String));
    expect(batchSizes).toContain(50);
    expect(batchSizes.every((size) => size <= 50)).toBe(true);
  });

  it('returns a maximum small page and a whole indivisible oversized item', async () => {
    serve({
      d: {
        results: Array.from({ length: 100 }, (_, index) => ({
          ID: 20991234 - index,
          Language: 'DE',
        })),
        __count: '100',
      },
    });
    const max = await runToolContract(searchBusinessTool, { limit: 100 });
    // Complete-result fitting may reduce even sparse records; every delivered record is complete.
    expect(max.structuredContent).toMatchObject({ effectiveLimit: 100, totalCount: 100 });
    const title = '界'.repeat(15_000);
    serve({ d: { results: [{ ID: 20991234, Language: 'DE', Title: title }], __count: '1' } });
    const result = await runToolContract(searchBusinessTool, { limit: 1 });
    expect(result.structuredContent).toMatchObject({
      businesses: [{ title }],
      returnedCount: 1,
      hasMore: false,
    });
    expect(textContent(result)).toContain('limit');
    expect(textContent(result)).toContain('One indivisible business');
    expectBusinessParity(result);
  });

  it('combines clamp and zero-hit guidance without inventing a continuation', async () => {
    serve({ d: { results: [], __count: '0' } });
    const result = await runToolContract(searchBusinessTool, { limit: 101 });
    expect(result.structuredContent).toMatchObject({
      businesses: [],
      totalCount: 0,
      returnedCount: 0,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('nextCursor');
    expect(textContent(result)).toContain('clamped to 100');
    expect(textContent(result)).toContain('No parliamentary business matched');
    expectBusinessParity(result);
  });

  it.each([
    'not+base64',
    'e30',
    Buffer.from(JSON.stringify({ version: 99 })).toString('base64url'),
  ])('rejects malformed cursor %s before I/O with recovery', async (cursor) => {
    const result = await runToolContract(searchBusinessTool, { cursor });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_cursor',
          recovery: { hint: expect.stringContaining('without cursor') },
        },
      },
    });
    expect(textContent(result)).toContain('invalid_cursor');
    expect(textContent(result)).toContain('preserving the intended filters');
    expect(http.calls).toHaveLength(0);
  });

  it('rejects changed cursor filters and extra decoded URL fields before I/O', async () => {
    serve({ d: { results: [businessRow], __count: '2' } });
    const first = await runToolContract(searchBusinessTool, { query: 'original', limit: 1 });
    const cursor = businessNextCursor(first);
    if (typeof cursor !== 'string') throw new Error('Expected cursor.');
    const changed = await runToolContract(searchBusinessTool, { query: 'changed', cursor });
    expect(changed.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_cursor' } },
    });
    const altered = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(cursor, 'base64url').toString()),
        url: 'https://example.invalid',
      }),
    ).toString('base64url');
    const rejected = await runToolContract(searchBusinessTool, {
      query: 'original',
      cursor: altered,
    });
    expect(rejected.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_cursor' } },
    });
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    { limit: 0 },
    { limit: 10_001 },
    { language: 'en' },
    { submittedFrom: '2026-02-30' },
    { committeeId: '2147483648' },
  ])('rejects invalid input %o', async (input) => {
    const result = await runToolContract(searchBusinessTool, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('rejects reversed dates before I/O with actionable recovery', async () => {
    const result = await runToolContract(searchBusinessTool, {
      submittedFrom: '2026-03-01',
      submittedTo: '2026-02-01',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError },
    });
    expect(textContent(result)).toContain('ascending submission-date range');
    expect(http.calls).toHaveLength(0);
  });

  it('preserves rate-limit recovery and removes raw upstream diagnostics', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: () =>
        Response.json(
          { error: { innererror: 'private-stack' } },
          { status: 429, headers: { 'Retry-After': '999' } },
        ),
    });
    const result = await runToolContract(searchBusinessTool, {});
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
    expect(textContent(result)).toContain('topic coverage');
    expect(JSON.stringify(result)).not.toContain('private-stack');
  });

  it.each([
    { Language: 'FR' },
    { ID: 'invalid-role-id' },
    { BusinessNumber: 0 },
    { BusinessNumber: 2_147_483_648 },
  ])('rejects invalid committee role identity %o before hydration', async (mutation) => {
    serve({
      d: {
        results: [
          {
            ID: '00000000-0000-4000-8000-000000000001',
            Language: 'DE',
            BusinessNumber: 20991234,
            ...mutation,
          },
        ],
        __count: '1',
      },
    });
    const result = await runToolContract(searchBusinessTool, { committeeId: '7' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain(
      mutation.Language ? 'different metadata language' : 'documented fields',
    );
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    { name: 'missing', rows: [], message: 'omitted a requested' },
    {
      name: 'unexpected ID',
      rows: [{ ID: 20991233, Language: 'DE' }],
      message: 'unexpected or duplicate',
    },
    {
      name: 'wrong language',
      rows: [{ ID: 20991234, Language: 'FR' }],
      message: 'different metadata language',
    },
  ])('rejects $name hydration without silently advancing the cursor', async ({ rows, message }) => {
    const role = {
      ID: '00000000-0000-4000-8000-000000000001',
      Language: 'DE',
      BusinessNumber: 20991234,
    };
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json({
          d: {
            results: new URL(request.url).pathname === '/odata.svc/Business' ? rows : [role],
            __count: String(
              new URL(request.url).pathname === '/odata.svc/Business' ? rows.length : 1,
            ),
          },
        }),
    });
    const result = await runToolContract(searchBusinessTool, { committeeId: '7' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(textContent(result)).toContain(message);
    expect(result.structuredContent).not.toHaveProperty('businesses');
    expect(result.structuredContent).not.toHaveProperty('nextCursor');
  });

  it.each(['FR', 'DE'])('rejects a mismatched %s committee sentinel', async (language) => {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        return Response.json({
          d: {
            results:
              url.pathname === '/odata.svc/Business'
                ? [{ ID: 20991234, Language: 'DE' }]
                : [
                    {
                      ID: '00000000-0000-4000-8000-000000000001',
                      Language: url.searchParams.get('$filter')?.includes('BusinessNumber lt')
                        ? language
                        : 'DE',
                      BusinessNumber: 20991234,
                    },
                  ],
            __count: '1',
          },
        });
      },
    });
    const sentinel = await runToolContract(searchBusinessTool, { committeeId: '7' });
    expect(sentinel.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(textContent(sentinel)).toContain('mismatched committee sentinel');
  });

  it('rejects duplicate hydrated identities instead of losing another requested summary', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json({
          d: {
            results:
              new URL(request.url).pathname === '/odata.svc/Business'
                ? [
                    { ID: 20991234, Language: 'DE' },
                    { ID: 20991234, Language: 'DE' },
                  ]
                : [20991234, 20991233].map((BusinessNumber, index) => ({
                    ID: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                    Language: 'DE',
                    BusinessNumber,
                  })),
            __count: '2',
          },
        }),
    });
    const result = await runToolContract(searchBusinessTool, { committeeId: '7' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(textContent(result)).toContain('unexpected or duplicate');
  });

  it.each(['deadline', 'cancel'] as const)(
    'shares the workflow %s across role selection and hydration',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
      const controller = new AbortController();
      http.reset();
      http.route({
        match: () => true,
        respond: (request) => {
          if (new URL(request.url).pathname === '/odata.svc/Business') {
            if (mode === 'deadline') vi.advanceTimersByTime(101);
            else controller.abort(new DOMException('Stop hydration.', 'AbortError'));
            return Response.json({
              d: { results: [{ ID: 20991234, Language: 'DE' }], __count: '1' },
            });
          }
          vi.advanceTimersByTime(44_900);
          return Response.json({
            d: {
              results: [
                {
                  ID: '00000000-0000-4000-8000-000000000001',
                  Language: 'DE',
                  BusinessNumber: 20991234,
                },
              ],
              __count: '1',
            },
          });
        },
      });
      const result = await runToolContract(
        searchBusinessTool,
        { committeeId: '7' },
        { context: { signal: controller.signal } },
      );
      expect(result.structuredContent).toMatchObject({
        error: {
          code: mode === 'deadline' ? JsonRpcErrorCode.Timeout : JsonRpcErrorCode.RequestCancelled,
          ...(mode === 'deadline'
            ? { data: { reason: 'workflow_deadline_exceeded' } }
            : { message: 'Stop hydration.' }),
        },
      });
      expect(textContent(result)).toContain(
        mode === 'deadline' ? 'workflow_deadline_exceeded' : 'Stop hydration.',
      );
      expect(http.calls).toHaveLength(2);
    },
  );

  it('settles caller cancellation before HTTP on both public surfaces', async () => {
    const result = await runToolContract(
      searchBusinessTool,
      {},
      {
        context: {
          signal: AbortSignal.abort(new DOMException('Stop business search.', 'AbortError')),
        },
      },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled, message: 'Stop business search.' },
    });
    expect(textContent(result)).toContain('Stop business search.');
    expect(http.calls).toHaveLength(0);
  });

  it('advances a byte-fitted committee page from delivered businesses rather than examined roles', async () => {
    const roles = Array.from({ length: 20 }, (_, index) => ({
      ID: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      Language: 'DE',
      BusinessNumber: 20991234 - index,
      Businesses: {
        ID: 20991234 - index,
        Language: 'DE',
        Title: `<p>${'界'.repeat(300)} ${index}</p>`,
      },
    }));
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json({
          d: {
            results:
              new URL(request.url).pathname === '/odata.svc/Business'
                ? roles.map((row) => row.Businesses)
                : new URL(request.url).searchParams.get('$filter')?.includes('BusinessNumber lt')
                  ? []
                  : roles,
            __count: new URL(request.url).searchParams.get('$filter')?.includes('BusinessNumber lt')
              ? '0'
              : '20',
          },
        }),
    });
    const result = await runToolContract(searchBusinessTool, { committeeId: '7' });
    const items = searchBusinessTool.output.parse(result.structuredContent).businesses;
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(20);
    expect(items.map((item) => item.title)).toEqual(
      roles.slice(0, items.length).map((row) => row.Businesses.Title),
    );
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(result.structuredContent).toMatchObject({ returnedCount: items.length, hasMore: true });
    expect(
      JSON.parse(Buffer.from(businessNextCursor(result), 'base64url').toString()),
    ).toMatchObject({ lastBusinessId: String(20991235 - items.length) });
    expectBusinessParity(result);
  });

  it('validates every decoded cursor field before requesting a continuation', async () => {
    serve({ d: { results: [businessRow], __count: '2' } });
    const first = await runToolContract(searchBusinessTool, { limit: 1 });
    const payload = JSON.parse(Buffer.from(businessNextCursor(first), 'base64url').toString());
    for (const mutation of [
      { version: 2 },
      { language: 'fr' },
      { order: 'id_asc' },
      { route: 'committee' },
      { lastBusinessId: '2147483648' },
      { lastBusinessId: '1 or 1 eq 1' },
      { fingerprint: 'a'.repeat(64) },
    ]) {
      const cursor = Buffer.from(JSON.stringify({ ...payload, ...mutation })).toString('base64url');
      const result = await runToolContract(searchBusinessTool, { cursor });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_cursor' } },
      });
      expect(textContent(result)).toContain('without cursor');
    }
    expect(http.calls).toHaveLength(1);
  });
});
