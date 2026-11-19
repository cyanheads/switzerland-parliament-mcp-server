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
const roleClauses =
  "substringof('O''Brien é',Businesses/Title) and substringof('A & B',Businesses/SubmittedBy) and Businesses/BusinessType eq 3 and Businesses/BusinessStatus eq 9999 and Businesses/SubmissionSession eq 50 and Businesses/SubmissionDate ge datetime'2026-01-01T00:00:00' and Businesses/SubmissionDate le datetime'2026-02-28T23:59:59.999'";

/** BusinessRole identity row; the GUID suffix only needs to be unique per fixture. */
function roleRow(index: number, BusinessNumber: number) {
  return {
    ID: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    Language: 'DE',
    BusinessNumber,
  };
}

/**
 * Serve role pages from `roles` by BusinessNumber keyset, a count only when one is requested,
 * and hydrate every requested business ID from the synthetic row.
 */
function serveRoles(roles: ReturnType<typeof roleRow>[]) {
  http.reset();
  http.route({
    match: () => true,
    respond: (request) => {
      const url = new URL(request.url);
      const filter = url.searchParams.get('$filter') ?? '';
      if (url.pathname === '/odata.svc/Business') {
        const ids = [...filter.matchAll(/ID eq (\d+)/g)].map((match) => Number(match[1]));
        return Response.json({
          d: { results: ids.map((ID) => ({ ...businessRow, ID })), __count: String(ids.length) },
        });
      }
      const after = /BusinessNumber lt (\d+)/.exec(filter)?.[1];
      const selected = roles.filter(
        (row) => after === undefined || row.BusinessNumber < Number(after),
      );
      const results = selected.slice(0, Number(url.searchParams.get('$top')));
      return Response.json({
        d: url.searchParams.has('$inlinecount')
          ? { results, __count: String(selected.length) }
          : results,
      });
    },
  });
}

/**
 * Apply the Tags clauses of an emitted $filter to one Tags value with OData semantics: each
 * eq/startswith/endswith/substringof clause is read from the filter itself, then ORed.
 */
function tagFilterMatches(filter: string, tags: string | undefined): boolean {
  const field = String.raw`(?:Businesses\/)?Tags`;
  const tests: ((value: string) => boolean)[] = [];
  for (const [, literal = ''] of filter.matchAll(new RegExp(`${field} eq '([^']*)'`, 'g')))
    tests.push((value) => value === literal);
  for (const [, literal = ''] of filter.matchAll(
    new RegExp(`startswith\\(${field},'([^']*)'\\)`, 'g'),
  ))
    tests.push((value) => value.startsWith(literal));
  for (const [, literal = ''] of filter.matchAll(
    new RegExp(`endswith\\(${field},'([^']*)'\\)`, 'g'),
  ))
    tests.push((value) => value.endsWith(literal));
  for (const [, literal = ''] of filter.matchAll(
    new RegExp(`substringof\\('([^']*)',${field}\\)`, 'g'),
  ))
    tests.push((value) => value.includes(literal));
  return tags !== undefined && tests.some((test) => test(tags));
}

/** Path, filter, count option, and page size of every Parliament request, in order. */
function requestShapes() {
  return http.calls.map(({ request }) => {
    const url = new URL(request.url);
    return [
      url.pathname.replace('/odata.svc/', ''),
      url.searchParams.get('$filter'),
      url.searchParams.get('$inlinecount'),
      url.searchParams.get('$top'),
    ];
  });
}

describe('chparl_search_business', () => {
  it.each([0, 1, 2, 3])('uses one count-free lookahead for %i author matches', async (size) => {
    const rows = Array.from({ length: size }, (_, index) => ({
      ...businessRow,
      ID: 20991234 - index,
    }));
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        const top = Number(url.searchParams.get('$top'));
        const skip = Number(url.searchParams.get('$skip'));
        return Response.json({ d: rows.slice(skip, skip + top) });
      },
    });
    const result = await runToolContract(searchBusinessTool, { author: 'Maillard', limit: 2 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      businesses: rows.slice(0, 2).map((item) => ({ businessId: String(item.ID) })),
      returnedCount: Math.min(size, 2),
      hasMore: size > 2,
    });
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    if (size <= 2) expect(result.structuredContent).not.toHaveProperty('nextCursor');
    expect(http.calls).toHaveLength(1);
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.searchParams.has('$inlinecount')).toBe(false);
    expect(url.searchParams.get('$top')).toBe('3');
    expectBusinessParity(result);
  });

  it('drains count-free author cursors without recounting, including a full tail and past-end', async () => {
    const rows = [20991234, 20991233, 20991232, 20991231].map((ID) => ({ ...businessRow, ID }));
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        const after = /ID lt (\d+)/.exec(url.searchParams.get('$filter') ?? '')?.[1];
        const selected = rows.filter((item) => after === undefined || item.ID < Number(after));
        const skip = Number(url.searchParams.get('$skip'));
        return Response.json({
          d: selected.slice(skip, skip + Number(url.searchParams.get('$top'))),
        });
      },
    });
    const input = { ...conjunction, limit: 2 };
    const first = await runToolContract(searchBusinessTool, input);
    const firstCursor = businessNextCursor(first);
    const second = await runToolContract(searchBusinessTool, { ...input, cursor: firstCursor });
    expect(second.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991232' }, { businessId: '20991231' }],
      hasMore: false,
    });
    expect(second.structuredContent).not.toHaveProperty('nextCursor');
    expect(second.structuredContent).not.toHaveProperty('totalCount');
    // The cursor is filter-bound but can outlive source deletions.
    rows.length = 0;
    const past = await runToolContract(searchBusinessTool, { ...input, cursor: firstCursor });
    expect(past.structuredContent).toMatchObject({ businesses: [], hasMore: false });
    expect(past.structuredContent).not.toHaveProperty('nextCursor');
    expect(past.structuredContent).not.toHaveProperty('totalCount');
    expect(textContent(past)).toContain('No business remains after this cursor');
    expect(http.calls).toHaveLength(3);
    for (const { request } of http.calls) {
      const url = new URL(request.url);
      expect(url.searchParams.has('$inlinecount')).toBe(false);
      expect(url.searchParams.get('$top')).toBe('3');
      expect(url.searchParams.get('$filter')).toContain(clauses);
      expect(url.searchParams.get('$orderby')).toBe('ID desc');
    }
    expect(new URL(http.calls[1]?.request.url ?? '').searchParams.get('$filter')).toBe(
      `Language eq 'DE' and (${clauses} and ID lt 20991233)`,
    );
    for (const result of [first, second, past]) expectBusinessParity(result);
  });

  it('fills author lookahead through several source continuations without counting', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        const skip = Number(url.searchParams.get('$skip'));
        const next = new URL(url);
        next.searchParams.set('$skip', String(skip + 1));
        return Response.json({
          d: {
            results: [{ ...businessRow, ID: 20991234 - skip }],
            ...(skip < 2 && { __next: next.href }),
          },
        });
      },
    });
    const result = await runToolContract(searchBusinessTool, { author: 'Maillard', limit: 2 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991234' }, { businessId: '20991233' }],
      returnedCount: 2,
      hasMore: true,
      provenance: {
        sources: [
          { url: expect.stringContaining('%24skip=0') },
          { url: expect.stringContaining('%24skip=1') },
          { url: expect.stringContaining('%24skip=2') },
        ],
      },
    });
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(
      http.calls.map(({ request }) => {
        const url = new URL(request.url);
        return [
          url.searchParams.get('$skip'),
          url.searchParams.get('$top'),
          url.searchParams.has('$inlinecount'),
        ];
      }),
    ).toEqual([
      ['0', '3', false],
      ['1', '2', false],
      ['2', '1', false],
    ]);
    expect(
      JSON.parse(Buffer.from(businessNextCursor(result), 'base64url').toString()),
    ).toMatchObject({
      lastBusinessId: '20991233',
    });
    expectBusinessParity(result);
  });

  it('returns full author pages of large records and continues to the lookahead row', async () => {
    const rows = Array.from({ length: 102 }, (_, index) => ({
      ID: 20991234 - index,
      Language: 'DE',
      Title: `${index} ${'界'.repeat(100)}`,
    }));
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        const after = /ID lt (\d+)/.exec(url.searchParams.get('$filter') ?? '')?.[1];
        const selected = rows.filter((item) => after === undefined || item.ID < Number(after));
        return Response.json({ d: selected.slice(0, Number(url.searchParams.get('$top'))) });
      },
    });
    const collected: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await runToolContract(searchBusinessTool, {
        author: 'Maillard',
        limit: 101,
        ...(cursor && { cursor }),
      });
      const items = searchBusinessTool.output.parse(result.structuredContent).businesses;
      pageSizes.push(items.length);
      expect(items.map((item) => item.businessId)).toEqual(
        rows
          .slice(collected.length, collected.length + items.length)
          .map((item) => String(item.ID)),
      );
      collected.push(...items.map((item) => item.businessId));
      expect(result.structuredContent).not.toHaveProperty('totalCount');
      expect(result.structuredContent).toMatchObject({
        returnedCount: items.length,
        effectiveLimit: 100,
        hasMore: collected.length < 102,
        notice: 'Requested limit 101 was clamped to 100.',
      });
      expectBusinessParity(result);
      if (collected.length === 102) break;
      cursor = businessNextCursor(result);
      expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toMatchObject({
        lastBusinessId: collected.at(-1),
      });
    }
    expect(pageSizes).toEqual([100, 2]);
    expect(collected).toEqual(rows.map((item) => String(item.ID)));
    expect(
      http.calls.every(({ request }) => !new URL(request.url).searchParams.has('$inlinecount')),
    ).toBe(true);
    expect(http.calls.map(({ request }) => new URL(request.url).searchParams.get('$top'))).toEqual([
      '101',
      '101',
    ]);
  });

  it('keeps counted non-author first pages and original-filter continuation recounts', async () => {
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
    const first = await runToolContract(searchBusinessTool, { query: 'fixed', limit: 1 });
    const second = await runToolContract(searchBusinessTool, {
      query: 'fixed',
      limit: 1,
      cursor: businessNextCursor(first),
    });
    expect(first.structuredContent).toMatchObject({ totalCount: 3, hasMore: true });
    expect(second.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991233' }],
      totalCount: 3,
      hasMore: true,
    });
    expect(
      http.calls.map(({ request }) => {
        const url = new URL(request.url);
        return [
          url.searchParams.get('$filter'),
          url.searchParams.get('$inlinecount'),
          url.searchParams.get('$top'),
          url.searchParams.get('$select'),
        ];
      }),
    ).toEqual([
      [
        "Language eq 'DE' and (substringof('fixed',Title))",
        'allpages',
        '1',
        expect.stringContaining('Title'),
      ],
      [
        "Language eq 'DE' and (substringof('fixed',Title) and ID lt 20991234)",
        'allpages',
        '1',
        expect.stringContaining('Title'),
      ],
      ["Language eq 'DE' and (substringof('fixed',Title))", 'allpages', '1', 'ID,Language'],
    ]);
    expectBusinessParity(first);
    expectBusinessParity(second);
  });

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
      hasMore: false,
    });
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.pathname).toBe('/odata.svc/Business');
    expect(url.searchParams.get('$filter')).toBe(`Language eq 'DE' and (${clauses})`);
    expect(url.searchParams.get('$orderby')).toBe('ID desc');
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(url.searchParams.has('$inlinecount')).toBe(false);
    expect(url.searchParams.get('$top')).toBe('21');
    expect(url.searchParams.get('$select')).not.toContain('Description');
    const decoded = expectBusinessParity(result);
    expect(decoded.links).toContain(businessSummary.sourceUrl);
  });

  it('counts the original whole query separately on a direct continuation', async () => {
    serve({ d: { results: [businessRow], __count: '3' } });
    const first = await runToolContract(searchBusinessTool, { query: 'original', limit: 1 });
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
    const result = await runToolContract(searchBusinessTool, {
      query: 'original',
      limit: 1,
      cursor,
    });
    expect(result.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991233' }],
      totalCount: 3,
      returnedCount: 1,
      hasMore: true,
    });
    expect(http.calls).toHaveLength(2);
    const urls = http.calls.map((call) => new URL(call.request.url));
    expect(urls[0]?.searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (substringof('original',Title) and ID lt 20991234)",
    );
    expect(urls[1]?.searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (substringof('original',Title))",
    );
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
        const counted = url.searchParams.has('$inlinecount');
        if (url.searchParams.get('$filter')?.includes('BusinessNumber lt')) {
          const results = [role('00000000-0000-4000-8000-000000000005', 20991232)];
          return Response.json({ d: counted ? { results, __count: '9' } : results });
        }
        const skip = Number(url.searchParams.get('$skip'));
        const next = new URL(url);
        next.searchParams.set('$skip', '2');
        return Response.json({
          d: {
            results: skip === 0 ? roles.slice(0, 2) : roles.slice(2),
            ...(skip === 0 && { __next: next.href }),
            ...(counted && { __count: '20' }),
          },
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
    // Committee totals are never reported, so neither role query asks the source to count.
    expect(
      urls
        .filter((url) => url.pathname === '/odata.svc/BusinessRole')
        .map((url) => url.searchParams.has('$inlinecount')),
    ).toEqual([false, false, false]);
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

  it('returns every whole business of a full page and keys the cursor to the last one', async () => {
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
    expect(output.businesses.map((item) => item.title)).toEqual(rows.map((row) => row.Title));
    expect(result.structuredContent).toMatchObject({
      returnedCount: 100,
      effectiveLimit: 100,
      totalCount: 101,
      hasMore: true,
      notice: 'Requested limit 10000 was clamped to 100.',
    });
    expect(
      JSON.parse(Buffer.from(businessNextCursor(result), 'base64url').toString()),
    ).toMatchObject({ lastBusinessId: '20991135' });
    // A page over 24,000 bytes is delivered whole.
    expect(
      new TextEncoder().encode(
        JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
      ).byteLength,
    ).toBeGreaterThan(24_000);
    expectBusinessParity(result);
  });

  it('batches 100 committee candidates and drains continuations across a duplicate boundary', async () => {
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
          if (skip === 0) batchSizes.push(selected.length);
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
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await runToolContract(searchBusinessTool, {
        committeeId: '7',
        limit: cursor ? 100 : 101,
        ...(cursor && { cursor }),
      });
      expect(result.isError).not.toBe(true);
      const items = searchBusinessTool.output.parse(result.structuredContent).businesses;
      pageSizes.push(items.length);
      expect(items.map((item) => item.businessId)).toEqual(
        ids.slice(collected.length, collected.length + items.length).map(String),
      );
      expect(result.structuredContent).not.toHaveProperty('totalCount');
      expect(result.structuredContent).toMatchObject({
        returnedCount: items.length,
        effectiveLimit: 100,
        hasMore: collected.length + items.length < 101,
      });
      expectBusinessParity(result);
      collected.push(...items.map((item) => item.businessId));
      if (collected.length === 101) break;
      cursor = businessNextCursor(result);
      expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toMatchObject({
        lastBusinessId: String(ids[collected.length - 1]),
      });
    }
    // 100 role rows carry 99 distinct businesses; the duplicate shortens only the first page.
    expect(pageSizes).toEqual([99, 2]);
    expect(collected).toEqual(ids.map(String));
    expect(batchSizes).toEqual([50, 49, 2]);
  });

  it('returns a maximum page of limit records and one large record whole without a size notice', async () => {
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
    expect(max.structuredContent).toMatchObject({
      effectiveLimit: 100,
      returnedCount: 100,
      totalCount: 100,
      hasMore: false,
    });
    expect(max.structuredContent).not.toHaveProperty('notice');
    const title = '界'.repeat(15_000);
    serve({ d: { results: [{ ID: 20991234, Language: 'DE', Title: title }], __count: '1' } });
    const result = await runToolContract(searchBusinessTool, { limit: 1 });
    expect(result.structuredContent).toMatchObject({
      businesses: [{ title }],
      returnedCount: 1,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textContent(result)).not.toContain('notice');
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
    { personNumber: '0' },
    { personNumber: '2147483648' },
    { personNumber: '4102', role: 'signer' },
    { personNumber: '4102', role: 7 },
    { committeeId: '10', tagId: '0' },
    { committeeId: '10', tagId: '12|28' },
    { committeeId: '10', tagId: "12' or 1 eq 1" },
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

  it.each([{}, { author: 'Maillard' }])(
    'preserves rate-limit recovery and removes raw upstream diagnostics for %o',
    async (input) => {
      http.reset();
      http.route({
        match: () => true,
        respond: () =>
          Response.json(
            { error: { innererror: 'private-stack' } },
            { status: 429, headers: { 'Retry-After': '999' } },
          ),
      });
      const result = await runToolContract(searchBusinessTool, input);
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
    },
  );

  it('refuses query text that makes the source request too long, with recovery on both surfaces', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        new URL(request.url).search.length - 1 > 2048
          ? new Response('<!DOCTYPE html><html><title>404 - File or directory not found.</title>', {
              status: 404,
              headers: { 'Content-Type': 'text/html' },
            })
          : Response.json({ d: { results: [], __count: '0' } }),
    });
    const result = await runToolContract(searchBusinessTool, { query: 'é'.repeat(400) });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining('the service accepts at most 2048'),
        data: {
          reason: 'request_too_long',
          recovery: { hint: 'Shorten the text filters and retry this tool.' },
        },
      },
    });
    const text = textContent(result);
    expect(text).toContain('request_too_long');
    expect(text).toContain('the service accepts at most 2048');
    expect(text).toContain('Shorten the text filters and retry this tool.');
    expect(http.calls).toHaveLength(0);
  });

  it('keeps 50-ID hydration batches of maximum-width business IDs within the source limit', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => 2_147_483_647 - index);
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        const filter = url.searchParams.get('$filter') ?? '';
        if (url.pathname === '/odata.svc/Business') {
          const selected = [...filter.matchAll(/ID eq (\d+)/g)].map((match) => Number(match[1]));
          return Response.json({
            d: {
              results: selected.map((ID) => ({ ID, Language: 'DE' })),
              __count: String(selected.length),
            },
          });
        }
        return Response.json({
          d: {
            results: filter.includes('BusinessNumber lt')
              ? []
              : ids.map((BusinessNumber, index) => ({
                  ID: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                  Language: 'DE',
                  BusinessNumber,
                })),
            __count: filter.includes('BusinessNumber lt') ? '0' : '100',
          },
        });
      },
    });
    const result = await runToolContract(searchBusinessTool, { committeeId: '7', limit: 100 });
    expect(result.isError).not.toBe(true);
    const hydration = http.calls
      .map(({ request }) => new URL(request.url))
      .filter((url) => url.pathname === '/odata.svc/Business');
    expect(
      hydration.map((url) => (url.searchParams.get('$filter')?.match(/ID eq /g) ?? []).length),
    ).toEqual([50, 50]);
    for (const url of hydration) expect(url.search.length - 1).toBeLessThanOrEqual(2048);
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

  it('delivers a full committee page of large records and continues after the last business', async () => {
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
    const older = {
      ID: '00000000-0000-4000-8000-000000000021',
      Language: 'DE',
      BusinessNumber: 20991214,
    };
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json({
          d:
            new URL(request.url).pathname === '/odata.svc/Business'
              ? { results: roles.map((row) => row.Businesses), __count: '20' }
              : new URL(request.url).searchParams.get('$filter')?.includes('BusinessNumber lt')
                ? [older]
                : roles,
        }),
    });
    const result = await runToolContract(searchBusinessTool, { committeeId: '7' });
    const items = searchBusinessTool.output.parse(result.structuredContent).businesses;
    expect(items.map((item) => item.title)).toEqual(roles.map((row) => row.Businesses.Title));
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expect(result.structuredContent).toMatchObject({ returnedCount: 20, hasMore: true });
    expect(
      JSON.parse(Buffer.from(businessNextCursor(result), 'base64url').toString()),
    ).toMatchObject({ lastBusinessId: '20991215', route: 'committee' });
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

  it('continues cursors issued by 0.2.0 for direct and committee searches', async () => {
    // Literal 0.2.0 cursors: filters added later must drop out of the fingerprint when absent.
    const direct =
      'eyJ2ZXJzaW9uIjoxLCJmaW5nZXJwcmludCI6IjE0NjUwMzM0YThiOTZlZjgxZjQ3YTM5ZGZiMGM2MDlmNDdiZGJjOGQzM2YyMTkwMjA4YmYxYjQ1NGFmMThkMWEiLCJsYW5ndWFnZSI6ImRlIiwib3JkZXIiOiJidXNpbmVzc19pZF9kZXNjIiwicm91dGUiOiJidXNpbmVzcyIsImxhc3RCdXNpbmVzc0lkIjoiMjA5OTEyMzQifQ';
    const committee =
      'eyJ2ZXJzaW9uIjoxLCJmaW5nZXJwcmludCI6ImVkMjJmZTdlMmQ0NTQ4OTYyZTcxMjU3ZWM4NzBiMWUzOGJkZWMzOGU0OGUyYWM5ZDA5OTU1MWE5ZDFiMGNkNDMiLCJsYW5ndWFnZSI6ImRlIiwib3JkZXIiOiJidXNpbmVzc19pZF9kZXNjIiwicm91dGUiOiJjb21taXR0ZWUiLCJsYXN0QnVzaW5lc3NJZCI6IjIwOTkxMjMzIn0';
    serve({ d: { results: [{ ID: 20991233, Language: 'DE' }], __count: '2' } });
    const continued = await runToolContract(searchBusinessTool, {
      query: 'original',
      limit: 1,
      cursor: direct,
    });
    expect(continued.isError).not.toBe(true);
    expect(continued.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991233' }],
      totalCount: 2,
    });
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (substringof('original',Title) and ID lt 20991234)",
    );
    serve({ d: [] });
    const roles = await runToolContract(searchBusinessTool, {
      committeeId: '7',
      cursor: committee,
    });
    expect(roles.isError).not.toBe(true);
    expect(roles.structuredContent).toMatchObject({ businesses: [], hasMore: false });
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (CommitteeNumber eq 7 and Businesses/Language eq 'DE' and BusinessNumber lt 20991233)",
    );
  });

  it('reads one member role with its inline total and recounts the original filters on continuation', async () => {
    serveRoles([20991234, 20991233, 20991232].map((id, index) => roleRow(index + 1, id)));
    const input = { ...conjunction, personNumber: '4102', role: 'author', limit: 2 };
    const first = await runToolContract(searchBusinessTool, input);
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      businesses: [
        { ...businessSummary, businessId: '20991234' },
        {
          businessId: '20991233',
          sourceUrl:
            "https://ws.parlament.ch/odata.svc/Business(ID=20991233,Language='DE')?$format=json",
        },
      ],
      effectiveFilters: { personNumber: '4102', role: 'author', limit: 2 },
      returnedCount: 2,
      totalCount: 3,
      hasMore: true,
    });
    expect(first.structuredContent).not.toHaveProperty('notice');
    const cursor = businessNextCursor(first);
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toMatchObject({
      route: 'member',
      lastBusinessId: '20991233',
    });
    const second = await runToolContract(searchBusinessTool, { ...input, cursor });
    expect(second.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991232' }],
      returnedCount: 1,
      totalCount: 3,
      hasMore: false,
    });
    expect(second.structuredContent).not.toHaveProperty('nextCursor');
    const owner = `MemberCouncilNumber eq 4102 and Role eq 7 and Businesses/Language eq 'DE' and ${roleClauses}`;
    const page = `Language eq 'DE' and (${owner})`;
    expect(requestShapes()).toEqual([
      ['BusinessRole', page, 'allpages', '2'],
      ['Business', expect.stringContaining('ID eq 20991234 or ID eq 20991233'), 'allpages', '2'],
      ['BusinessRole', `Language eq 'DE' and (${owner} and BusinessNumber lt 20991233)`, null, '1'],
      ['BusinessRole', `Language eq 'DE' and (${owner} and BusinessNumber lt 20991233)`, null, '2'],
      ['BusinessRole', page, 'allpages', '1'],
      ['Business', expect.stringContaining('ID eq 20991232'), 'allpages', '1'],
      ['BusinessRole', `Language eq 'DE' and (${owner} and BusinessNumber lt 20991232)`, null, '1'],
    ]);
    for (const { request } of http.calls.filter(({ request }) =>
      request.url.includes('/BusinessRole?'),
    )) {
      const url = new URL(request.url);
      expect(url.searchParams.get('$select')).toBe('ID,Language,BusinessNumber');
      expect(url.searchParams.get('$orderby')).toBe('BusinessNumber desc,ID asc');
    }
    expectBusinessParity(first);
    expectBusinessParity(second);
  });

  it('pages every role of a member once per business without a total and discloses short pages', async () => {
    serveRoles([
      roleRow(1, 20991234),
      roleRow(2, 20991234),
      roleRow(3, 20991233),
      roleRow(4, 20991232),
    ]);
    const result = await runToolContract(searchBusinessTool, { personNumber: '4102', limit: 3 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991234' }, { businessId: '20991233' }],
      returnedCount: 2,
      effectiveLimit: 3,
      hasMore: true,
      notice:
        "Pages without role examine at most the effective limit of this member's role rows and return each business once. Pages can be short; a distinct business total is unavailable. A single role reports an exact total.",
    });
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    const owner = "MemberCouncilNumber eq 4102 and Businesses/Language eq 'DE'";
    expect(requestShapes()).toEqual([
      ['BusinessRole', `Language eq 'DE' and (${owner})`, null, '3'],
      ['Business', expect.stringContaining('ID eq 20991234 or ID eq 20991233'), 'allpages', '2'],
      ['BusinessRole', `Language eq 'DE' and (${owner} and BusinessNumber lt 20991233)`, null, '1'],
    ]);
    expect(textContent(result)).toContain('A single role reports an exact total.');
    expectBusinessParity(result);
  });

  it.each([
    ['author', 7],
    ['cosignatory', 3],
    ['spokesperson', 2],
    ['opponent', 1],
    ['successor', 4],
  ])(
    'maps role %s to BusinessRole.Role %i and reports an empty exact total',
    async (role, code) => {
      serveRoles([]);
      const result = await runToolContract(searchBusinessTool, { personNumber: '1156', role });
      expect(result.structuredContent).toMatchObject({
        businesses: [],
        totalCount: 0,
        returnedCount: 0,
        hasMore: false,
        notice: expect.stringContaining('No parliamentary business matched'),
      });
      expect(requestShapes()).toEqual([
        [
          'BusinessRole',
          `Language eq 'DE' and (MemberCouncilNumber eq 1156 and Role eq ${code} and Businesses/Language eq 'DE')`,
          'allpages',
          '20',
        ],
      ]);
      expectBusinessParity(result);
    },
  );

  it.each([
    {
      input: { personNumber: '4102', committeeId: '7' },
      message: 'personNumber cannot be combined with committeeId.',
      hint: 'Search by committeeId or by personNumber, not both, then retry chparl_search_business.',
    },
    {
      input: { role: 'author' },
      message: 'role requires personNumber.',
      hint: 'Add personNumber from chparl_search_members, or omit role, then retry chparl_search_business.',
    },
    {
      input: { role: 'cosignatory', committeeId: '7' },
      message: 'role requires personNumber.',
      hint: 'Add personNumber from chparl_search_members, or omit role, then retry chparl_search_business.',
    },
  ])('rejects $input as incompatible_fields before I/O', async ({ input, message, hint }) => {
    const result = await runToolContract(searchBusinessTool, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message,
        data: { reason: 'incompatible_fields', recovery: { hint } },
      },
    });
    expect(textContent(result)).toContain('incompatible_fields');
    expect(textContent(result)).toContain(hint);
    expect(http.calls).toHaveLength(0);
  });

  it('rejects cursors from another route, member, or role before I/O', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/odata.svc/Business')
          return Response.json({ d: { results: [businessRow], __count: '2' } });
        const older = url.searchParams.get('$filter')?.includes('BusinessNumber lt');
        return Response.json({ d: [roleRow(1, older ? 20991233 : 20991234)] });
      },
    });
    const issue = async (input: Record<string, unknown>) =>
      businessNextCursor(await runToolContract(searchBusinessTool, { ...input, limit: 1 }));
    const cursors = {
      direct: await issue({}),
      committee: await issue({ committeeId: '7' }),
      member: await issue({ personNumber: '4102' }),
      author: await issue({ personNumber: '4102', role: 'author' }),
    };
    const issued = http.calls.length;
    for (const [cursor, input] of [
      [cursors.committee, { personNumber: '4102' }],
      [cursors.direct, { personNumber: '4102' }],
      [cursors.member, { committeeId: '7' }],
      [cursors.member, {}],
      [cursors.member, { personNumber: '1156' }],
      [cursors.member, { personNumber: '4102', role: 'author' }],
      [cursors.author, { personNumber: '4102', role: 'cosignatory' }],
      [cursors.author, { personNumber: '4102' }],
    ] as const) {
      const result = await runToolContract(searchBusinessTool, { ...input, limit: 1, cursor });
      expect(result.structuredContent, JSON.stringify(input)).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_cursor' } },
      });
    }
    expect(http.calls).toHaveLength(issued);
    const routed = JSON.parse(Buffer.from(cursors.member, 'base64url').toString());
    const rerouted = Buffer.from(JSON.stringify({ ...routed, route: 'committee' })).toString(
      'base64url',
    );
    const result = await runToolContract(searchBusinessTool, {
      personNumber: '4102',
      cursor: rerouted,
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_cursor' } },
    });
    expect(http.calls).toHaveLength(issued);
  });

  const year = { submittedFrom: '2026-01-01', submittedTo: '2026-12-31' };

  it.each([
    {
      tagId: '12',
      clause:
        "(Tags eq '12' or startswith(Tags,'12|') or endswith(Tags,'|12') or substringof('|12|',Tags))",
      included: ['12', '12|1216', '28|12', '4|12|28'],
      excluded: ['28|1216', '1216', '112|212', '121', undefined],
    },
    {
      tagId: '4',
      clause:
        "(Tags eq '4' or startswith(Tags,'4|') or endswith(Tags,'|4') or substringof('|4|',Tags))",
      included: ['4', '4|1221', '1221|4', '24|4|44'],
      excluded: ['421', '44', '14|41', '24|44', undefined],
    },
  ])(
    'matches tag $tagId as one whole Tags element with an exact total',
    async ({ tagId, clause, included, excluded }) => {
      const rows = [...included, ...excluded].map((Tags, index) => ({
        ID: 20991240 - index,
        Language: 'DE',
        ...(Tags !== undefined && { Tags }),
      }));
      http.reset();
      http.route({
        match: () => true,
        respond: (request) => {
          const filter = new URL(request.url).searchParams.get('$filter') ?? '';
          const matched = rows.filter((row) => tagFilterMatches(filter, row.Tags));
          return Response.json({ d: { results: matched, __count: String(matched.length) } });
        },
      });
      const result = await runToolContract(searchBusinessTool, { tagId, ...year, limit: 100 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        businesses: rows.slice(0, included.length).map((row) => ({ businessId: String(row.ID) })),
        effectiveFilters: { tagId, ...year },
        returnedCount: included.length,
        totalCount: included.length,
        hasMore: false,
      });
      expect(requestShapes()).toEqual([
        [
          'Business',
          `Language eq 'DE' and (SubmissionDate ge datetime'2026-01-01T00:00:00' and SubmissionDate le datetime'2026-12-31T23:59:59.999' and ${clause})`,
          'allpages',
          '100',
        ],
      ]);
      expectBusinessParity(result);
    },
  );

  it.each([
    { tagId: '12' },
    { tagId: '12', submittedFrom: '2026-01-01' },
    { tagId: '12', submittedTo: '2026-12-31' },
    { tagId: '12', sessionId: '5107' },
    { tagId: '12', author: 'Bertschy' },
    { tagId: '12', submittedFrom: '2024-01-01', submittedTo: '2025-01-01' },
    { tagId: '12', submittedFrom: '2025-01-01', submittedTo: '2026-01-02' },
  ])(
    'requires a closed window of at most 366 days for direct tag search %o before I/O',
    async (input) => {
      const result = await runToolContract(searchBusinessTool, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'tag_scope_required',
            recovery: {
              hint: 'Supply submittedFrom and submittedTo at most 366 days apart, or scope by committeeId or personNumber, then retry chparl_search_business.',
            },
          },
        },
      });
      expect(textContent(result)).toContain('tag_scope_required');
      expect(textContent(result)).toContain('at most 366 days apart');
      expect(http.calls).toHaveLength(0);
    },
  );

  it.each([
    { submittedFrom: '2024-01-01', submittedTo: '2024-12-31' },
    { submittedFrom: '2025-01-01', submittedTo: '2026-01-01' },
    { submittedFrom: '2026-03-01', submittedTo: '2026-03-01' },
  ])('accepts a direct tag window of $submittedFrom to $submittedTo', async (window) => {
    serve({ d: { results: [], __count: '0' } });
    const result = await runToolContract(searchBusinessTool, { tagId: '9999', ...window });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      businesses: [],
      totalCount: 0,
      hasMore: false,
      notice:
        'No parliamentary business matched these filters. Use chparl_list_reference with topic business_types, statuses, sessions, committees, or tags to verify codes, or broaden chparl_search_business.',
    });
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    {
      input: { committeeId: '10', tagId: '15' },
      owner: "CommitteeNumber eq 10 and Businesses/Language eq 'DE'",
      count: null,
    },
    {
      input: { personNumber: '1156', role: 'author', tagId: '2841' },
      owner: "MemberCouncilNumber eq 1156 and Role eq 7 and Businesses/Language eq 'DE'",
      count: 'allpages',
    },
  ])(
    'runs tagId through Businesses/Tags on role routes without a window',
    async ({ input, owner, count }) => {
      serveRoles([roleRow(1, 20991234), roleRow(2, 20991233)]);
      const result = await runToolContract(searchBusinessTool, { ...input, limit: 1 });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        businesses: [{ businessId: '20991234' }],
        hasMore: true,
      });
      const tag = input.tagId;
      const clause = `(Businesses/Tags eq '${tag}' or startswith(Businesses/Tags,'${tag}|') or endswith(Businesses/Tags,'|${tag}') or substringof('|${tag}|',Businesses/Tags))`;
      expect(requestShapes()).toEqual([
        ['BusinessRole', `Language eq 'DE' and (${owner} and ${clause})`, count, '1'],
        ['Business', expect.stringContaining('ID eq 20991234'), 'allpages', '1'],
        [
          'BusinessRole',
          `Language eq 'DE' and (${owner} and ${clause} and BusinessNumber lt 20991234)`,
          null,
          '1',
        ],
      ]);
      expect(tagFilterMatches(clause, tag)).toBe(true);
      expect(tagFilterMatches(clause, `${tag}1`)).toBe(false);
    },
  );

  it('keeps a maximum-width member, role, tag, and code search within the source query limit', async () => {
    const max = '2147483647';
    serveRoles([roleRow(1, 2_147_483_647), roleRow(2, 2_147_483_646)]);
    const result = await runToolContract(searchBusinessTool, {
      personNumber: max,
      role: 'successor',
      tagId: max,
      typeId: max,
      statusId: max,
      sessionId: max,
      ...year,
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(requestShapes().map(([path]) => path)).toEqual([
      'BusinessRole',
      'Business',
      'BusinessRole',
    ]);
    for (const { request } of http.calls)
      expect(new URL(request.url).search.length - 1).toBeLessThanOrEqual(1024);
  });

  it('binds tagId into the cursor and rejects a cursor from another tag before I/O', async () => {
    serve({ d: { results: [businessRow], __count: '2' } });
    const tagged = businessNextCursor(
      await runToolContract(searchBusinessTool, { tagId: '12', ...year, limit: 1 }),
    );
    const untagged = businessNextCursor(
      await runToolContract(searchBusinessTool, { ...year, limit: 1 }),
    );
    const issued = http.calls.length;
    for (const [cursor, input] of [
      [tagged, { tagId: '15', ...year }],
      [tagged, year],
      [untagged, { tagId: '12', ...year }],
    ] as const) {
      const result = await runToolContract(searchBusinessTool, { ...input, limit: 1, cursor });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'invalid_cursor' } },
      });
    }
    expect(http.calls).toHaveLength(issued);
    const continued = await runToolContract(searchBusinessTool, {
      tagId: '12',
      ...year,
      limit: 1,
      cursor: tagged,
    });
    expect(continued.isError).not.toBe(true);
    expect(new URL(http.calls[issued]?.request.url ?? '').searchParams.get('$filter')).toContain(
      "substringof('|12|',Tags)) and ID lt 20991234",
    );
  });

  it('reports a direct tag total on the first page only and continues with one counted page request', async () => {
    const ids = [20991240, 20991239, 20991238, 20991237, 20991236];
    const rows = ids.map((ID) => ({ ...businessRow, ID, Tags: '12|1216' }));
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        const filter = url.searchParams.get('$filter') ?? '';
        const after = /ID lt (\d+)/.exec(filter)?.[1];
        const selected = rows.filter(
          (row) =>
            tagFilterMatches(filter, row.Tags) && (after === undefined || row.ID < Number(after)),
        );
        const results = selected.slice(0, Number(url.searchParams.get('$top')));
        return Response.json({
          d: url.searchParams.has('$inlinecount')
            ? { results, __count: String(selected.length) }
            : results,
        });
      },
    });
    const input = { tagId: '12', ...year, limit: 2 };
    const first = await runToolContract(searchBusinessTool, input);
    const second = await runToolContract(searchBusinessTool, {
      ...input,
      cursor: businessNextCursor(first),
    });
    const third = await runToolContract(searchBusinessTool, {
      ...input,
      cursor: businessNextCursor(second),
    });
    expect(first.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991240' }, { businessId: '20991239' }],
      returnedCount: 2,
      totalCount: 5,
      hasMore: true,
    });
    expect(second.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991238' }, { businessId: '20991237' }],
      returnedCount: 2,
      hasMore: true,
    });
    expect(second.structuredContent).not.toHaveProperty('totalCount');
    expect(third.structuredContent).toMatchObject({
      businesses: [{ businessId: '20991236' }],
      returnedCount: 1,
      hasMore: false,
    });
    expect(third.structuredContent).not.toHaveProperty('totalCount');
    expect(third.structuredContent).not.toHaveProperty('nextCursor');
    // The cursor is filter-bound but can outlive source deletions.
    rows.length = 0;
    const past = await runToolContract(searchBusinessTool, {
      ...input,
      cursor: businessNextCursor(second),
    });
    expect(past.structuredContent).toMatchObject({ businesses: [], hasMore: false });
    expect(past.structuredContent).not.toHaveProperty('totalCount');
    expect(past.structuredContent).not.toHaveProperty('nextCursor');
    expect(textContent(past)).toContain('No business remains after this cursor');
    const scope =
      "SubmissionDate ge datetime'2026-01-01T00:00:00' and SubmissionDate le datetime'2026-12-31T23:59:59.999' and (Tags eq '12' or startswith(Tags,'12|') or endswith(Tags,'|12') or substringof('|12|',Tags))";
    expect(requestShapes()).toEqual([
      ['Business', `Language eq 'DE' and (${scope})`, 'allpages', '2'],
      ['Business', `Language eq 'DE' and (${scope} and ID lt 20991239)`, 'allpages', '2'],
      ['Business', `Language eq 'DE' and (${scope} and ID lt 20991237)`, 'allpages', '2'],
      ['Business', `Language eq 'DE' and (${scope} and ID lt 20991237)`, 'allpages', '2'],
    ]);
    for (const result of [first, second, third, past]) expectBusinessParity(result);
  });
});
