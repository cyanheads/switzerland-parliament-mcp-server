/**
 * @fileoverview Roll-call workflows at the HTTP boundary and both MCP consumption surfaces.
 * @module tests/mcp-server/tools/votes.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getVotesTool } from '@/mcp-server/tools/definitions/get-votes.tool.js';
import { parliamentHttp, textContent } from '../../helpers/parliament.js';
import { expectVoteParity, voteRow, voteSummary, votingRow } from '../../helpers/vote-fixtures.js';

if (!getVotesTool.enrichment) throw new Error('Vote enrichment contract must be declared.');
const WireSchema = getVotesTool.output.extend(getVotesTool.enrichment);

let http: ReturnType<typeof parliamentHttp>;
let members: Record<string, unknown>[];
let votes: Record<string, unknown>[];
beforeEach(() => {
  members = [];
  votes = [voteRow];
  http = parliamentHttp((request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/odata.svc/Business('))
      return Response.json({ d: { ID: 20991234, Language: 'DE', SubmissionCouncil: 2 } });
    if (url.pathname.startsWith('/odata.svc/Vote(')) return Response.json({ d: voteRow });
    const rows = url.pathname === '/odata.svc/Vote' ? votes : members;
    if (!['/odata.svc/Vote', '/odata.svc/Voting'].includes(url.pathname))
      throw new Error(`Unexpected path ${url.pathname}`);
    const offset = Number(url.searchParams.get('$skip'));
    const top = Number(url.searchParams.get('$top'));
    return Response.json({
      d: { results: rows.slice(offset, offset + top), __count: String(rows.length) },
    });
  });
});
afterEach(() => http.restore());

describe('chparl_get_votes', () => {
  it('finds Nationalrat votes on a Ständerat-first business without loading member rows', async () => {
    const result = await runToolContract(getVotesTool, {
      businessId: ' 20991234 ',
      language: ' DE ',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: true,
      mode: 'votes',
      votes: [voteSummary],
      coverage: { council: 'N', memberRollCallsSince: '2003-winter-session' },
      effectiveFilters: {
        mode: 'votes',
        businessId: '20991234',
        language: 'de',
        limit: 10,
        offset: 0,
      },
      returnedCount: 1,
      effectiveLimit: 10,
      totalCount: 1,
      hasMore: false,
    });
    const urls = http.calls.map((call) => new URL(call.request.url));
    expect(urls).toHaveLength(2);
    expect(urls[1]?.searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (BusinessNumber eq 20991234)",
    );
    expect(urls[1]?.searchParams.get('$orderby')).toBe('ID desc');
    expect(urls[1]?.searchParams.get('$select')).not.toContain('Decision');
    expectVoteParity(result);
  });

  it.each([
    ['votes', 'businessId', 50],
    ['members', 'voteId', 100],
  ] as const)(
    'requests the %s maximum and fits the complete response',
    async (mode, field, max) => {
      votes = Array.from({ length: 50 }, (_, i) => ({
        ID: 500 + i,
        Language: 'DE',
        BusinessNumber: 20991234,
      }));
      members = Array.from({ length: 100 }, (_, i) => ({ ID: i + 1, Language: 'DE', IdVote: 500 }));
      const result = await runToolContract(getVotesTool, {
        mode,
        [field]: field === 'businessId' ? '20991234' : '500',
        limit: 10_000,
      });
      expect(result.structuredContent).toMatchObject({
        effectiveLimit: max,
        notice: expect.stringContaining(`clamped to ${max}`),
      });
      const delivered = getVotesTool.output.parse(result.structuredContent)[mode]?.length ?? 0;
      expect(delivered).toBeGreaterThan(0);
      expect(delivered).toBeLessThanOrEqual(max);
      expect(WireSchema.parse(result.structuredContent).returnedCount).toBe(delivered);
      expect(WireSchema.parse(result.structuredContent).hasMore).toBe(delivered < max);
      expect(new URL(http.calls[1]?.request.url ?? '').searchParams.get('$top')).toBe(String(max));
      expectVoteParity(result);
    },
  );

  it('enumerates 200 members across caller and source pages and counts only the delivered page', async () => {
    members = Array.from({ length: 200 }, (_, i) => votingRow(i + 1));
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/odata.svc/Vote(')) return Response.json({ d: voteRow });
        const offset = Number(url.searchParams.get('$skip'));
        const top = Math.min(37, Number(url.searchParams.get('$top')));
        return Response.json({
          d: { results: members.slice(offset, offset + top), __count: '200' },
        });
      },
    });
    const ids: string[] = [];
    let offset = 0;
    for (;;) {
      const result = await runToolContract(getVotesTool, {
        mode: 'members',
        voteId: '500',
        limit: 100,
        offset,
      });
      expect(result.isError).not.toBe(true);
      const output = getVotesTool.output.parse(result.structuredContent);
      const page = output.members ?? [];
      ids.push(...page.map((row) => row.votingId));
      expect(output.decisionCounts?.scope).toBe('page');
      expect(output.decisionCounts?.counts.reduce((sum, count) => sum + count.count, 0)).toBe(
        page.length,
      );
      expect(WireSchema.parse(result.structuredContent).totalCount).toBe(200);
      expectVoteParity(result);
      const wire = WireSchema.parse(result.structuredContent);
      if (!wire.hasMore) break;
      expect(wire.nextOffset).toBe(offset + page.length);
      offset = Number(wire.nextOffset);
    }
    expect(ids).toEqual(Array.from({ length: 200 }, (_, i) => String(i + 1)));
    const calls = http.calls
      .map((call) => new URL(call.request.url))
      .filter((url) => url.pathname === '/odata.svc/Voting');
    expect(calls.length).toBeGreaterThan(2);
    expect(calls[0]?.searchParams.get('$orderby')).toBe('PersonNumber asc,ID asc');
  });

  it('recomputes page buckets after byte fitting without shortening original decision strings', async () => {
    members = Array.from({ length: 10 }, (_, i) => ({
      ...votingRow(i + 1),
      DecisionText: `<p>${'原'.repeat(1000)}\r\n${i}</p>`,
    }));
    const result = await runToolContract(getVotesTool, {
      mode: 'members',
      voteId: '500',
      limit: 10,
      offset: 0,
    });
    const output = getVotesTool.output.parse(result.structuredContent);
    const delivered = output.members ?? [];
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThan(10);
    expect(delivered.map((row) => row.decisionText)).toEqual(
      members.slice(0, delivered.length).map((row) => row.DecisionText),
    );
    expect(output.decisionCounts?.counts.reduce((sum, count) => sum + count.count, 0)).toBe(
      delivered.length,
    );
    expect(result.structuredContent).toMatchObject({
      returnedCount: delivered.length,
      nextOffset: delivered.length,
      totalCount: 10,
      hasMore: true,
    });
    expect(
      new TextEncoder().encode(
        JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
      ).byteLength,
    ).toBeLessThan(24_000);
    expectVoteParity(result);
  });

  it('retains unknown and missing decisions and group identities in complete aggregates', async () => {
    members = [
      { ID: 1, IdVote: 500, Language: 'DE', Decision: 999, ParlGroupCode: 'A' },
      {
        ID: 2,
        IdVote: 500,
        Language: 'DE',
        Decision: null,
        ParlGroupCode: 'A',
        ParlGroupName: 'Original A',
      },
      { ID: 3, IdVote: 500, Language: 'DE', Decision: 1 },
      { ID: 4, IdVote: 500, Language: 'DE', ParlGroupCode: null, ParlGroupName: null },
    ];
    const result = await runToolContract(getVotesTool, { mode: 'groups', voteId: '500' });
    expect(result.structuredContent).toMatchObject({
      found: true,
      vote: voteSummary,
      returnedCount: 2,
      hasMore: false,
      effectiveFilters: { mode: 'groups', voteId: '500', language: 'de' },
      decisionCounts: {
        scope: 'vote',
        complete: true,
        memberRowCount: 4,
        counts: [{ decisionCode: 1, count: 1 }, { decisionCode: 999, count: 1 }, { count: 2 }],
      },
      groups: [
        {
          groupCode: 'A',
          groupName: 'Original A',
          memberRowCount: 2,
          counts: [{ decisionCode: 999, count: 1 }, { count: 1 }],
        },
        { memberRowCount: 2, counts: [{ decisionCode: 1, count: 1 }, { count: 1 }] },
      ],
    });
    expect(result.structuredContent).not.toHaveProperty('effectiveLimit');
    expect(WireSchema.parse(result.structuredContent).effectiveFilters).not.toHaveProperty('limit');
    expectVoteParity(result);
  });

  it.each(['members', 'groups'] as const)(
    'keeps an empty %s source distinct from complete zero-vote totals',
    async (mode) => {
      const result = await runToolContract(getVotesTool, { mode, voteId: '500' });
      expect(result.structuredContent).toMatchObject({
        found: true,
        [mode]: [],
        returnedCount: 0,
        hasMore: false,
      });
      if (mode === 'groups') expect(result.structuredContent).not.toHaveProperty('decisionCounts');
      expect(textContent(result)).toContain('No complete zero-vote totals can be inferred');
      expectVoteParity(result);
    },
  );

  it('distinguishes filtered person miss from a past-end page and preserves the exact filter total', async () => {
    const missing = await runToolContract(getVotesTool, {
      mode: 'members',
      voteId: '500',
      personNumber: '1001',
    });
    expect(missing.structuredContent).toMatchObject({
      found: true,
      members: [],
      totalCount: 0,
      hasMore: false,
    });
    expect(textContent(missing)).toContain('chparl_search_members');
    expect(new URL(http.calls[1]?.request.url ?? '').searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (IdVote eq 500 and PersonNumber eq 1001)",
    );
    members = [votingRow(1)];
    const past = await runToolContract(getVotesTool, { mode: 'members', voteId: '500', offset: 1 });
    expect(past.structuredContent).toMatchObject({ members: [], totalCount: 1, hasMore: false });
    expect(past.structuredContent).not.toHaveProperty('nextOffset');
    expect(textContent(past)).toContain('past the last matching member decision');
    expectVoteParity(missing);
    expectVoteParity(past);
  });

  it('distinguishes a found business with no roll calls from an absent parent', async () => {
    votes = [];
    const empty = await runToolContract(getVotesTool, { businessId: '20991234' });
    expect(empty.structuredContent).toMatchObject({
      found: true,
      votes: [],
      totalCount: 0,
      returnedCount: 0,
      hasMore: false,
    });
    expect(textContent(empty)).toContain('does not include Ständerat member votes');
    http.reset();
    http.route({ match: () => true, respond: Response.json({ d: null }) });
    const missing = await runToolContract(getVotesTool, { businessId: '20991234' });
    expect(missing.structuredContent).toMatchObject({
      found: false,
      effectiveFilters: { limit: 10, offset: 0 },
    });
    expect(missing.structuredContent).not.toHaveProperty('votes');
    expect(missing.structuredContent).not.toHaveProperty('returnedCount');
    expect(textContent(missing)).toContain('chparl_search_business');
    expectVoteParity(empty);
    expectVoteParity(missing);
  });

  it.each([404, 200])('returns a selected keyed vote miss for HTTP %i', async (status) => {
    http.reset();
    http.route({
      match: () => true,
      respond: Response.json(status === 404 ? {} : { d: null }, { status }),
    });
    const result = await runToolContract(getVotesTool, { mode: 'members', voteId: '500' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ found: false, mode: 'members' });
    expect(textContent(result)).toContain('No roll call matched this voteId');
    expect(result.structuredContent).not.toHaveProperty('members');
    expectVoteParity(result);
  });

  it.each([
    {},
    { mode: 'members' },
    { mode: 'groups' },
    { businessId: '20991234', voteId: '500' },
    { businessId: '20991234', personNumber: '1' },
    { mode: 'members', voteId: '500', businessId: '20991234' },
    { mode: 'groups', voteId: '500', personNumber: '1' },
    { mode: 'groups', voteId: '500', limit: 1 },
    { mode: 'groups', voteId: '500', offset: 0 },
  ] as const)('rejects incompatible mode fields before I/O (%o)', async (input) => {
    const result = await runToolContract(getVotesTool, input);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'incompatible_fields',
          recovery: { hint: expect.stringContaining('mode votes') },
        },
      },
    });
    expect(textContent(result)).toContain('Recovery:');
    expect(textContent(result)).toContain('incompatible_fields');
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    { mode: 'members', voteId: '2147483648' },
    { mode: 'members', voteId: '0' },
    { businessId: '20991234', limit: 0 },
    { businessId: '20991234', limit: 10_001 },
    { businessId: '20991234', offset: -1 },
    { businessId: '20991234', offset: Number.MAX_SAFE_INTEGER + 1 },
  ] as const)('validates numeric boundaries before I/O (%o)', async (input) => {
    const result = await runToolContract(getVotesTool, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('resolves blank optional fields before mode validation and applies member paging defaults', async () => {
    const result = await runToolContract(getVotesTool, {
      mode: 'members',
      voteId: '500',
      businessId: ' ',
      personNumber: '',
      language: ' DE ',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      effectiveFilters: { mode: 'members', voteId: '500', language: 'de', limit: 50, offset: 0 },
      effectiveLimit: 50,
    });
    expect(WireSchema.parse(result.structuredContent).effectiveFilters).not.toHaveProperty(
      'personNumber',
    );
    expectVoteParity(result);
  });

  it('retains a single oversized member decision whole with its exact filtered retrieval path', async () => {
    const original = `<p>${'原é'.repeat(8000)}\r\n</p>`;
    members = [{ ...votingRow(1), DecisionText: original }];
    const result = await runToolContract(getVotesTool, {
      mode: 'members',
      voteId: '500',
      personNumber: '1001',
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      members: [{ decisionText: original }],
      returnedCount: 1,
      hasMore: false,
      decisionCounts: { scope: 'page', counts: [{ decisionCode: 1, count: 1 }] },
    });
    expect(textContent(result)).toContain(
      'voteId=500, language=de, offset=0, limit=1, personNumber=1001',
    );
    expectVoteParity(result);
  });

  it('retains every group in an oversized indivisible complete aggregate', async () => {
    members = Array.from({ length: 30 }, (_, i) => ({
      ...votingRow(i + 1),
      ParlGroupCode: String(i).padStart(2, '0'),
      ParlGroupName: `<p>${'原'.repeat(500)} ${i}</p>`,
    }));
    const result = await runToolContract(getVotesTool, { mode: 'groups', voteId: '500' });
    expect(result.structuredContent).toMatchObject({
      returnedCount: 30,
      hasMore: false,
      decisionCounts: { scope: 'vote', complete: true, memberRowCount: 30 },
      notice: expect.stringContaining('all groups and counts are retained'),
    });
    expect(
      getVotesTool.output.parse(result.structuredContent).groups?.map((group) => group.groupName),
    ).toEqual(members.map((row) => row.ParlGroupName));
    expectVoteParity(result);
  });

  it('keeps past-end votes distinct from a business with no published roll calls', async () => {
    const result = await runToolContract(getVotesTool, {
      businessId: '20991234',
      offset: 1,
      limit: 10_000,
    });
    expect(result.structuredContent).toMatchObject({
      found: true,
      votes: [],
      totalCount: 1,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    expect(textContent(result)).toContain('past the last matching vote');
    expect(textContent(result)).toContain('clamped to 50');
    expectVoteParity(result);
  });

  it('publishes short-number ambiguity and rate limiting with their declared recoveries', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: Response.json({
        d: {
          results: [
            { ID: 20991234, Language: 'DE' },
            { ID: 19991234, Language: 'DE' },
          ],
          __count: '2',
        },
      }),
    });
    const ambiguous = await runToolContract(getVotesTool, { businessId: '99.1234' });
    expect(ambiguous.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'ambiguous_business_number',
          recovery: { hint: expect.stringContaining('chparl_search_business') },
        },
      },
    });
    expect(textContent(ambiguous)).toContain('chparl_search_business');
    http.reset();
    http.route({
      match: () => true,
      respond: Response.json(
        { innererror: 'private-stack' },
        { status: 429, headers: { 'Retry-After': '999' } },
      ),
    });
    const limited = await runToolContract(getVotesTool, { mode: 'groups', voteId: '500' });
    expect(limited.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'upstream_rate_limited',
          retryAfter: '999',
          recovery: { hint: expect.stringContaining('topic coverage') },
        },
      },
    });
    expect(textContent(limited)).toContain('topic coverage');
    expect(JSON.stringify(limited)).not.toContain('private-stack');
  });
});
