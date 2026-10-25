/**
 * @fileoverview Business discovery network queries, keyset continuations, and wire contracts.
 * @module tests/mcp-server/tools/business-search.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
afterEach(() => http.restore());

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
    expect(http.calls).toHaveLength(3);
    const urls = http.calls.map((call) => new URL(call.request.url));
    const filter = urls[0]?.searchParams.get('$filter');
    expect(filter).toBe(
      `Language eq 'DE' and (CommitteeNumber eq 7 and Businesses/Language eq 'DE' and ${clauses.replaceAll(',Title)', ',Businesses/Title)').replaceAll(',SubmittedBy)', ',Businesses/SubmittedBy)').replaceAll('BusinessType eq', 'Businesses/BusinessType eq').replaceAll('BusinessStatus eq', 'Businesses/BusinessStatus eq').replaceAll('SubmissionSession eq', 'Businesses/SubmissionSession eq').replaceAll('SubmissionDate ', 'Businesses/SubmissionDate ')})`,
    );
    expect(urls[0]?.searchParams.get('$expand')).toBe('Businesses');
    expect(urls[0]?.searchParams.get('$orderby')).toBe('BusinessNumber desc,ID asc');
    expect(urls[1]?.searchParams.get('$skip')).toBe('2');
    expect(urls[1]?.searchParams.get('$top')).toBe('1');
    expect(urls[2]?.searchParams.get('$filter')).toBe(
      filter?.replace(/\)$/, ' and BusinessNumber lt 20991233)'),
    );
    expect(urls[2]?.searchParams.get('$top')).toBe('1');
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

  it('rejects mismatched committee expansions and sentinel rows without publishing fabricated items', async () => {
    const role = {
      ID: '00000000-0000-4000-8000-000000000001',
      Language: 'DE',
      BusinessNumber: 20991234,
      Businesses: { ID: 20991233, Language: 'DE' },
    };
    serve({ d: { results: [role], __count: '1' } });
    const mismatch = await runToolContract(searchBusinessTool, { committeeId: '7' });
    expect(mismatch.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(textContent(mismatch)).toContain('mismatched committee role expansion');
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json({
          d: {
            results: [
              {
                ...role,
                Businesses: {
                  ID: 20991234,
                  Language: new URL(request.url).searchParams
                    .get('$filter')
                    ?.includes('BusinessNumber lt')
                    ? 'FR'
                    : 'DE',
                },
              },
            ],
            __count: '1',
          },
        }),
    });
    const sentinel = await runToolContract(searchBusinessTool, { committeeId: '7' });
    expect(sentinel.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(textContent(sentinel)).toContain('mismatched committee sentinel');
  });

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
            results: new URL(request.url).searchParams.get('$filter')?.includes('BusinessNumber lt')
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
