/**
 * @fileoverview Member source queries, field mapping, uncertainty, and multi-page enumeration.
 * @module tests/services/parliament/member-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemberSearchFilters } from '@/services/parliament/member-model.js';
import { MemberService } from '@/services/parliament/member-service.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import {
  committeeRow,
  interestRow,
  memberGuid,
  memberRow,
  personRow,
  rosterRow,
} from '../../helpers/member-fixtures.js';
import { parliamentHttp } from '../../helpers/parliament.js';

let http: ReturnType<typeof parliamentHttp> | undefined;
afterEach(() => http?.restore());

function search(options: Partial<MemberSearchFilters> = {}) {
  return withWorkflow(createMockContext(), (workflow) =>
    new MemberService().searchMembers(
      { language: 'de', membership: 'current', limit: 20, offset: 0, ...options },
      workflow,
    ),
  );
}

describe('MemberService', () => {
  it.each([
    ['current', "Language eq 'DE' and (Active eq true)"],
    ['former', "Language eq 'DE' and (Active eq false)"],
    ['all', "Language eq 'DE'"],
  ] as const)('uses the %s membership predicate upstream', async (membership, expected) => {
    http = parliamentHttp(() => Response.json({ d: [] }));
    await search({ membership });
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.pathname).toBe('/odata.svc/MemberCouncil');
    expect(url.searchParams.get('$filter')).toBe(expected);
    expect(url.searchParams.get('$orderby')).toBe('LastName asc,FirstName asc,ID asc');
    expect(url.searchParams.get('$inlinecount')).toBe('allpages');
    expect(url.searchParams.get('$top')).toBe('20');
    expect(url.searchParams.get('$skip')).toBe('0');
  });

  it('conjoins every filter and escapes apostrophes before URL encoding', async () => {
    http = parliamentHttp(() => Response.json({ d: [] }));
    await search({
      language: 'fr',
      membership: 'former',
      query: "D'Essai & Étoile",
      council: 'S',
      cantonId: '7',
      partyId: '8',
      groupId: '9',
      limit: 3,
      offset: 4,
    });
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.searchParams.get('$filter')).toBe(
      "Language eq 'FR' and (Active eq false and (substringof('D''Essai & Étoile',FirstName) or substringof('D''Essai & Étoile',LastName) or substringof('D''Essai & Étoile',OfficialName)) and Council eq 2 and Canton eq 7 and Party eq 8 and ParlGroupNumber eq 9)",
    );
    expect(url.searchParams.get('$skip')).toBe('4');
    expect(url.searchParams.get('$top')).toBe('3');
    expect(url.searchParams.get('$select')?.split(',')).toEqual([
      'ID',
      'Language',
      'PersonNumber',
      'FirstName',
      'LastName',
      'OfficialName',
      'Active',
      'Council',
      'CouncilName',
      'CouncilAbbreviation',
      'Canton',
      'CantonName',
      'CantonAbbreviation',
      'Party',
      'PartyName',
      'PartyAbbreviation',
      'ParlGroupNumber',
      'ParlGroupName',
      'ParlGroupAbbreviation',
      'DateJoining',
      'DateLeaving',
    ]);
  });

  it('maps every affiliation field without deduplicating records for one person', async () => {
    http = parliamentHttp(() => Response.json({ d: [memberRow(), memberRow({ ID: 802 })] }));
    const page = await search();
    expect(page.items).toEqual(
      [801, 802].map((id) => ({
        memberCouncilId: String(id),
        personNumber: '91',
        metadataLanguage: 'de',
        sourceUrl: `https://ws.parlament.ch/odata.svc/MemberCouncil(ID=${id},Language='DE')`,
        firstName: 'Zoë',
        lastName: "D'Essai",
        officialName: "Zoë D'Essai",
        active: false,
        councilId: '2',
        councilName: 'Conseil des États',
        councilAbbreviation: 'S',
        cantonId: '7',
        cantonName: 'Canton synthétique',
        cantonAbbreviation: 'SY',
        partyId: '8',
        partyName: 'Parti synthétique',
        partyAbbreviation: 'PSYN',
        groupId: '9',
        groupName: 'Groupe synthétique',
        groupAbbreviation: 'GSYN',
        joinedDate: '1970-01-01T01:00:00.000+01:00',
        leftDate: '1970-01-02T00:00:00.000',
      })),
    );
  });

  it('retains explicit empty and false values while omitting sparse null fields', async () => {
    http = parliamentHttp(() =>
      Response.json({
        d: [
          {
            ID: 801,
            Language: 'DE',
            PersonNumber: 91,
            FirstName: '',
            LastName: null,
            Active: false,
            Council: null,
            PartyName: null,
            DateLeaving: null,
            PrivateEmail: 'fixture@example.test',
          },
        ],
      }),
    );
    expect((await search()).items).toEqual([
      {
        memberCouncilId: '801',
        personNumber: '91',
        metadataLanguage: 'de',
        firstName: '',
        active: false,
        sourceUrl: "https://ws.parlament.ch/odata.svc/MemberCouncil(ID=801,Language='DE')",
      },
    ]);
  });

  it('resolves PersonNumber through the collection and preserves a different Person.ID', async () => {
    http = parliamentHttp(() =>
      Response.json({ d: [personRow({ Email: 'private@example.test' })] }),
    );
    const result = await withWorkflow(createMockContext(), (workflow) =>
      new MemberService().getPerson('91', 'de', workflow),
    );
    expect(result).toEqual({
      id: '901',
      personNumber: '91',
      metadataLanguage: 'de',
      firstName: 'Zoë',
      lastName: "D'Essai",
      officialName: "Zoë D'Essai",
      nativeLanguage: 'FR',
      sourceUrl: "https://ws.parlament.ch/odata.svc/Person(ID=901,Language='DE')",
    });
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.pathname).toBe('/odata.svc/Person');
    expect(url.searchParams.get('$filter')).toBe("Language eq 'DE' and (PersonNumber eq 91)");
    expect(url.searchParams.get('$select')).toBe(
      'ID,PersonNumber,Language,FirstName,LastName,OfficialName,NativeLanguage',
    );
    expect(url.searchParams.get('$top')).toBe('2');
  });

  it('rejects duplicate Person records rather than choosing an arbitrary identity', async () => {
    http = parliamentHttp(() =>
      Response.json({ d: { results: [personRow(), personRow({ ID: 902 })], __count: '2' } }),
    );
    await expect(
      withWorkflow(createMockContext(), (workflow) =>
        new MemberService().getPerson('91', 'de', workflow),
      ),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
    expect(http.calls).toHaveLength(1);
  });

  it('drains overview beyond both a 1000-record service page and a nested source continuation', async () => {
    http = parliamentHttp((request) => {
      const url = new URL(request.url);
      const skip = Number(url.searchParams.get('$skip'));
      const token = url.searchParams.get('$skiptoken');
      if (skip === 0)
        return Response.json({
          d: {
            results: Array.from({ length: 1000 }, (_, index) => ({
              ID: index + 1,
              Language: 'DE',
              PersonNumber: 91,
            })),
            __count: '1002',
          },
        });
      if (skip === 1000 && token === null) {
        const next = new URL(url);
        next.searchParams.set('$skiptoken', 'opaque+/% second page');
        return Response.json({
          d: {
            results: [{ ID: 1001, Language: 'DE', PersonNumber: 91 }],
            __count: '1002',
            __next: next.href,
          },
        });
      }
      expect(token).toBe('opaque+/% second page');
      return Response.json({
        d: { results: [{ ID: 1002, Language: 'DE', PersonNumber: 91 }], __count: '1002' },
      });
    });
    const result = await withWorkflow(createMockContext(), async (workflow) => ({
      rows: await new MemberService().memberships('91', 'de', workflow),
      sources: workflow.sources,
    }));
    expect(result.rows).toHaveLength(1002);
    expect(result.rows.at(-1)).toMatchObject({ memberCouncilId: '1002', personNumber: '91' });
    expect(http.calls.map((call) => new URL(call.request.url).searchParams.get('$skip'))).toEqual([
      '0',
      '1000',
      '1000',
    ]);
    expect(result.sources.map((source) => source.url)).toEqual(
      http.calls.map((call) => call.request.url),
    );
    for (const call of http.calls)
      expect(new URL(call.request.url).searchParams.get('$filter')).toBe(
        "Language eq 'DE' and (PersonNumber eq 91)",
      );
  });

  it('preserves council-history GUID keys, predecessor, dates and source link', async () => {
    http = parliamentHttp(() =>
      Response.json({ d: [memberRow({ ID: memberGuid(3), IdPredecessor: memberGuid(4) })] }),
    );
    const page = await withWorkflow(createMockContext(), (workflow) =>
      new MemberService().councilTerms('91', 'de', { limit: 2, offset: 4 }, workflow),
    );
    expect(page.items[0]).toMatchObject({
      id: memberGuid(3),
      predecessorId: memberGuid(4),
      personNumber: '91',
      joinedDate: '1970-01-01T01:00:00.000+01:00',
      leftDate: '1970-01-02T00:00:00.000',
      sourceUrl:
        "https://ws.parlament.ch/odata.svc/MemberCouncilHistory(ID=guid'00000000-0000-4000-8000-000000000003',Language='DE')",
    });
    expect(page.items[0]).not.toHaveProperty('memberCouncilId');
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.searchParams.get('$orderby')).toBe('DateJoining asc,ID asc');
    expect(url.searchParams.get('$select')).toContain('ID,IdPredecessor,Language,PersonNumber');
    expect(url.searchParams.get('$skip')).toBe('4');
  });

  it('maps every published committee field and preserves zero codes and empty abbreviations', async () => {
    http = parliamentHttp(() => Response.json({ d: [committeeRow()] }));
    const page = await withWorkflow(createMockContext(), (workflow) =>
      new MemberService().committees('91', 'de', { limit: 20, offset: 0 }, workflow),
    );
    expect(page.items).toEqual([
      {
        id: memberGuid(1),
        committeeId: '11',
        committeeName: 'Commission synthétique',
        abbreviation: 'CS',
        abbreviation1: 'CS1',
        abbreviation2: '',
        committeeTypeId: '12',
        committeeTypeName: 'Type synthétique',
        committeeTypeAbbreviation: 'TS',
        councilId: '2',
        councilName: 'Conseil des États',
        councilAbbreviation: 'S',
        functionId: 0,
        functionName: 'Membre',
        sourceUrl:
          "https://ws.parlament.ch/odata.svc/MemberCommittee(ID=guid'00000000-0000-4000-8000-000000000001',Language='DE')",
      },
    ]);
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.searchParams.get('$orderby')).toBe('CommitteeNumber asc,ID asc');
    expect(url.searchParams.get('$select')).toBe(
      'ID,Language,PersonNumber,CommitteeNumber,CommitteeName,Abbreviation,Abbreviation1,Abbreviation2,CommitteeType,CommitteeTypeName,CommitteeTypeAbbreviation,Council,CouncilName,CouncilAbbreviation,CommitteeFunction,CommitteeFunctionName',
    );
  });

  it('maps every interest field and distinguishes Paid false, null, absent and true', async () => {
    http = parliamentHttp(() =>
      Response.json({
        d: [
          interestRow(),
          { ID: memberGuid(3), PersonNumber: 91, Language: 'DE', Paid: null },
          { ID: memberGuid(4), PersonNumber: 91, Language: 'DE' },
          interestRow({ ID: memberGuid(5), Paid: true }),
        ],
      }),
    );
    const page = await withWorkflow(createMockContext(), (workflow) =>
      new MemberService().interests('91', 'de', { limit: 20, offset: 0 }, workflow),
    );
    expect(page.items[0]).toEqual({
      id: memberGuid(2),
      interestName: 'Association synthétique',
      agency: '',
      interestType: 0,
      interestTypeText: 'Intérêt synthétique',
      organizationType: 2,
      organizationTypeText: 'Association',
      functionInAgency: 3,
      functionInAgencyText: 'Membre',
      paid: false,
      sortOrder: 0,
      modifiedAt: '1969-12-31T22:30:00.000-01:30',
      sourceUrl:
        "https://ws.parlament.ch/odata.svc/PersonInterest(ID=guid'00000000-0000-4000-8000-000000000002',Language='DE')",
    });
    expect(page.items[1]).not.toHaveProperty('paid');
    expect(page.items[2]).not.toHaveProperty('paid');
    expect(page.items[3]).toHaveProperty('paid', true);
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.searchParams.get('$orderby')).toBe('SortOrder asc,ID asc');
    expect(url.searchParams.get('$select')).toBe(
      'ID,Language,PersonNumber,InterestName,Agency,InterestType,InterestTypeText,OrganizationType,OrganizationTypeText,FunctionInAgency,FunctionInAgencyText,Paid,SortOrder,Modified',
    );
  });

  it.each([
    {
      method: 'councilTerms',
      entity: 'MemberCouncilHistory',
      row: (id: number) => memberRow({ ID: memberGuid(id) }),
    },
    {
      method: 'committees',
      entity: 'MemberCommittee',
      row: (id: number) => committeeRow({ ID: memberGuid(id) }),
    },
    {
      method: 'interests',
      entity: 'PersonInterest',
      row: (id: number) => interestRow({ ID: memberGuid(id) }),
    },
  ] as const)(
    'fills $method across three source pages with the original language and person predicate',
    async ({ method, entity, row }) => {
      http = parliamentHttp((request) => {
        const url = new URL(request.url);
        const token = url.searchParams.get('$skiptoken');
        const index = token === null ? 1 : token === 'opaque+page/2%' ? 2 : 3;
        expect(url.pathname).toBe(`/odata.svc/${entity}`);
        expect(url.searchParams.get('$filter')).toBe("Language eq 'DE' and (PersonNumber eq 91)");
        const next = new URL(url);
        next.searchParams.set('$skiptoken', `opaque+page/${index + 1}%`);
        return Response.json({
          d: {
            results: [row(index)],
            __count: '9',
            ...(index < 3 && { __next: next.href }),
          },
        });
      });
      const result = await withWorkflow(
        createMockContext(),
        async (workflow) =>
          await new MemberService()[method]('91', 'de', { limit: 3, offset: 2 }, workflow),
      );
      expect(result.items.map((item) => item.id)).toEqual([
        memberGuid(1),
        memberGuid(2),
        memberGuid(3),
      ]);
      expect(result).toMatchObject({ totalCount: 9, hasMore: true, nextOffset: 5 });
      expect(http.calls.map((call) => new URL(call.request.url).searchParams.get('$top'))).toEqual([
        '3',
        '2',
        '1',
      ]);
    },
  );

  it.each(['search', 'person', 'memberships', 'councilTerms', 'committees', 'interests'] as const)(
    'rejects an unexpected source metadata language in %s',
    async (operation) => {
      const rows = {
        search: memberRow(),
        person: personRow(),
        memberships: memberRow(),
        councilTerms: memberRow({ ID: memberGuid(3) }),
        committees: committeeRow(),
        interests: interestRow(),
      };
      http = parliamentHttp(() => Response.json({ d: [{ ...rows[operation], Language: 'IT' }] }));
      const service = new MemberService();
      await expect(
        withWorkflow<unknown>(createMockContext(), (workflow) => {
          if (operation === 'search')
            return service.searchMembers(
              { language: 'de', membership: 'all', limit: 20, offset: 0 },
              workflow,
            );
          if (operation === 'person') return service.getPerson('91', 'de', workflow);
          if (operation === 'memberships') return service.memberships('91', 'de', workflow);
          return service[operation]('91', 'de', { limit: 20, offset: 0 }, workflow);
        }),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
      expect(http.calls).toHaveLength(1);
    },
  );
});

describe('MemberService committee rosters', () => {
  const rosterSelect = [
    'ID',
    'Language',
    'CommitteeFunction',
    'CommitteeFunctionName',
    'MembersCouncil/ID',
    'MembersCouncil/Language',
    'MembersCouncil/PersonNumber',
    'MembersCouncil/FirstName',
    'MembersCouncil/LastName',
    'MembersCouncil/OfficialName',
    'MembersCouncil/Active',
    'MembersCouncil/Council',
    'MembersCouncil/CouncilName',
    'MembersCouncil/CouncilAbbreviation',
    'MembersCouncil/Canton',
    'MembersCouncil/CantonName',
    'MembersCouncil/CantonAbbreviation',
    'MembersCouncil/Party',
    'MembersCouncil/PartyName',
    'MembersCouncil/PartyAbbreviation',
    'MembersCouncil/ParlGroupNumber',
    'MembersCouncil/ParlGroupName',
    'MembersCouncil/ParlGroupAbbreviation',
    'MembersCouncil/DateJoining',
    'MembersCouncil/DateLeaving',
  ];

  it('pages MemberCommittee by CommitteeNumber with the singular MembersCouncil expansion and no Active filter', async () => {
    http = parliamentHttp(() => Response.json({ d: { results: [rosterRow()], __count: '4' } }));
    await search({ committeeId: '12', limit: 7, offset: 3 });
    expect(http.calls).toHaveLength(1);
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.pathname).toBe('/odata.svc/MemberCommittee');
    expect(url.searchParams.get('$filter')).toBe("Language eq 'DE' and (CommitteeNumber eq 12)");
    expect(url.searchParams.get('$expand')).toBe('MembersCouncil');
    expect(url.searchParams.get('$select')?.split(',')).toEqual(rosterSelect);
    expect(url.searchParams.get('$orderby')).toBe('LastName asc,FirstName asc,ID asc');
    expect(url.searchParams.get('$inlinecount')).toBe('allpages');
    expect(url.searchParams.get('$top')).toBe('7');
    expect(url.searchParams.get('$skip')).toBe('3');
  });

  it.each([
    [{ cantonId: '12' }, 'MembersCouncil/Canton eq 12'],
    [{ partyId: '20' }, 'MembersCouncil/Party eq 20'],
    [{ groupId: '6' }, 'MembersCouncil/ParlGroupNumber eq 6'],
    [{ council: 'N' }, 'MembersCouncil/Council eq 1'],
    [{ council: 'S' }, 'MembersCouncil/Council eq 2'],
    [
      { query: "D'Essai" },
      "(substringof('D''Essai',MembersCouncil/FirstName) or substringof('D''Essai',MembersCouncil/LastName) or substringof('D''Essai',MembersCouncil/OfficialName))",
    ],
  ] as const)(
    'conjoins %o with the committee through the expanded record',
    async (filter, predicate) => {
      http = parliamentHttp(() => Response.json({ d: { results: [rosterRow()], __count: '1' } }));
      await search({ committeeId: '12', ...filter });
      expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
        `Language eq 'DE' and (CommitteeNumber eq 12 and ${predicate})`,
      );
    },
  );

  it('keeps every narrowing filter in the order the MemberCouncil route uses', async () => {
    http = parliamentHttp(() => Response.json({ d: [] }));
    await search({
      language: 'fr',
      committeeId: '788',
      query: 'Zoë',
      council: 'N',
      cantonId: '7',
      partyId: '8',
      groupId: '9',
    });
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$filter')).toBe(
      "Language eq 'FR' and (CommitteeNumber eq 788 and (substringof('Zoë',MembersCouncil/FirstName) or substringof('Zoë',MembersCouncil/LastName) or substringof('Zoë',MembersCouncil/OfficialName)) and MembersCouncil/Council eq 1 and MembersCouncil/Canton eq 7 and MembersCouncil/Party eq 8 and MembersCouncil/ParlGroupNumber eq 9)",
    );
  });

  it('maps each membership to the expanded MemberCouncil record plus its committee function', async () => {
    http = parliamentHttp(() =>
      Response.json({
        d: {
          results: [
            rosterRow(
              { CommitteeFunction: 2, CommitteeFunctionName: 'Präsident/in' },
              { DateLeaving: '/Date(86400000)/' },
            ),
            rosterRow(
              { ID: memberGuid(2), CommitteeFunction: null, CommitteeFunctionName: '' },
              { ID: 802, PersonNumber: 92, OfficialName: null },
            ),
          ],
          __count: '2',
        },
      }),
    );
    const page = await search({ committeeId: '12' });
    expect(page).toMatchObject({ totalCount: 2, hasMore: false, committeeFound: true });
    expect(page.items).toEqual([
      {
        memberCouncilId: '801',
        personNumber: '91',
        metadataLanguage: 'de',
        sourceUrl: "https://ws.parlament.ch/odata.svc/MemberCouncil(ID=801,Language='DE')",
        firstName: 'Zoë',
        lastName: "D'Essai",
        officialName: "Zoë D'Essai",
        active: true,
        councilId: '1',
        councilName: 'Conseil des États',
        councilAbbreviation: 'S',
        cantonId: '7',
        cantonName: 'Canton synthétique',
        cantonAbbreviation: 'SY',
        partyId: '8',
        partyName: 'Parti synthétique',
        partyAbbreviation: 'PSYN',
        groupId: '9',
        groupName: 'Groupe synthétique',
        groupAbbreviation: 'GSYN',
        joinedDate: '1970-01-01T01:00:00.000+01:00',
        leftDate: '1970-01-02T00:00:00.000',
        committeeFunctionId: 2,
        committeeFunctionName: 'Präsident/in',
      },
      expect.objectContaining({
        memberCouncilId: '802',
        personNumber: '92',
        committeeFunctionName: '',
      }),
    ]);
    expect(page.items[1]).not.toHaveProperty('committeeFunctionId');
    expect(page.items[1]).not.toHaveProperty('officialName');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    ['a missing expansion', rosterRow({ MembersCouncil: undefined })],
    [
      'a deferred expansion',
      rosterRow({ MembersCouncil: { __deferred: { uri: 'https://ws.parlament.ch/odata.svc/x' } } }),
    ],
    ['a null expansion', rosterRow({ MembersCouncil: null })],
    ['an other-language expansion', rosterRow({}, { Language: 'FR' })],
    ['an other-language membership', rosterRow({ Language: 'IT' })],
  ])('fails %s as a serialization error without a Committee read', async (_label, row) => {
    http = parliamentHttp(() => Response.json({ d: { results: [row], __count: '1' } }));
    await expect(search({ committeeId: '12' })).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    expect(http.calls.map((call) => new URL(call.request.url).pathname)).toEqual([
      '/odata.svc/MemberCommittee',
    ]);
  });

  it.each([
    ['an existing committee without published members', [{ ID: 13 }], true],
    ['an unknown committee', [], false],
  ] as const)(
    'reads Committee by CommitteeNumber once for %s',
    async (_label, committees, found) => {
      http = parliamentHttp((request) => {
        const url = new URL(request.url);
        return Response.json(
          url.pathname === '/odata.svc/Committee'
            ? { d: committees }
            : { d: { results: [], __count: '0' } },
        );
      });
      const page = await search({ committeeId: '13' });
      expect(page).toMatchObject({
        items: [],
        totalCount: 0,
        hasMore: false,
        committeeFound: found,
      });
      expect(http.calls).toHaveLength(2);
      const url = new URL(http.calls[1]?.request.url ?? '');
      expect(url.pathname).toBe('/odata.svc/Committee');
      expect(url.searchParams.get('$filter')).toBe("Language eq 'DE' and (CommitteeNumber eq 13)");
      expect(url.searchParams.get('$select')).toBe('ID');
      expect(url.searchParams.get('$top')).toBe('1');
      expect(url.searchParams.has('$inlinecount')).toBe(false);
    },
  );

  it('reads Committee when the roster is empty and upstream supplied no count', async () => {
    http = parliamentHttp(() => Response.json({ d: [] }));
    const page = await search({ committeeId: '13' });
    expect(page).toMatchObject({ items: [], committeeFound: false });
    expect(page).not.toHaveProperty('totalCount');
    expect(http.calls.map((call) => new URL(call.request.url).pathname)).toEqual([
      '/odata.svc/MemberCommittee',
      '/odata.svc/Committee',
    ]);
  });

  it.each([
    ['HTTP 403', () => new Response('', { status: 403 }), JsonRpcErrorCode.ServiceUnavailable],
    [
      'malformed rows',
      () => Response.json({ d: [{ ID: 'thirteen' }] }),
      JsonRpcErrorCode.SerializationError,
    ],
  ] as const)(
    'fails an empty-roster search instead of guessing committeeFound when the Committee read hits %s',
    async (_label, respond, code) => {
      http = parliamentHttp((request) =>
        new URL(request.url).pathname === '/odata.svc/Committee'
          ? respond()
          : Response.json({ d: { results: [], __count: '0' } }),
      );
      await expect(search({ committeeId: '13' })).rejects.toMatchObject({ code });
    },
  );

  it('makes no Committee request for a page past the end of a non-empty roster', async () => {
    http = parliamentHttp(() => Response.json({ d: { results: [], __count: '25' } }));
    const page = await search({ committeeId: '12', offset: 25 });
    expect(page).toMatchObject({ items: [], totalCount: 25, committeeFound: true });
    expect(http.calls).toHaveLength(1);
  });

  it('fills a roster page across a source continuation that keeps the expansion', async () => {
    http = parliamentHttp((request) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('$expand')).toBe('MembersCouncil');
      if (url.searchParams.get('$skiptoken') === 'roster+2')
        return Response.json({
          d: { results: [rosterRow({ ID: memberGuid(2) }, { ID: 802 })], __count: '3' },
        });
      const next = new URL(url);
      next.searchParams.set('$skiptoken', 'roster+2');
      return Response.json({ d: { results: [rosterRow()], __count: '3', __next: next.href } });
    });
    const page = await search({ committeeId: '12', limit: 2 });
    expect(page.items.map((row) => row.memberCouncilId)).toEqual(['801', '802']);
    expect(page).toMatchObject({
      totalCount: 3,
      hasMore: true,
      nextOffset: 2,
      committeeFound: true,
    });
    expect(http.calls).toHaveLength(2);
  });
});
