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
  it('keeps selected-vote member projections lean while retaining context in the vote header', async () => {
    members = [
      {
        ...votingRow(1),
        BusinessNumber: 20991234,
        BusinessShortNumber: '99.1234',
        BusinessTitle: ' Original ',
        IdSession: 5107,
        VoteEndWithTimezone: '/Date(0+0120)/',
        CantonID: 23,
        Canton: 'VD',
      },
    ];
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json({
          d: new URL(request.url).pathname.startsWith('/odata.svc/Vote(')
            ? { ...voteRow, IdSession: 5107 }
            : { results: members, __count: '1' },
        }),
    });
    const result = await runToolContract(getVotesTool, { mode: 'members', voteId: '500' });
    expect(result.structuredContent).toMatchObject({
      vote: { ...voteSummary, sessionId: '5107' },
      members: [{ votingId: '1', cantonId: '22', votingCantonId: '23', decisionText: 'Oui' }],
      decisionCounts: {
        scope: 'page',
        counts: [{ decisionCode: 1, count: 1, decisionTexts: ['Oui'] }],
      },
    });
    const output = getVotesTool.output.parse(result.structuredContent);
    for (const field of [
      'voteId',
      'businessId',
      'businessShortNumber',
      'businessTitle',
      'sessionId',
      'endTime',
    ])
      expect(output.members?.[0]).not.toHaveProperty(field);
    expect(new URL(http.calls[1]?.request.url ?? '').searchParams.get('$select')).toBe(
      'ID,Language,IdVote,PersonNumber,FirstName,LastName,CantonID,Canton,CantonName,ParlGroupCode,ParlGroupName,Decision,DecisionText',
    );
    expect(http.calls).toHaveLength(2);
    expectVoteParity(result);
  });

  it('characterizes published context on history rows without a selected-vote header', async () => {
    members = [
      {
        ...votingRow(1),
        BusinessNumber: 20991234,
        BusinessShortNumber: '99.1234',
        BusinessTitle: ' Original ',
        IdSession: 5107,
        VoteEndWithTimezone: '/Date(0+0120)/',
      },
    ];
    const result = await runToolContract(getVotesTool, { mode: 'members', personNumber: '1001' });
    expect(result.structuredContent).toMatchObject({
      members: [
        {
          voteId: '500',
          businessId: '20991234',
          businessShortNumber: '99.1234',
          businessTitle: ' Original ',
          sessionId: '5107',
          endTime: '1970-01-01T02:00:00.000+02:00',
        },
      ],
    });
    expect(result.structuredContent).not.toHaveProperty('vote');
    expect(
      new URL(http.calls[0]?.request.url ?? '').searchParams.get('$select')?.split(','),
    ).toEqual(
      expect.arrayContaining([
        'BusinessNumber',
        'BusinessShortNumber',
        'BusinessTitle',
        'IdSession',
        'VoteEnd',
        'VoteEndWithTimezone',
      ]),
    );
    expectVoteParity(result);
  });

  it('publishes canonical canton IDs separately from raw Voting IDs on both surfaces', async () => {
    members = [
      { ...votingRow(1), CantonID: 23, Canton: 'VD', CantonName: ' Vaud ' },
      { ...votingRow(2), CantonID: 21, Canton: 'TI' },
      { ...votingRow(3), CantonID: 999, Canton: 'unknown', CantonName: '' },
      { ...votingRow(4), CantonID: 26 },
    ];
    const result = await runToolContract(getVotesTool, { mode: 'members', voteId: '500' });
    const output = getVotesTool.output.parse(result.structuredContent);
    expect(output.members).toMatchObject([
      { cantonId: '22', votingCantonId: '23', cantonCode: 'VD', cantonName: ' Vaud ' },
      { cantonId: '27', votingCantonId: '21', cantonCode: 'TI' },
      { votingCantonId: '999', cantonCode: 'unknown', cantonName: '' },
      { votingCantonId: '26' },
    ]);
    expect(output.members?.[2]).not.toHaveProperty('cantonId');
    expect(output.members?.[3]).not.toHaveProperty('cantonId');
    expect(http.calls).toHaveLength(2);
    expect(output.provenance.sources.filter((source) => source.url.includes('/Canton?'))).toEqual([
      {
        url: 'https://ws.parlament.ch/odata.svc/Canton?%24format=json&%24filter=Language+eq+%27DE%27&%24select=ID%2CLanguage%2CCantonNumber%2CCantonAbbreviation%2CCantonName&%24top=100&%24orderby=CantonNumber+asc%2CID+asc&%24inlinecount=allpages',
        retrievedAt: '2026-10-26',
      },
    ]);
    expectVoteParity(result);
  });

  it.each(['members', 'groups'] as const)(
    'retains distinct verbatim labels by code in %s counts',
    async (mode) => {
      members = [
        { ...votingRow(1), Decision: 5, DecisionText: 'Hat nicht teilgenommen' },
        { ...votingRow(2), Decision: 5, DecisionText: '' },
        { ...votingRow(3), Decision: 5, DecisionText: 'Hat nicht teilgenommen' },
        { ...votingRow(4), Decision: 5, DecisionText: null },
        { ...votingRow(5), Decision: 4, DecisionText: 'Anwesend' },
        { ...votingRow(6), Decision: 8, DecisionText: 'Demissioniert' },
        { ...votingRow(7), Decision: 999, DecisionText: 'Original [x] \\ label' },
        { ID: 8, Language: 'DE', IdVote: 500, DecisionText: '' },
        { ID: 9, Language: 'DE', IdVote: 500, Decision: null, DecisionText: 'Unknown original' },
        { ID: 10, Language: 'DE', IdVote: 500, Decision: 123 },
      ];
      const result = await runToolContract(getVotesTool, { mode, voteId: '500' });
      expect(getVotesTool.output.parse(result.structuredContent).decisionCounts?.counts).toEqual([
        { decisionCode: 4, count: 1, decisionTexts: ['Anwesend'] },
        { decisionCode: 5, count: 4, decisionTexts: ['Hat nicht teilgenommen', ''] },
        { decisionCode: 8, count: 1, decisionTexts: ['Demissioniert'] },
        { decisionCode: 123, count: 1 },
        { decisionCode: 999, count: 1, decisionTexts: ['Original [x] \\ label'] },
        { count: 2, decisionTexts: ['', 'Unknown original'] },
      ]);
      expectVoteParity(result);
    },
  );

  it('discovers session roll calls with one direct query and optional business conjunction', async () => {
    votes = [{ ...voteRow, IdSession: 5107 }];
    for (const businessId of [undefined, '20991234']) {
      const before = http.calls.length;
      const result = await runToolContract(getVotesTool, { sessionId: '5107', businessId });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        found: true,
        votes: [{ sessionId: '5107' }],
        effectiveFilters: { sessionId: '5107' },
      });
      const calls = http.calls.slice(before);
      expect(calls).toHaveLength(businessId === undefined ? 1 : 2);
      expect(new URL(calls.at(-1)?.request.url ?? '').searchParams.get('$filter')).toBe(
        businessId === undefined
          ? "Language eq 'DE' and (IdSession eq 5107)"
          : "Language eq 'DE' and (BusinessNumber eq 20991234 and IdSession eq 5107)",
      );
      expectVoteParity(result);
    }
  });

  it('pages member history directly with source context and no per-row joins', async () => {
    members = [
      {
        ...votingRow(1),
        BusinessNumber: 20991234,
        BusinessShortNumber: '99.1234',
        BusinessTitle: ' Original ',
        IdSession: 5107,
        VoteEnd: '/Date(0)/',
        VoteEndWithTimezone: '/Date(0+0120)/',
      },
    ];
    const result = await runToolContract(getVotesTool, {
      mode: 'members',
      personNumber: '1001',
      sessionId: '5107',
      businessId: '20991234',
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: true,
      members: [
        {
          voteId: '500',
          businessId: '20991234',
          businessShortNumber: '99.1234',
          businessTitle: ' Original ',
          sessionId: '5107',
          endTime: '1970-01-01T02:00:00.000+02:00',
        },
      ],
      decisionCounts: {
        scope: 'page',
        counts: [{ decisionCode: 1, count: 1, decisionTexts: ['Oui'] }],
      },
      effectiveFilters: { personNumber: '1001', sessionId: '5107', businessId: '20991234' },
    });
    expect(result.structuredContent).not.toHaveProperty('vote');
    expect(http.calls).toHaveLength(2);
    const url = new URL(http.calls[1]?.request.url ?? '');
    expect(url.pathname).toBe('/odata.svc/Voting');
    expect(url.searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (PersonNumber eq 1001 and BusinessNumber eq 20991234 and IdSession eq 5107)",
    );
    expect(url.searchParams.get('$orderby')).toBe('IdVote desc,ID desc');
    expect(url.searchParams.get('$select')).toContain('VoteEndWithTimezone');
    expectVoteParity(result);
  });

  it.each([
    { mode: 'members', personNumber: '1001', sessionId: '5107' },
    { mode: 'votes', sessionId: '5107' },
  ] as const)('keeps empty and past-end unkeyed $mode searches successful', async (input) => {
    members = [];
    votes = [];
    const empty = await runToolContract(getVotesTool, input);
    expect(empty.structuredContent).toMatchObject({
      found: true,
      [input.mode]: [],
      totalCount: 0,
      returnedCount: 0,
      hasMore: false,
    });
    expect(empty.structuredContent).not.toHaveProperty('vote');
    expect(empty.structuredContent).not.toHaveProperty('nextOffset');
    expectVoteParity(empty);
    members = [{ ...votingRow(1), IdSession: 5107 }];
    votes = [{ ...voteRow, IdSession: 5107 }];
    const past = await runToolContract(getVotesTool, { ...input, offset: 1 });
    expect(past.structuredContent).toMatchObject({
      found: true,
      [input.mode]: [],
      totalCount: 1,
      hasMore: false,
    });
    expect(textContent(past)).toContain('past the last matching');
    expect(past.structuredContent).not.toHaveProperty('nextOffset');
    expect(http.calls).toHaveLength(2);
    expectVoteParity(past);
  });

  it('keeps sparse history metadata unknown and falls back only to a published VoteEnd', async () => {
    members = [
      { ID: 1, Language: 'DE', IdVote: 500, PersonNumber: 1001 },
      {
        ID: 2,
        Language: 'DE',
        IdVote: 499,
        PersonNumber: 1001,
        VoteEnd: '/Date(0)/',
        VoteEndWithTimezone: null,
      },
    ];
    const result = await runToolContract(getVotesTool, { mode: 'members', personNumber: '1001' });
    expect(getVotesTool.output.parse(result.structuredContent).members).toEqual([
      { votingId: '1', voteId: '500', personNumber: '1001' },
      { votingId: '2', voteId: '499', personNumber: '1001', endTime: '1970-01-01T00:00:00.000' },
    ]);
    expect(http.calls).toHaveLength(1);
    expectVoteParity(result);
  });

  it('continues byte-fitted member history across source pages and recounts only delivered labels', async () => {
    members = Array.from({ length: 8 }, (_, index) => ({
      ...votingRow(index + 1),
      PersonNumber: 1001,
      IdVote: 500 - index,
      Decision: 5,
      DecisionText: ` ${index} ${'原'.repeat(1000)} `,
    }));
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        expect(url.pathname).toBe('/odata.svc/Voting');
        expect(url.searchParams.get('$filter')).toBe("Language eq 'DE' and (PersonNumber eq 1001)");
        const offset = Number(url.searchParams.get('$skip'));
        const top = Math.min(3, Number(url.searchParams.get('$top')));
        return Response.json({ d: { results: members.slice(offset, offset + top), __count: '8' } });
      },
    });
    const deliveredIds: string[] = [];
    let offset = 0;
    do {
      const result = await runToolContract(getVotesTool, {
        mode: 'members',
        personNumber: '1001',
        limit: 10_000,
        offset,
      });
      expect(result.isError).not.toBe(true);
      const output = getVotesTool.output.parse(result.structuredContent);
      const page = output.members ?? [];
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThan(8);
      expect(output.decisionCounts?.counts).toEqual([
        {
          decisionCode: 5,
          count: page.length,
          decisionTexts: members.slice(offset, offset + page.length).map((row) => row.DecisionText),
        },
      ]);
      deliveredIds.push(...page.map((row) => row.votingId));
      const wire = WireSchema.parse(result.structuredContent);
      expect(wire.effectiveLimit).toBe(100);
      expect(wire.totalCount).toBe(8);
      expect(wire.returnedCount).toBe(page.length);
      expectVoteParity(result);
      offset += page.length;
      if (!wire.hasMore) break;
      expect(wire.nextOffset).toBe(offset);
    } while (offset < 8);
    expect(deliveredIds).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(http.calls.length).toBeGreaterThan(3);
  });

  it('preserves a supplied history business miss without querying unrelated votes', async () => {
    http.reset();
    http.route({ match: () => true, respond: Response.json({ d: null }) });
    const result = await runToolContract(getVotesTool, {
      mode: 'members',
      personNumber: '1001',
      businessId: '20991234',
    });
    expect(result.structuredContent).toMatchObject({ found: false, mode: 'members' });
    expect(result.structuredContent).not.toHaveProperty('members');
    expect(http.calls).toHaveLength(1);
    expectVoteParity(result);
  });

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
    { mode: 'members', sessionId: '5107' },
    { mode: 'members', personNumber: '1001', voteId: '500', sessionId: '5107' },
    { mode: 'groups', voteId: '500', sessionId: '5107' },
    { mode: 'groups', personNumber: '1001', businessId: '20991234' },
    { mode: 'votes', sessionId: '5107', personNumber: '1001' },
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
    { sessionId: '2147483648' },
    { sessionId: '0' },
    { mode: 'members', personNumber: '0' },
    { mode: 'members', personNumber: '1001', sessionId: '-1' },
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
