/**
 * @fileoverview Member search and profile wire contracts through a synthetic network boundary.
 * @module tests/mcp-server/tools/member-tools.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMemberTool } from '@/mcp-server/tools/definitions/get-member.tool.js';
import { searchMembersTool } from '@/mcp-server/tools/definitions/search-members.tool.js';
import {
  committeeHistoryRow,
  committeeRow,
  expectMemberParity,
  historyRosterRow,
  interestRow,
  interestSearchRow,
  memberGuid,
  memberRow,
  personRow,
  rosterRow,
} from '../../helpers/member-fixtures.js';
import {
  decodeParliamentMarkdown,
  parliamentHttp,
  resultBytes,
  textContent,
} from '../../helpers/parliament.js';

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

/** Serve MemberCommittee rosters keyed by the requested CommitteeNumber, and which Committee rows exist. */
function serveRosters(
  rosters: Readonly<Record<string, readonly object[]>>,
  committees: readonly string[] = Object.keys(rosters),
) {
  http.reset();
  http.route({
    match: () => true,
    respond: (request) => {
      const url = new URL(request.url);
      const number = /CommitteeNumber eq (\d+)/.exec(url.searchParams.get('$filter') ?? '')?.[1];
      if (number === undefined) throw new Error('Committee requests must name a CommitteeNumber.');
      if (url.pathname === '/odata.svc/Committee')
        return Response.json({ d: committees.includes(number) ? [{ ID: Number(number) }] : [] });
      const rows = rosters[number] ?? [];
      const offset = Number(url.searchParams.get('$skip'));
      const limit = Number(url.searchParams.get('$top'));
      return Response.json({
        d: { results: rows.slice(offset, offset + limit), __count: String(rows.length) },
      });
    },
  });
}

/** Serve MemberCommitteeHistory rows for one roster, and which Committee rows exist. */
function serveHistory(rows: readonly object[], committees: readonly string[] = ['12']) {
  http.reset();
  http.route({
    match: () => true,
    respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/odata.svc/Committee') {
        const number = /CommitteeNumber eq (\d+)/.exec(url.searchParams.get('$filter') ?? '')?.[1];
        return Response.json({ d: number && committees.includes(number) ? [{ ID: 1 }] : [] });
      }
      if (url.pathname !== '/odata.svc/MemberCommitteeHistory')
        throw new Error(`Unexpected ${url.pathname} request.`);
      const offset = Number(url.searchParams.get('$skip'));
      const limit = Number(url.searchParams.get('$top'));
      return Response.json({
        d: { results: rows.slice(offset, offset + limit), __count: String(rows.length) },
      });
    },
  });
}

/** Synthetic roster on a past day, each membership with its own recorded affiliation. */
function historyRoster(size: number) {
  return Array.from({ length: size }, (_, index) =>
    historyRosterRow(
      { ID: memberGuid(4100 + index), PersonNumber: 5100 + index },
      { ID: 5100 + index, PersonNumber: 5100 + index },
    ),
  );
}

/** Serve PersonInterest declarations with their declarants; any other entity is unexpected. */
function serveInterests(rows: readonly object[]) {
  http.reset();
  http.route({
    match: () => true,
    respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname !== '/odata.svc/PersonInterest')
        throw new Error(`Unexpected ${url.pathname} request.`);
      const offset = Number(url.searchParams.get('$skip'));
      const limit = Number(url.searchParams.get('$top'));
      return Response.json({
        d: { results: rows.slice(offset, offset + limit), __count: String(rows.length) },
      });
    },
  });
}

/** Synthetic declarations, two per declarant, ordered as the source orders them. */
function declarations(size: number) {
  return Array.from({ length: size }, (_, index) =>
    interestSearchRow(
      {
        ID: memberGuid(7000 + index),
        PersonNumber: 6000 + Math.floor(index / 2),
        InterestName: `Groupe de réflexion Groupe Mutuel ${index}`,
        SortOrder: index % 2,
      },
      { ID: 6000 + Math.floor(index / 2), PersonNumber: 6000 + Math.floor(index / 2) },
    ),
  );
}

function requestedPaths(): string[] {
  return http.calls.map((call) => new URL(call.request.url).pathname);
}

/** Synthetic 25-membership roster: one Präsident/in, one Vizepräsident/in, 23 Mitglieder. */
function roster(size: number, firstId = 4100) {
  return Array.from({ length: size }, (_, index) =>
    rosterRow(
      {
        ID: memberGuid(firstId + index),
        CommitteeFunction: index === 0 ? 2 : index === 1 ? 6 : 1,
        CommitteeFunctionName:
          index === 0 ? 'Präsident/in' : index === 1 ? 'Vizepräsident/in' : 'Mitglied',
      },
      {
        ID: firstId + index,
        PersonNumber: firstId + 1000 + index,
        LastName: `Synthétique ${String(index).padStart(2, '0')}`,
      },
    ),
  );
}

/** The exact MemberCouncil request URL, assembled from literal query pairs in wire order. */
function memberCouncilUrl(filter: string): string {
  return `https://ws.parlament.ch/odata.svc/MemberCouncil?${new URLSearchParams([
    ['$format', 'json'],
    ['$filter', filter],
    [
      '$select',
      'ID,Language,PersonNumber,FirstName,LastName,OfficialName,Active,Council,CouncilName,CouncilAbbreviation,Canton,CantonName,CantonAbbreviation,Party,PartyName,PartyAbbreviation,ParlGroupNumber,ParlGroupName,ParlGroupAbbreviation,DateJoining,DateLeaving',
    ],
    ['$orderby', 'LastName asc,FirstName asc,ID asc'],
    ['$inlinecount', 'allpages'],
    ['$top', '20'],
    ['$skip', '0'],
  ])}`;
}

const everyNarrowingFilter = {
  query: "D'Essai",
  council: 'N',
  cantonId: '7',
  partyId: '8',
  groupId: '9',
};
const narrowingPredicates =
  "(substringof('D''Essai',FirstName) or substringof('D''Essai',LastName) or substringof('D''Essai',OfficialName)) and Council eq 1 and Canton eq 7 and Party eq 8 and ParlGroupNumber eq 9";

describe('chparl_search_members', () => {
  it.each([
    [undefined, {}, "Language eq 'DE' and (Active eq true)"],
    ['current', {}, "Language eq 'DE' and (Active eq true)"],
    ['former', {}, "Language eq 'DE' and (Active eq false)"],
    ['all', {}, "Language eq 'DE'"],
    [
      undefined,
      everyNarrowingFilter,
      `Language eq 'DE' and (Active eq true and ${narrowingPredicates})`,
    ],
    [
      'current',
      everyNarrowingFilter,
      `Language eq 'DE' and (Active eq true and ${narrowingPredicates})`,
    ],
    [
      'former',
      everyNarrowingFilter,
      `Language eq 'DE' and (Active eq false and ${narrowingPredicates})`,
    ],
    ['all', everyNarrowingFilter, `Language eq 'DE' and (${narrowingPredicates})`],
  ] as const)(
    'sends the byte-identical MemberCouncil request for membership %s with filters %o',
    async (membership, filters, filter) => {
      serveRows([memberRow()]);
      const result = await runToolContract(searchMembersTool, {
        ...(membership && { membership }),
        ...filters,
      });
      expect(result.isError).not.toBe(true);
      expect(http.calls.map((call) => call.request.url)).toEqual([memberCouncilUrl(filter)]);
      expect(result.structuredContent).not.toHaveProperty('committeeFound');
      expect(result.structuredContent).not.toHaveProperty('guidance');
      expect(textContent(result)).not.toContain('committeeFound');
    },
  );

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
    ['Conseil des Etats', 'S', 2],
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

  it('returns a full 100-record page of large names, then the short last page and the past-end offset', async () => {
    const name = `<p>${'原'.repeat(180)}\r\n\tZoë \\ ${'`'.repeat(4)}</p>`;
    const rows = Array.from({ length: 150 }, (_, index) =>
      memberRow({ ID: index + 1, OfficialName: `${name}${index}` }),
    );
    serveRows(rows);
    const delivered: (string | undefined)[] = [];
    for (const [offset, size, nextOffset] of [
      [0, 100, 100],
      [100, 50, undefined],
    ] as const) {
      const result = await runToolContract(searchMembersTool, { limit: 100, offset });
      const output = searchMembersTool.output.parse(result.structuredContent);
      expect(output.members).toHaveLength(size);
      expect(result.structuredContent).toMatchObject({
        returnedCount: size,
        totalCount: 150,
        effectiveLimit: 100,
        hasMore: nextOffset !== undefined,
        ...(nextOffset !== undefined && { nextOffset }),
      });
      if (nextOffset === undefined)
        expect(result.structuredContent).not.toHaveProperty('nextOffset');
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(resultBytes(result)).toBeGreaterThan(24_000);
      expectMemberParity(result);
      delivered.push(...output.members.map((row) => row.officialName));
    }
    expect(delivered).toEqual(rows.map((row) => row.OfficialName));

    const past = await runToolContract(searchMembersTool, { limit: 100, offset: 150 });
    expect(past.structuredContent).toMatchObject({
      members: [],
      returnedCount: 0,
      totalCount: 150,
      hasMore: false,
      notice: expect.stringContaining('past the last matching member record'),
    });
    expect(http.calls).toHaveLength(3);
  });

  it('returns a record over 24000 bytes whole on a limit 1 page with no size notice', async () => {
    const name = `<p>${'字'.repeat(10_000)}\r\n</p>`;
    serveRows([memberRow({ OfficialName: name }), memberRow({ ID: 802 })]);
    const result = await runToolContract(searchMembersTool, { limit: 1 });
    expect(result.structuredContent).toMatchObject({
      members: [{ officialName: name }],
      returnedCount: 1,
      nextOffset: 1,
      hasMore: true,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(resultBytes(result)).toBeGreaterThan(24_000);
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

describe('chparl_search_members committee rosters', () => {
  it('carries each MemberCouncil record and its committee function on both surfaces', async () => {
    serveRosters({ '12': roster(25) });
    const result = await runToolContract(searchMembersTool, {
      committeeId: ' 12 ',
      membership: 'current',
      limit: 2,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      committeeFound: true,
      members: [
        {
          memberCouncilId: '4100',
          personNumber: '5100',
          sourceUrl: "https://ws.parlament.ch/odata.svc/MemberCouncil(ID=4100,Language='DE')",
          active: true,
          joinedDate: '1970-01-01T01:00:00.000+01:00',
          committeeFunctionId: 2,
          committeeFunctionName: 'Präsident/in',
        },
        {
          memberCouncilId: '4101',
          committeeFunctionId: 6,
          committeeFunctionName: 'Vizepräsident/in',
        },
      ],
      effectiveFilters: { committeeId: '12', membership: 'current', limit: 2, offset: 0 },
      returnedCount: 2,
      totalCount: 25,
      nextOffset: 2,
      hasMore: true,
    });
    expect(result.structuredContent).not.toHaveProperty('guidance');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(requestedPaths()).toEqual(['/odata.svc/MemberCommittee']);
    expectMemberParity(result);
  });

  it('returns the whole 25-membership roster on one limit 30 page', async () => {
    const rows = roster(25);
    serveRosters({ '12': rows });
    const result = await runToolContract(searchMembersTool, { committeeId: '12', limit: 30 });
    const output = searchMembersTool.output.parse(result.structuredContent);
    expect(output.members.map((row) => row.memberCouncilId)).toEqual(
      rows.map((row) => String(row.MembersCouncil.ID)),
    );
    expect(result.structuredContent).toMatchObject({
      committeeFound: true,
      returnedCount: 25,
      totalCount: 25,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('nextOffset');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expectMemberParity(result);
  });

  it('walks a 25-membership roster in limit 10 pages once each and then reports the past-end offset', async () => {
    const rows = roster(25);
    serveRosters({ '12': rows });
    const delivered: string[] = [];
    for (const [offset, size, nextOffset] of [
      [0, 10, 10],
      [10, 10, 20],
      [20, 5, undefined],
    ] as const) {
      const result = await runToolContract(searchMembersTool, {
        committeeId: '12',
        limit: 10,
        offset,
      });
      const output = searchMembersTool.output.parse(result.structuredContent);
      expect(output.members).toHaveLength(size);
      expect(result.structuredContent).toMatchObject({
        committeeFound: true,
        totalCount: 25,
        hasMore: nextOffset !== undefined,
      });
      expect((result.structuredContent as { nextOffset?: number }).nextOffset).toBe(nextOffset);
      expect(result.structuredContent).not.toHaveProperty('notice');
      expectMemberParity(result);
      delivered.push(...output.members.map((row) => row.memberCouncilId));
    }
    expect(delivered).toEqual(rows.map((row) => String(row.MembersCouncil.ID)));

    const past = await runToolContract(searchMembersTool, { committeeId: '12', offset: 25 });
    expect(past.structuredContent).toMatchObject({
      members: [],
      committeeFound: true,
      totalCount: 25,
      returnedCount: 0,
      hasMore: false,
      notice: expect.stringContaining('past the last matching member record'),
    });
    expect(past.structuredContent).not.toHaveProperty('nextOffset');
    expect(new Set(requestedPaths())).toEqual(new Set(['/odata.svc/MemberCommittee']));
    expectMemberParity(past);
  });

  it.each([
    ['3', 25, '4100'],
    ['788', 9, '9000'],
  ] as const)(
    'lists committee %s by its own number and total',
    async (committeeId, size, firstMemberCouncilId) => {
      serveRosters({ '3': roster(25), '788': roster(9, 9000) });
      const result = await runToolContract(searchMembersTool, { committeeId, limit: 1 });
      expect(result.structuredContent).toMatchObject({
        totalCount: size,
        members: [{ memberCouncilId: firstMemberCouncilId }],
      });
      expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
        `Language eq 'DE' and (CommitteeNumber eq ${committeeId})`,
      );
    },
  );

  it('narrows a roster with normalized caller filters and explains a zero-hit committee search', async () => {
    serveRosters({ '12': [] });
    const result = await runToolContract(searchMembersTool, {
      committeeId: '12',
      council: 'Ständerat',
      cantonId: '12',
    });
    expect(result.structuredContent).toMatchObject({
      members: [],
      committeeFound: true,
      totalCount: 0,
      effectiveFilters: { committeeId: '12', council: 'S', cantonId: '12' },
      notice: expect.stringContaining('No current members of this committee matched these filters'),
    });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).not.toContain('membership');
    expect(result.structuredContent).not.toHaveProperty('guidance');
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (CommitteeNumber eq 12 and MembersCouncil/Council eq 2 and MembersCouncil/Canton eq 12)",
    );
    expect(requestedPaths()).toEqual(['/odata.svc/MemberCommittee', '/odata.svc/Committee']);
    expectMemberParity(result);
  });

  it.each([
    { query: 'Zoë' },
    { council: 'N' },
    { cantonId: '7' },
    { partyId: '8' },
    { groupId: '9' },
  ] as const)('explains a zero-hit committee search narrowed only by %o', async (filter) => {
    serveRosters({ '12': [] });
    const result = await runToolContract(searchMembersTool, { committeeId: '12', ...filter });
    expect(result.structuredContent).toMatchObject({
      members: [],
      committeeFound: true,
      notice: expect.stringContaining('No current members of this committee matched these filters'),
    });
    expect((result.structuredContent as { notice: string }).notice).not.toContain(
      'has no published members',
    );
  });

  it('reports an unknown committee as committeeFound false with discovery guidance', async () => {
    serveRosters({}, []);
    const result = await runToolContract(searchMembersTool, { committeeId: '999999' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      members: [],
      committeeFound: false,
      guidance:
        'No committee matched this committeeId. Use chparl_list_reference with topic committees to discover a valid committeeId.',
      returnedCount: 0,
      totalCount: 0,
      hasMore: false,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(textContent(result)).not.toContain('member not found');
    expect(requestedPaths()).toEqual(['/odata.svc/MemberCommittee', '/odata.svc/Committee']);
    expectMemberParity(result);
  });

  it('joins the empty-roster notice to the clamp notice without suggesting membership all', async () => {
    serveRosters({}, ['13']);
    const result = await runToolContract(searchMembersTool, { committeeId: '13', limit: 10_000 });
    expect(result.structuredContent).toMatchObject({
      members: [],
      committeeFound: true,
      effectiveLimit: 100,
      totalCount: 0,
    });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice.startsWith('Requested limit 10000 was clamped to 100. ')).toBe(true);
    expect(notice).toContain('This committee exists but has no published members');
    expect(notice).toContain('Pass asOf');
    expect(notice).not.toContain('membership');
    expect(result.structuredContent).not.toHaveProperty('guidance');
    expectMemberParity(result);
  });

  it.each([
    [{ committeeId: '12', membership: 'former' }, 'membership current only'],
    [{ committeeId: '12', membership: 'all' }, 'membership current only'],
    [{ committeeId: '12', asOf: '2014-03-03', membership: 'all' }, 'membership current only'],
    [{ asOf: '2014-03-03' }, 'asOf needs committeeId'],
    [{ asOf: '2014-03-03', membership: 'former' }, 'asOf needs committeeId'],
    [{ interest: 'Groupe Mutuel', committeeId: '12' }, 'interest cannot be combined'],
    [{ interest: 'Groupe Mutuel', asOf: '2014-03-03' }, 'interest cannot be combined'],
    [
      { interest: 'Groupe Mutuel', committeeId: '12', asOf: '2014-03-03', membership: 'all' },
      'interest cannot be combined',
    ],
  ] as const)('rejects %o as incompatible_fields before any request', async (input, message) => {
    const result = await runToolContract(searchMembersTool, input);
    expect(JsonRpcErrorCode.ValidationError).toBe(-32007);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(message),
        data: {
          reason: 'incompatible_fields',
          recovery: {
            hint: expect.stringContaining('Committee rosters take membership current only'),
          },
        },
      },
    });
    expect(textContent(result)).toContain('incompatible_fields');
    expect(textContent(result)).toContain(message);
    expect(textContent(result)).toContain('Committee rosters take membership current only');
    expect(http.calls).toHaveLength(0);
  });

  it('fails a roster row without its MemberCouncil expansion as a serialization error', async () => {
    serveRosters({ '12': [rosterRow({ MembersCouncil: undefined })] });
    const result = await runToolContract(searchMembersTool, { committeeId: '12' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(requestedPaths()).toEqual(['/odata.svc/MemberCommittee']);
  });
});

describe('chparl_search_members committee rosters on a past day', () => {
  afterEach(() => vi.useRealTimers());

  const onDay = (day: string) =>
    `Language eq 'DE' and (CommitteeNumber eq 12 and DateJoining le datetime'${day}T23:59:59.999' and (DateLeaving ge datetime'${day}T00:00:00' or DateLeaving eq null))`;

  it('carries each membership as recorded on asOf, with its committee dates, on both surfaces', async () => {
    serveHistory(historyRoster(25));
    const result = await runToolContract(searchMembersTool, {
      committeeId: '12',
      asOf: '2014-03-03',
      limit: 2,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      committeeFound: true,
      members: [
        {
          memberCouncilId: '5100',
          personNumber: '5100',
          sourceUrl:
            "https://ws.parlament.ch/odata.svc/MemberCommitteeHistory(ID=guid'00000000-0000-4000-8000-000000004100',Language='DE')",
          officialName: "Zoë D'Essai",
          councilId: '1',
          partyId: '14',
          groupId: '3',
          groupAbbreviation: 'Fraktion CE',
          committeeFunctionId: 1,
          committeeFunctionName: 'Mitglied',
          committeeJoinedDate: '2011-12-15T00:00:00.000',
          committeeLeftDate: '2014-03-09T00:00:00.000',
        },
        { memberCouncilId: '5101' },
      ],
      effectiveFilters: { committeeId: '12', asOf: '2014-03-03', membership: 'current' },
      returnedCount: 2,
      totalCount: 25,
      nextOffset: 2,
      hasMore: true,
    });
    const output = searchMembersTool.output.parse(result.structuredContent);
    for (const field of ['active', 'joinedDate', 'leftDate'])
      expect(output.members[0]).not.toHaveProperty(field);
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(http.calls.map((call) => new URL(call.request.url).searchParams.get('$filter'))).toEqual(
      [onDay('2014-03-03')],
    );
    expectMemberParity(result);
  });

  it.each(['2014-03-03', ' 2014-03-03T00:00:00.000 ', '2014-03-03T23:59:59.999+01:00'])(
    'reads asOf %s as its day and echoes the day',
    async (asOf) => {
      serveHistory(historyRoster(1));
      const result = await runToolContract(searchMembersTool, { committeeId: '12', asOf });
      expect(result.structuredContent).toMatchObject({
        effectiveFilters: { asOf: '2014-03-03' },
        returnedCount: 1,
      });
      expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
        onDay('2014-03-03'),
      );
      expectMemberParity(result);
    },
  );

  it.each([
    ['2026-11-19T12:00:00Z', '2026-11-20', true],
    ['2026-11-19T22:59:59Z', '2026-11-20', true],
    ['2026-11-19T23:00:00Z', '2026-11-20', false],
    ['2026-11-19T12:00:00Z', '2026-11-19T12:00:00.000', false],
    ['2026-11-19T12:00:00Z', '2027-01-01', true],
  ] as const)(
    'at %s judges asOf %s against today in Switzerland (future: %s)',
    async (now, asOf, future) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      serveHistory(historyRoster(1));
      const result = await runToolContract(searchMembersTool, { committeeId: '12', asOf });
      if (!future) {
        expect(result.isError).not.toBe(true);
        expect(requestedPaths()).toEqual(['/odata.svc/MemberCommitteeHistory']);
        return;
      }
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'as_of_in_future',
            recovery: { hint: expect.stringContaining('today or an earlier day') },
          },
        },
      });
      expect(textContent(result)).toContain('as_of_in_future');
      expect(http.calls).toHaveLength(0);
    },
  );

  it('returns an empty roster before the committee’s published history with the coverage notice', async () => {
    serveHistory([]);
    const result = await runToolContract(searchMembersTool, {
      committeeId: '12',
      asOf: '1995-12-03',
    });
    expect(result.structuredContent).toMatchObject({
      members: [],
      committeeFound: true,
      totalCount: 0,
      hasMore: false,
      effectiveFilters: { asOf: '1995-12-03' },
      notice: expect.stringContaining('1995-12-04 for standing committees'),
    });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toContain('No membership of this committee is published for 1995-12-03');
    expect(notice).not.toContain('membership all');
    expect(result.structuredContent).not.toHaveProperty('guidance');
    expect(requestedPaths()).toEqual(['/odata.svc/MemberCommitteeHistory', '/odata.svc/Committee']);
    expectMemberParity(result);
  });

  it('explains a narrowed miss on asOf without the coverage notice', async () => {
    serveHistory([]);
    const result = await runToolContract(searchMembersTool, {
      committeeId: '12',
      asOf: '2014-03-03',
      council: 'S',
    });
    expect(result.structuredContent).toMatchObject({
      members: [],
      committeeFound: true,
      notice: expect.stringContaining(
        'No members of this committee on 2014-03-03 matched these filters',
      ),
    });
    expect((result.structuredContent as { notice: string }).notice).not.toContain('1995-12-04');
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
      onDay('2014-03-03').replace(/\)$/, ' and Council eq 2)'),
    );
    expectMemberParity(result);
  });

  it('reports an unknown committee on asOf as committeeFound false with guidance only', async () => {
    serveHistory([], []);
    const result = await runToolContract(searchMembersTool, {
      committeeId: '999999',
      asOf: '2014-03-03',
    });
    expect(result.structuredContent).toMatchObject({
      members: [],
      committeeFound: false,
      guidance:
        'No committee matched this committeeId. Use chparl_list_reference with topic committees to discover a valid committeeId.',
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expectMemberParity(result);
  });

  it('walks a past roster in limit 10 pages once each and reports the past-end offset', async () => {
    const rows = historyRoster(25);
    serveHistory(rows);
    const delivered: string[] = [];
    for (const [offset, size, nextOffset] of [
      [0, 10, 10],
      [10, 10, 20],
      [20, 5, undefined],
    ] as const) {
      const result = await runToolContract(searchMembersTool, {
        committeeId: '12',
        asOf: '2014-03-03',
        limit: 10,
        offset,
      });
      const output = searchMembersTool.output.parse(result.structuredContent);
      expect(output.members).toHaveLength(size);
      expect((result.structuredContent as { nextOffset?: number }).nextOffset).toBe(nextOffset);
      delivered.push(...output.members.map((row) => row.sourceUrl));
    }
    expect(delivered).toHaveLength(25);
    expect(new Set(delivered).size).toBe(25);
    const past = await runToolContract(searchMembersTool, {
      committeeId: '12',
      asOf: '2014-03-03',
      offset: 25,
    });
    expect(past.structuredContent).toMatchObject({
      members: [],
      committeeFound: true,
      notice: expect.stringContaining('past the last matching member record'),
    });
    expect(new Set(requestedPaths())).toEqual(new Set(['/odata.svc/MemberCommitteeHistory']));
  });
});

describe('chparl_search_members declared-interest searches', () => {
  it('returns one declaration per row with the declarant’s record on both surfaces', async () => {
    serveInterests(declarations(25));
    const result = await runToolContract(searchMembersTool, {
      interest: '  groupe MUTUEL ',
      council: 'S',
      limit: 2,
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      members: [
        {
          memberCouncilId: '6000',
          personNumber: '6000',
          sourceUrl: "https://ws.parlament.ch/odata.svc/MemberCouncil(ID=6000,Language='DE')",
          active: true,
          interest: {
            id: memberGuid(7000),
            interestName: 'Groupe de réflexion Groupe Mutuel 0',
            paid: false,
            dateFrom: '2023-02-15T00:00:00.000',
            sourceUrl:
              "https://ws.parlament.ch/odata.svc/PersonInterest(ID=guid'00000000-0000-4000-8000-000000007000',Language='DE')",
          },
        },
        { memberCouncilId: '6000', interest: { id: memberGuid(7001), sortOrder: 1 } },
      ],
      effectiveFilters: { interest: 'groupe MUTUEL', council: 'S', membership: 'current' },
      returnedCount: 2,
      totalCount: 25,
      nextOffset: 2,
      hasMore: true,
    });
    expect(result.structuredContent).not.toHaveProperty('committeeFound');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (substringof('groupe MUTUEL',InterestName) and Persons/MembersCouncil/Active eq true and Persons/MembersCouncil/Council eq 2)",
    );
    expect(textContent(result)).toContain(
      '**members\\[0\\].interest.interestName:** Groupe de réflexion Groupe Mutuel 0',
    );
    expect(textContent(result)).toContain(
      '**members\\[0\\].interest.dateFrom:** 2023-02-15T00:00:00.000',
    );
    expectMemberParity(result);
  });

  it('walks 25 declarations in limit 10 pages once each and reports the past-end offset', async () => {
    const rows = declarations(25);
    serveInterests(rows);
    const delivered: (string | undefined)[] = [];
    for (const [offset, size, nextOffset] of [
      [0, 10, 10],
      [10, 10, 20],
      [20, 5, undefined],
    ] as const) {
      const result = await runToolContract(searchMembersTool, {
        interest: 'Groupe Mutuel',
        membership: 'all',
        limit: 10,
        offset,
      });
      const output = searchMembersTool.output.parse(result.structuredContent);
      expect(output.members).toHaveLength(size);
      expect(result.structuredContent).toMatchObject({ totalCount: 25 });
      expect((result.structuredContent as { nextOffset?: number }).nextOffset).toBe(nextOffset);
      delivered.push(...output.members.map((row) => row.interest?.id));
    }
    expect(delivered).toEqual(rows.map((row) => row.ID));
    const past = await runToolContract(searchMembersTool, {
      interest: 'Groupe Mutuel',
      membership: 'all',
      offset: 25,
    });
    expect(past.structuredContent).toMatchObject({
      members: [],
      totalCount: 25,
      notice: expect.stringContaining('past the last matching member record'),
    });
  });

  it('explains a zero-hit interest search without claiming that no member has the tie', async () => {
    serveInterests([]);
    const result = await runToolContract(searchMembersTool, { interest: 'Groupe Mutuel' });
    expect(result.structuredContent).toMatchObject({ members: [], totalCount: 0, hasMore: false });
    const { notice } = result.structuredContent as { notice: string };
    expect(notice).toContain('No declared interest matched');
    expect(notice).toContain('as declared in another language');
    expect(notice).toContain('membership all');
    expect(notice).toContain('does not establish that no member has a tie');
    expect(notice).not.toContain('No member records matched');
    expect(requestedPaths()).toEqual(['/odata.svc/PersonInterest']);
    expectMemberParity(result);
  });

  it('sends a 255-character interest with every other filter at maximum identifier width', async () => {
    serveInterests([]);
    const result = await runToolContract(searchMembersTool, {
      interest: 'a'.repeat(255),
      membership: 'all',
      council: 'S',
      cantonId: '2147483647',
      partyId: '2147483647',
      groupId: '2147483647',
      language: 'fr',
    });
    expect(result.isError).not.toBe(true);
    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]?.request.url ?? '').search.length - 1).toBeLessThanOrEqual(2048);
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
  {
    section: 'committee_history',
    field: 'committeeHistory',
    entity: 'MemberCommitteeHistory',
    row: committeeHistoryRow,
  },
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

  it.each(['overview', 'council_terms', 'committees', 'committee_history', 'interests'] as const)(
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
        'committeeHistory',
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
    'returns a full 100-row $section page of large rows unchanged, then the short last page and the past-end offset',
    async ({ section, field, row }) => {
      const original = `<p>${'原'.repeat(250)}\r\n\t</p>`;
      const rows = Array.from({ length: 150 }, (_, index) =>
        row({
          ID: memberGuid(index + 1),
          OfficialName: `${original}${index}`,
          CommitteeName: `${original}${index}`,
          InterestName: `${original}${index}`,
        }),
      );
      serveRows(rows);
      const delivered: string[] = [];
      for (const [offset, size, nextOffset] of [
        [0, 100, 100],
        [100, 50, undefined],
      ] as const) {
        const result = await runToolContract(getMemberTool, {
          personNumber: '91',
          section,
          limit: 100,
          offset,
        });
        expect(result.isError).not.toBe(true);
        const records: { id: string }[] =
          getMemberTool.output.parse(result.structuredContent)[field] ?? [];
        expect(records).toHaveLength(size);
        expect(result.structuredContent).toMatchObject({
          returnedCount: size,
          effectiveLimit: 100,
          totalCount: 150,
          hasMore: nextOffset !== undefined,
          ...(nextOffset !== undefined && { nextOffset }),
        });
        if (nextOffset === undefined)
          expect(result.structuredContent).not.toHaveProperty('nextOffset');
        expect(result.structuredContent).not.toHaveProperty('notice');
        expect(resultBytes(result)).toBeGreaterThan(24_000);
        expect(decodeParliamentMarkdown(textContent(result)).strings).toContain(
          `${original}${offset + size - 1}`,
        );
        expectMemberParity(result);
        delivered.push(...records.map((record) => record.id));
      }
      expect(delivered).toEqual(rows.map((source) => source.ID));
      const past = await runToolContract(getMemberTool, {
        personNumber: '91',
        section,
        limit: 100,
        offset: 150,
      });
      expect(past.structuredContent).toMatchObject({
        [field]: [],
        returnedCount: 0,
        totalCount: 150,
        hasMore: false,
        notice: expect.stringContaining('past this profile section'),
      });
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
    expect(output.interests?.[0]).toMatchObject({
      interestName: original,
      paid: false,
      dateFrom: '2023-02-15T00:00:00.000',
    });
    expect(textContent(result)).toContain('**interests\\[0\\].dateFrom:** 2023-02-15T00:00:00.000');
    expect(output.interests?.[1]).toHaveProperty('interestName', '');
    expect(output.interests?.[1]).not.toHaveProperty('paid');
    expect(output.interests?.[1]).not.toHaveProperty('dateFrom');
    expect(output.interests?.[2]).not.toHaveProperty('paid');
    expectMemberParity(result);
  });

  it('returns committee_history oldest first, a row naming no committee included, on both surfaces', async () => {
    serveRows([
      {
        ID: memberGuid(6),
        PersonNumber: 91,
        Language: 'DE',
        CommitteeNumber: null,
        CommitteeName: null,
        CommitteeFunction: null,
        DateJoining: null,
        DateLeaving: null,
        Council: 1,
        CouncilName: 'Nationalrat',
        CouncilAbbreviation: 'NR',
      },
      committeeHistoryRow(),
      committeeHistoryRow({
        ID: memberGuid(7),
        DateJoining: '/Date(1701648000000)/',
        DateLeaving: null,
      }),
    ]);
    const result = await runToolContract(getMemberTool, {
      personNumber: '91',
      section: 'committee_history',
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: true,
      section: 'committee_history',
      committeeHistory: [
        {
          id: memberGuid(6),
          councilId: '1',
          sourceUrl:
            "https://ws.parlament.ch/odata.svc/MemberCommitteeHistory(ID=guid'00000000-0000-4000-8000-000000000006',Language='DE')",
        },
        {
          id: memberGuid(5),
          committeeId: '10',
          abbreviation: 'CH-NR',
          abbreviation1: 'CH-N',
          functionId: 0,
          functionName: 'Mitglied',
          joinedDate: '2011-12-15T00:00:00.000',
          leftDate: '2015-11-29T00:00:00.000',
        },
        { id: memberGuid(7), committeeId: '10', joinedDate: '2023-12-04T00:00:00.000' },
      ],
      returnedCount: 3,
      totalCount: 3,
      hasMore: false,
    });
    const rows = getMemberTool.output.parse(result.structuredContent).committeeHistory;
    for (const field of ['committeeId', 'committeeName', 'functionId', 'joinedDate', 'leftDate'])
      expect(rows?.[0]).not.toHaveProperty(field);
    expect(rows?.[2]).not.toHaveProperty('leftDate');
    expect(result.structuredContent).not.toHaveProperty('committees');
    expect(textContent(result)).toContain(
      '**committeeHistory\\[1\\].leftDate:** 2015-11-29T00:00:00.000',
    );
    expectMemberParity(result);
  });

  it('returns an interest over 24000 bytes whole on a limit 1 page with no size notice', async () => {
    const name = `<p>${'é'.repeat(15_000)}</p>`;
    serveRows([interestRow({ InterestName: name }), interestRow({ ID: memberGuid(3) })]);
    const result = await runToolContract(getMemberTool, {
      personNumber: '91',
      section: 'interests',
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      interests: [{ interestName: name }],
      returnedCount: 1,
      nextOffset: 1,
      hasMore: true,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(resultBytes(result)).toBeGreaterThan(24_000);
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
              hint: 'Select council_terms, committees, committee_history, or interests in chparl_get_member before supplying pagination.',
            },
          },
        },
      });
      expect(textContent(result)).toContain('incompatible_fields');
      expect(textContent(result)).toContain(
        'council_terms, committees, committee_history, or interests',
      );
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
    { tool: searchMembersTool, input: { committeeId: 'abc' } },
    { tool: searchMembersTool, input: { committeeId: '0' } },
    { tool: searchMembersTool, input: { committeeId: '12', asOf: '2014-02-30' } },
    { tool: searchMembersTool, input: { committeeId: '12', asOf: '03.03.2014' } },
    { tool: searchMembersTool, input: { committeeId: '12', asOf: '2014-03-03T00:00:00Z' } },
    { tool: searchMembersTool, input: { committeeId: '12', asOf: '2014-03-03T24:00:00.000' } },
    { tool: searchMembersTool, input: { committeeId: '12', asOf: `2014-03-03${' '.repeat(40)}x` } },
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

  it.each([
    { query: 'é'.repeat(400) },
    { committeeId: '12', query: 'é'.repeat(400) },
    { committeeId: '12', asOf: '2014-03-03', query: 'é'.repeat(400) },
    { interest: 'é'.repeat(255) },
    { interest: 'Groupe Mutuel', query: 'é'.repeat(100) },
  ])(
    'refuses over-long text filters as request_too_long before any request (%o)',
    async (input) => {
      http.reset();
      http.route({
        match: () => true,
        respond: (request) =>
          new URL(request.url).search.length - 1 > 2048
            ? new Response('<html><body>404 - File or directory not found.</body></html>', {
                status: 404,
                headers: { 'Content-Type': 'text/html' },
              })
            : Response.json({ d: [] }),
      });
      const result = await runToolContract(searchMembersTool, input);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'request_too_long',
            recovery: {
              hint: 'Shorten query or interest and retry this tool; the request carries query three times, once each for first, last, and official name.',
            },
          },
        },
      });
      expect(textContent(result)).toContain('request_too_long');
      expect(textContent(result)).toContain(
        'Shorten query or interest and retry this tool; the request carries query three times, once each for first, last, and official name.',
      );
      expect(http.calls).toHaveLength(0);
    },
  );

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
