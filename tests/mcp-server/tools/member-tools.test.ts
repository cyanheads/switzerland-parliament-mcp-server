/**
 * @fileoverview Member search and profile wire contracts through a synthetic network boundary.
 * @module tests/mcp-server/tools/member-tools.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMemberTool } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { searchMembersTool } from '@/mcp-server/tools/definitions/search-members.tool.js';
import {
  committeeRow,
  expectMemberParity,
  interestRow,
  memberGuid,
  memberRow,
  personRow,
} from '../../helpers/member-fixtures.js';
import { decodeParliamentMarkdown, parliamentHttp, textContent } from '../../helpers/parliament.js';

let http: ReturnType<typeof parliamentHttp>;
beforeEach(() => {
  http = parliamentHttp(() => {
    throw new Error('Unexpected Parliament request.');
  });
});
afterEach(() => http.restore());

function serveRows(rows: readonly object[], person: object | undefined = personRow()) {
  http.reset();
  http.route({
    match: () => true,
    respond: (request) => {
      const url = new URL(request.url);
      const isPerson = url.pathname === '/odata.svc/Person';
      const records = isPerson ? (person ? [person] : []) : rows;
      const offset = Number(url.searchParams.get('$skip'));
      const limit = Number(url.searchParams.get('$top'));
      return Response.json({
        d: { results: records.slice(offset, offset + limit), __count: String(records.length) },
      });
    },
  });
}

describe('chparl_search_members', () => {
  it.each([
    [undefined, 'current', 'Active eq true'],
    ['current', 'current', 'Active eq true'],
    ['former', 'former', 'Active eq false'],
    ['all', 'all', undefined],
  ] as const)(
    'echoes membership %s and all resolved defaults on both surfaces',
    async (input, membership, predicate) => {
      serveRows([memberRow()]);
      const result = await runToolContract(searchMembersTool, input ? { membership: input } : {});
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        members: [{ personNumber: '91', memberCouncilId: '801' }],
        effectiveFilters: { language: 'de', membership, limit: 20, offset: 0 },
        returnedCount: 1,
        effectiveLimit: 20,
        totalCount: 1,
        hasMore: false,
        provenance: {
          officialPublication: false,
          attribution: 'Parlamentsdienste der Bundesversammlung, Bern',
        },
      });
      const filter = new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter');
      if (predicate) expect(filter).toContain(predicate);
      else expect(filter).toBe("Language eq 'DE'");
      expect(result.structuredContent).not.toHaveProperty('nextOffset');
      expectMemberParity(result);
    },
  );

  it.each([
    ['n', 'N', 1],
    ['Nationalrat', 'N', 1],
    ['Conseil national', 'N', 1],
    ['Consiglio nazionale', 'N', 1],
    ['s', 'S', 2],
    ['Ständerat', 'S', 2],
    ['Conseil des États', 'S', 2],
    ['Consiglio degli Stati', 'S', 2],
  ] as const)('normalizes council alias %s before querying', async (council, normalized, id) => {
    serveRows([]);
    const result = await runToolContract(searchMembersTool, { council: ` ${council} ` });
    expect(result.structuredContent).toMatchObject({ effectiveFilters: { council: normalized } });
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toContain(
      `Council eq ${id}`,
    );
    expectMemberParity(result);
  });

  it('normalizes every optional blank string and trims only caller filters', async () => {
    serveRows([memberRow({ FirstName: '  Zoë  ' })]);
    const result = await runToolContract(searchMembersTool, {
      query: ' ',
      council: '',
      cantonId: ' ',
      partyId: '',
      groupId: ' ',
      language: ' ',
    });
    expect(result.structuredContent).toMatchObject({
      members: [{ firstName: '  Zoë  ' }],
      effectiveFilters: { language: 'de', membership: 'current', limit: 20, offset: 0 },
    });
    for (const field of ['query', 'council', 'cantonId', 'partyId', 'groupId'])
      expect(result.structuredContent).toHaveProperty(`effectiveFilters.${field}`, undefined);
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (Active eq true)",
    );
    expectMemberParity(result);
  });

  it('echoes all conjunctive filters with escaped original name punctuation', async () => {
    serveRows([]);
    const result = await runToolContract(searchMembersTool, {
      query: "  D'Essai & Étoile  ",
      membership: 'former',
      council: 's',
      cantonId: ' 7 ',
      partyId: ' 8 ',
      groupId: ' 9 ',
      language: ' FR ',
    });
    expect(result.structuredContent).toMatchObject({
      effectiveFilters: {
        query: "D'Essai & Étoile",
        membership: 'former',
        council: 'S',
        cantonId: '7',
        partyId: '8',
        groupId: '9',
        language: 'fr',
        limit: 20,
        offset: 0,
      },
    });
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
      "Language eq 'FR' and (Active eq false and (substringof('D''Essai & Étoile',FirstName) or substringof('D''Essai & Étoile',LastName) or substringof('D''Essai & Étoile',OfficialName)) and Council eq 2 and Canton eq 7 and Party eq 8 and ParlGroupNumber eq 9)",
    );
    expectMemberParity(result);
  });

  it.each([0, 4])(
    'combines clamping with distinct empty/past-end guidance at offset %s',
    async (offset) => {
      serveRows(offset === 0 ? [] : [memberRow()]);
      const result = await runToolContract(searchMembersTool, { limit: 10_000, offset });
      expect(result.structuredContent).toMatchObject({
        members: [],
        returnedCount: 0,
        effectiveLimit: 100,
        hasMore: false,
        notice: expect.stringContaining('clamped to 100'),
        totalCount: offset === 0 ? 0 : 1,
      });
      expect(result.structuredContent).not.toHaveProperty('nextOffset');
      expect(textContent(result)).toContain(
        offset === 0 ? 'No member records matched' : 'past the last matching member record',
      );
      expect(textContent(result)).toContain(offset === 0 ? 'membership all' : 'offset zero');
      expectMemberParity(result);
    },
  );

  it('fills a caller page across opaque source continuation then replays public nextOffset', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) => {
        const url = new URL(request.url);
        const token = url.searchParams.get('$skiptoken');
        const offset = Number(url.searchParams.get('$skip'));
        if (token !== null) {
          expect(token).toBe('source+token/%');
          return Response.json({ d: { results: [memberRow({ ID: 802 })], __count: '3' } });
        }
        if (offset === 2)
          return Response.json({ d: { results: [memberRow({ ID: 803 })], __count: '3' } });
        const next = new URL(url);
        next.searchParams.set('$skiptoken', 'source+token/%');
        return Response.json({ d: { results: [memberRow()], __count: '3', __next: next.href } });
      },
    });
    const first = await runToolContract(searchMembersTool, { limit: 2 });
    expect(first.structuredContent).toMatchObject({
      returnedCount: 2,
      nextOffset: 2,
      hasMore: true,
      totalCount: 3,
    });
    expect(
      searchMembersTool.output
        .parse(first.structuredContent)
        .members.map((row) => row.memberCouncilId),
    ).toEqual(['801', '802']);
    expectMemberParity(first);
    const last = await runToolContract(searchMembersTool, { limit: 2, offset: 2 });
    expect(last.structuredContent).toMatchObject({
      members: [{ memberCouncilId: '803' }],
      returnedCount: 1,
      hasMore: false,
    });
    expect(last.structuredContent).not.toHaveProperty('nextOffset');
    expect(http.calls).toHaveLength(3);
    expectMemberParity(last);
  });

  it('fits a maximum source page by whole names and resumes from delivered rows', async () => {
    const name = `<p>${'原'.repeat(180)}\r\n\tZoë \\ ${'`'.repeat(4)}</p>`;
    const rows = Array.from({ length: 100 }, (_, index) =>
      memberRow({ ID: index + 1, OfficialName: `${name}${index}` }),
    );
    serveRows(rows);
    const result = await runToolContract(searchMembersTool, { limit: 100 });
    const output = searchMembersTool.output.parse(result.structuredContent);
    expect(output.members.length).toBeGreaterThan(0);
    expect(output.members.length).toBeLessThan(100);
    expect(output.members.map((row) => row.officialName)).toEqual(
      rows.slice(0, output.members.length).map((row) => row.OfficialName),
    );
    expect(result.structuredContent).toMatchObject({
      returnedCount: output.members.length,
      nextOffset: output.members.length,
      totalCount: 100,
      effectiveLimit: 100,
      hasMore: true,
      notice: expect.stringContaining('no record fields were shortened'),
    });
    expect(
      new TextEncoder().encode(
        JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
      ).byteLength,
    ).toBeLessThan(24_000);
    expectMemberParity(result);
  });

  it('preserves one oversized original member name and exposes its exact retry path', async () => {
    const name = `<p>${'字'.repeat(10_000)}\r\n</p>`;
    serveRows([memberRow({ OfficialName: name })]);
    const result = await runToolContract(searchMembersTool, { limit: 1 });
    expect(result.structuredContent).toMatchObject({
      members: [{ officialName: name }],
      returnedCount: 1,
      hasMore: false,
      notice: expect.stringContaining('offset=0 and limit=1'),
    });
    expectMemberParity(result);
  });

  it('keeps a source total unknown when none was supplied', async () => {
    http.reset();
    http.route({ match: () => true, respond: Response.json({ d: [memberRow()] }) });
    const result = await runToolContract(searchMembersTool, {});
    expect(result.structuredContent).toMatchObject({ returnedCount: 1, hasMore: false });
    expect(result.structuredContent).not.toHaveProperty('totalCount');
    expectMemberParity(result);
  });
});

const sections = [
  {
    section: 'council_terms',
    field: 'councilTerms',
    entity: 'MemberCouncilHistory',
    row: (overrides: Record<string, unknown> = {}) =>
      memberRow({ ID: memberGuid(3), IdPredecessor: memberGuid(4), ...overrides }),
  },
  { section: 'committees', field: 'committees', entity: 'MemberCommittee', row: committeeRow },
  { section: 'interests', field: 'interests', entity: 'PersonInterest', row: interestRow },
] as const;

describe('chparl_get_member', () => {
  it('defaults to unpaged overview and returns every source affiliation without Person.ID confusion', async () => {
    serveRows([memberRow(), memberRow({ ID: 802, Council: 1, Active: true })]);
    const result = await runToolContract(getMemberTool, { personNumber: ' 91 ' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: true,
      section: 'overview',
      person: { personNumber: '91', id: '901' },
      memberships: [{ memberCouncilId: '801' }, { memberCouncilId: '802' }],
      effectiveFilters: { personNumber: '91', section: 'overview', language: 'de' },
      returnedCount: 2,
      totalCount: 2,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('effectiveLimit');
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    expect(result.structuredContent).not.toHaveProperty('effectiveFilters.limit');
    expect(result.structuredContent).not.toHaveProperty('effectiveFilters.offset');
    for (const call of http.calls)
      expect(new URL(call.request.url).searchParams.get('$filter')).toBe(
        "Language eq 'DE' and (PersonNumber eq 91)",
      );
    expectMemberParity(result);
  });

  it('returns a found person with an empty unpaged overview and section guidance', async () => {
    serveRows([]);
    const result = await runToolContract(getMemberTool, { personNumber: '91' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: true,
      section: 'overview',
      person: { personNumber: '91', id: '901' },
      memberships: [],
      returnedCount: 0,
      totalCount: 0,
      hasMore: false,
      notice:
        'No records are published for this profile section. Use another chparl_get_member section or chparl_search_members with membership all.',
    });
    expect(result.structuredContent).not.toHaveProperty('effectiveLimit');
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    expect(result.structuredContent).not.toHaveProperty('effectiveFilters.limit');
    expect(result.structuredContent).not.toHaveProperty('effectiveFilters.offset');
    expectMemberParity(result);
  });

  it('retains all overview affiliations even beyond the response size budget', async () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      memberRow({ ID: index + 1, OfficialName: '界'.repeat(900) }),
    );
    serveRows(rows);
    const result = await runToolContract(getMemberTool, { personNumber: '91' });
    expect(result.structuredContent).toMatchObject({
      returnedCount: 20,
      totalCount: 20,
      hasMore: false,
      notice: expect.stringContaining('complete unpaged overview exceeds 24000 bytes'),
    });
    expect(getMemberTool.output.parse(result.structuredContent).memberships).toHaveLength(20);
    expectMemberParity(result);
  });

  it.each(['overview', 'council_terms', 'committees', 'interests'] as const)(
    'distinguishes missing Person from empty %s',
    async (section) => {
      http.reset();
      http.route({
        match: () => true,
        respond: Response.json({ d: { results: [], __count: '0' } }),
      });
      const result = await runToolContract(getMemberTool, { personNumber: '91', section });
      expect(result.structuredContent).toMatchObject({
        found: false,
        section,
        effectiveFilters: { personNumber: '91', section, language: 'de' },
        guidance:
          'No person matched this personNumber. Use chparl_search_members with membership all to discover a valid personNumber.',
      });
      for (const field of [
        'person',
        'memberships',
        'councilTerms',
        'committees',
        'interests',
        'returnedCount',
        'hasMore',
        'totalCount',
        'effectiveLimit',
      ])
        expect(result.structuredContent).not.toHaveProperty(field);
      expect(http.calls).toHaveLength(1);
      expectMemberParity(result);
    },
  );

  it.each(sections)(
    'returns complete $section fields with relationship defaults and source URLs',
    async ({ section, field, entity, row }) => {
      serveRows([row()]);
      const result = await runToolContract(getMemberTool, { personNumber: '91', section });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        found: true,
        section,
        [field]: [
          {
            id: expect.any(String),
            sourceUrl: expect.stringContaining(`/odata.svc/${entity}(ID=guid'`),
          },
        ],
        effectiveFilters: { personNumber: '91', language: 'de', section, limit: 20, offset: 0 },
        returnedCount: 1,
        effectiveLimit: 20,
        totalCount: 1,
        hasMore: false,
      });
      const relationship = new URL(http.calls[1]?.request.url ?? '');
      expect(relationship.pathname).toBe(`/odata.svc/${entity}`);
      expect(relationship.searchParams.get('$filter')).toBe(
        "Language eq 'DE' and (PersonNumber eq 91)",
      );
      expectMemberParity(result);
    },
  );

  it.each(sections)(
    'combines clamping and empty/past-end guidance for $section',
    async ({ section, field, row }) => {
      serveRows([row()]);
      const result = await runToolContract(getMemberTool, {
        personNumber: '91',
        section,
        limit: 10_000,
        offset: 10,
      });
      expect(result.structuredContent).toMatchObject({
        found: true,
        [field]: [],
        returnedCount: 0,
        effectiveLimit: 100,
        totalCount: 1,
        hasMore: false,
        notice: expect.stringContaining('clamped to 100'),
      });
      expect(result.structuredContent).not.toHaveProperty('nextOffset');
      expect(textContent(result)).toContain(
        `personNumber=91, section=${section}, language=de, and offset=0`,
      );
      expectMemberParity(result);
      serveRows([]);
      const empty = await runToolContract(getMemberTool, { personNumber: '91', section });
      expect(empty.structuredContent).toMatchObject({
        found: true,
        [field]: [],
        totalCount: 0,
        returnedCount: 0,
        hasMore: false,
      });
      expect(textContent(empty)).toContain('No records are published for this profile section');
      expectMemberParity(empty);
    },
  );

  it.each(sections)(
    'pages $section from actual delivered rows then reaches exhaustion',
    async ({ section, field, row }) => {
      serveRows([
        row({ ID: memberGuid(11) }),
        row({ ID: memberGuid(12) }),
        row({ ID: memberGuid(13) }),
      ]);
      const first = await runToolContract(getMemberTool, { personNumber: '91', section, limit: 2 });
      expect(first.structuredContent).toMatchObject({
        returnedCount: 2,
        nextOffset: 2,
        hasMore: true,
        totalCount: 3,
      });
      expect(getMemberTool.output.parse(first.structuredContent)[field]).toHaveLength(2);
      expectMemberParity(first);
      const last = await runToolContract(getMemberTool, {
        personNumber: '91',
        section,
        limit: 2,
        offset: 2,
      });
      expect(last.structuredContent).toMatchObject({
        returnedCount: 1,
        hasMore: false,
        [field]: [{ id: memberGuid(13) }],
      });
      expect(last.structuredContent).not.toHaveProperty('nextOffset');
      expectMemberParity(last);
    },
  );

  it.each(sections)(
    'fits whole $section rows from maximum pages without changing original fields',
    async ({ section, field, row }) => {
      const original = `<p>${'原'.repeat(250)}\r\n\t</p>`;
      const rows = Array.from({ length: 100 }, (_, index) =>
        row({
          ID: memberGuid(index + 1),
          OfficialName: original,
          CommitteeName: original,
          InterestName: original,
        }),
      );
      serveRows(rows);
      const result = await runToolContract(getMemberTool, {
        personNumber: '91',
        section,
        limit: 100,
      });
      expect(result.isError).not.toBe(true);
      const output = getMemberTool.output.parse(result.structuredContent);
      const records = output.councilTerms ?? output.committees ?? output.interests ?? [];
      expect(records.length).toBeGreaterThan(0);
      expect(records.length).toBeLessThan(100);
      expect(result.structuredContent).toMatchObject({
        returnedCount: records.length,
        effectiveLimit: 100,
        totalCount: 100,
        nextOffset: records.length,
        hasMore: true,
        notice: expect.stringContaining('no record fields were shortened'),
      });
      expect(
        new TextEncoder().encode(
          JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
        ).byteLength,
      ).toBeLessThan(24_000);
      const decoded = decodeParliamentMarkdown(textContent(result));
      expect(decoded.strings).toContain(original);
      expect(output[field]).toHaveLength(records.length);
      expectMemberParity(result);
    },
  );

  it('preserves original HTML, control characters, Unicode and missing/false paid flags on both surfaces', async () => {
    const original = '<b>原 &amp; Zoë</b>\r\n\t\\```\\';
    serveRows(
      [
        interestRow({ InterestName: original, Paid: false }),
        { ID: memberGuid(3), PersonNumber: 91, Language: 'DE', InterestName: '', Paid: null },
        { ID: memberGuid(4), PersonNumber: 91, Language: 'DE' },
      ],
      personRow({ FirstName: original, LastName: '', OfficialName: original }),
    );
    const result = await runToolContract(getMemberTool, {
      personNumber: '91',
      section: 'interests',
    });
    expect(result.isError).not.toBe(true);
    const output = getMemberTool.output.parse(result.structuredContent);
    expect(output.person).toMatchObject({
      firstName: original,
      lastName: '',
      officialName: original,
    });
    expect(output.interests?.[0]).toMatchObject({ interestName: original, paid: false });
    expect(output.interests?.[1]).toHaveProperty('interestName', '');
    expect(output.interests?.[1]).not.toHaveProperty('paid');
    expect(output.interests?.[2]).not.toHaveProperty('paid');
    expectMemberParity(result);
  });

  it('returns one indivisible oversized interest with exact retrieval guidance', async () => {
    const name = `<p>${'é'.repeat(15_000)}</p>`;
    serveRows([interestRow({ InterestName: name })]);
    const result = await runToolContract(getMemberTool, {
      personNumber: '91',
      section: 'interests',
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      interests: [{ interestName: name }],
      returnedCount: 1,
      hasMore: false,
      notice: expect.stringContaining(
        'personNumber=91, section=interests, language=de, offset=0, limit=1',
      ),
    });
    expectMemberParity(result);
  });

  it.each(sections)(
    'selects French source rows for $section without translating original content',
    async ({ section, row }) => {
      const original = '  Nome originale — 原  ';
      serveRows(
        [
          row({
            Language: 'FR',
            OfficialName: original,
            CommitteeName: original,
            InterestName: original,
          }),
        ],
        personRow({ Language: 'FR', OfficialName: original }),
      );
      const result = await runToolContract(getMemberTool, {
        personNumber: 91,
        language: ' FR ',
        section,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        person: { id: '901', personNumber: '91', metadataLanguage: 'fr', officialName: original },
        effectiveFilters: { language: 'fr' },
      });
      for (const call of http.calls)
        expect(new URL(call.request.url).searchParams.get('$filter')).toBe(
          "Language eq 'FR' and (PersonNumber eq 91)",
        );
      expectMemberParity(result);
    },
  );

  it.each([{ limit: 1 }, { offset: 0 }, { limit: 1, offset: 0 }])(
    'rejects explicit overview pagination %o with declared recovery',
    async (paging) => {
      const result = await runToolContract(getMemberTool, { personNumber: '91', ...paging });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'incompatible_fields',
            recovery: {
              hint: 'Select council_terms, committees, or interests in chparl_get_member before supplying pagination.',
            },
          },
        },
      });
      expect(textContent(result)).toContain('incompatible_fields');
      expect(textContent(result)).toContain('council_terms, committees, or interests');
      expect(http.calls).toHaveLength(0);
    },
  );
});

describe('member tool failure contracts', () => {
  it.each([
    { tool: searchMembersTool, input: { limit: 0 } },
    { tool: searchMembersTool, input: { limit: 10_001 } },
    { tool: searchMembersTool, input: { offset: -1 } },
    { tool: searchMembersTool, input: { offset: Number.MAX_SAFE_INTEGER + 1 } },
    { tool: searchMembersTool, input: { language: 'en' } },
    { tool: searchMembersTool, input: { council: 'unknown' } },
    { tool: searchMembersTool, input: { membership: 'active' } },
    { tool: searchMembersTool, input: { cantonId: '0' } },
    { tool: searchMembersTool, input: { partyId: '2147483648' } },
    { tool: searchMembersTool, input: { groupId: '9 or 1 eq 1' } },
    { tool: getMemberTool, input: {} },
    { tool: getMemberTool, input: { personNumber: '' } },
    { tool: getMemberTool, input: { personNumber: '0' } },
    { tool: getMemberTool, input: { personNumber: 91.5 } },
    { tool: getMemberTool, input: { personNumber: '2147483648' } },
    { tool: getMemberTool, input: { personNumber: '91', section: 'unknown' } },
    { tool: getMemberTool, input: { personNumber: '91', section: 'interests', offset: -1 } },
    { tool: getMemberTool, input: { personNumber: '91', section: 'interests', limit: 10_001 } },
  ])('rejects invalid input $input before I/O', async ({ tool, input }) => {
    const result = await runToolContract<Parameters<typeof runToolContract>[0]>(tool, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(textContent(result)).toContain('Invalid');
    expect(http.calls).toHaveLength(0);
  });

  it.each(['search', 'profile'] as const)(
    'publishes %s rate-limit reason and recovery without upstream diagnostics',
    async (target) => {
      http.reset();
      http.route({
        match: () => true,
        respond: () =>
          Response.json(
            { error: { innererror: 'private-dotnet-stack' } },
            { status: 429, headers: { 'Retry-After': '999' } },
          ),
      });
      const result =
        target === 'search'
          ? await runToolContract(searchMembersTool, {})
          : await runToolContract(getMemberTool, { personNumber: '91' });
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
      expect(textContent(result)).toContain('upstream_rate_limited');
      expect(textContent(result)).toContain('topic coverage');
      expect(JSON.stringify(result)).not.toContain('private-dotnet-stack');
      expect(http.calls).toHaveLength(1);
    },
  );
});
