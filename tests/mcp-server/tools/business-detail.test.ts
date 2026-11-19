/**
 * @fileoverview Business retrieval sections, text disclosure, and public recovery contracts.
 * @module tests/mcp-server/tools/business-detail.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBusinessTool } from '@/mcp-server/tools/definitions/get-business.tool.js';
import { listBusinessSection } from '@/services/parliament/business-relations.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import { businessRow, businessSummary, expectBusinessParity } from '../../helpers/business.js';
import { parliamentHttp, resultBytes, textContent } from '../../helpers/parliament.js';

let http: ReturnType<typeof parliamentHttp>;
beforeEach(() => {
  http = parliamentHttp(() => {
    throw new Error('Unexpected Parliament request.');
  });
});
afterEach(() => http.restore());

function serveBusiness(row: unknown) {
  http.reset();
  http.route({ match: () => true, respond: () => Response.json({ d: row }) });
}

const guid = '00000000-0000-4000-8000-000000000001';
const modified = '1970-01-01T00:00:01.000';
/** The expanded Subject and Meeting of a SubjectBusiness row, as `$expand=Subjects/Meetings` returns them. */
const subjectMeeting = {
  Language: 'DE',
  Meetings: {
    Language: 'DE',
    Date: '/Date(1576627200000)/',
    CouncilName: 'Ständerat',
    IdSession: 5101,
    SessionName: 'Wintersession 2019',
  },
};
const relationCases = [
  {
    section: 'status_history',
    entity: 'BusinessStatus',
    key: 'statusHistory',
    order: 'BusinessStatusDate asc,ID asc',
    expand: null,
    row: {
      ID: guid,
      BusinessStatusId: 9999,
      BusinessStatusName: '',
      BusinessStatusDate: '/Date(0)/',
      IsMotionInSecondCouncil: false,
      NewKey: 0,
      Modified: '/Date(1000)/',
    },
    expected: {
      id: guid,
      statusId: '9999',
      statusName: '',
      date: '1970-01-01T00:00:00.000',
      isMotionInSecondCouncil: false,
      newKey: 0,
      modifiedAt: modified,
    },
  },
  {
    section: 'bills',
    entity: 'Bill',
    key: 'bills',
    order: 'BillNumber asc,ID asc',
    expand: null,
    row: {
      ID: guid,
      BillNumber: 1,
      BillType: 3,
      BillTypeName: 'Synthetic bill',
      Title: 'Bill [one]',
      BusinessStatus: 7,
      BusinessStatusText: 'Published',
      BusinessStatusDate: '/Date(0)/',
      SubmissionDate: '/Date(0)/',
      Modified: '/Date(1000)/',
    },
    expected: {
      id: guid,
      billNumber: 1,
      billTypeId: '3',
      billTypeName: 'Synthetic bill',
      title: 'Bill [one]',
      statusId: '7',
      statusText: 'Published',
      statusDate: '1970-01-01T00:00:00.000',
      submissionDate: '1970-01-01T00:00:00.000',
      modifiedAt: modified,
      sourceUrl: `https://ws.parlament.ch/odata.svc/Bill(ID=guid'${guid}',Language='DE')?$format=json`,
    },
  },
  {
    section: 'related_business',
    entity: 'RelatedBusiness',
    key: 'relatedBusiness',
    order: 'RelatedBusinessNumber asc,ID asc',
    expand: null,
    row: {
      ID: guid,
      RelatedBusinessNumber: 20991235,
      RelatedBusinessShortNumber: '99.1235',
      RelatedBusinessTitle: 'Related *item*',
      RelatedBusinessType: 4,
      RelatedBusinessTypeName: 'Type',
      RelatedBusinessTypeAbbreviation: 'T.',
      PriorityCode: 'A',
      Modified: '/Date(1000)/',
    },
    expected: {
      id: guid,
      relatedBusinessId: '20991235',
      shortNumber: '99.1235',
      title: 'Related *item*',
      typeId: '4',
      typeName: 'Type',
      typeAbbreviation: 'T.',
      priorityCode: 'A',
      modifiedAt: modified,
    },
  },
  {
    section: 'preconsultations',
    entity: 'Preconsultation',
    key: 'preconsultations',
    order: 'PreconsultationDate asc,ID asc',
    expand: null,
    row: {
      ID: guid,
      IdBill: guid,
      BillNumber: 2,
      CommitteeNumber: 7,
      CommitteeName: 'Commission',
      Abbreviation: '',
      Abbreviation1: 'C1',
      Abbreviation2: 'C2',
      PreconsultationDate: '/Date(0)/',
      TreatmentCategory: 'A',
      Modified: '/Date(1000)/',
    },
    expected: {
      id: guid,
      billId: guid,
      billNumber: 2,
      committeeId: '7',
      committeeName: 'Commission',
      committeeAbbreviation: '',
      committeeAbbreviation1: 'C1',
      committeeAbbreviation2: 'C2',
      preconsultationDate: '1970-01-01T00:00:00.000',
      treatmentCategory: 'A',
      modifiedAt: modified,
    },
  },
  {
    section: 'subjects',
    entity: 'SubjectBusiness',
    key: 'subjects',
    order: 'IdSubject asc',
    expand: 'Subjects/Meetings',
    row: {
      IdSubject: '9007199254740993',
      Title: 'Débat',
      SortOrder: 0,
      PublishedNotes: '<p>Notes\r\n```</p>',
      Modified: '/Date(1000)/',
      Subjects: subjectMeeting,
    },
    expected: {
      subjectId: '9007199254740993',
      businessId: '20991234',
      title: 'Débat',
      sortOrder: 0,
      publishedNotes: '<p>Notes\r\n```</p>',
      modifiedAt: modified,
      meetingDate: '2019-12-18',
      councilName: 'Ständerat',
      sessionId: '5101',
      sessionName: 'Wintersession 2019',
    },
  },
] as const;

/** A non-null value of its source type for every property a relationship query can select. */
const selectableValues: Record<string, unknown> = {
  ID: guid,
  Language: 'DE',
  BusinessNumber: 20991234,
  BusinessStatusId: 1,
  BusinessStatusName: 'S',
  BusinessStatusDate: '/Date(0)/',
  IsMotionInSecondCouncil: true,
  NewKey: 1,
  Modified: '/Date(1000)/',
  BillNumber: 1,
  BillType: 1,
  BillTypeName: 'T',
  Title: 'T',
  BusinessStatus: 1,
  BusinessStatusText: 'T',
  SubmissionDate: '/Date(0)/',
  RelatedBusinessNumber: 20991235,
  RelatedBusinessShortNumber: '99.1235',
  RelatedBusinessTitle: 'T',
  RelatedBusinessType: 1,
  RelatedBusinessTypeName: 'T',
  RelatedBusinessTypeAbbreviation: 'T',
  PriorityCode: 'A',
  IdBill: guid,
  CommitteeNumber: 1,
  CommitteeName: 'C',
  Abbreviation: 'A',
  Abbreviation1: 'A1',
  Abbreviation2: 'A2',
  PreconsultationDate: '/Date(0)/',
  TreatmentCategory: 'A',
  IdSubject: '1',
  SortOrder: 0,
  PublishedNotes: 'N',
  'Subjects/Language': 'DE',
  'Subjects/Meetings/Language': 'DE',
  'Subjects/Meetings/Date': '/Date(0)/',
  'Subjects/Meetings/CouncilName': 'C',
  'Subjects/Meetings/IdSession': 1,
  'Subjects/Meetings/SessionName': 'S',
};

/** Build the source row a `$select` list describes, nesting each navigation path's value. */
function selectedRow(select: readonly string[]): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const field of select) {
    if (!Object.hasOwn(selectableValues, field))
      throw new Error(`No synthetic value for selected property ${field}.`);
    const path = field.split('/');
    let target = row;
    for (const segment of path.slice(0, -1)) {
      target[segment] ??= {};
      target = target[segment] as Record<string, unknown>;
    }
    target[path.at(-1) ?? field] = selectableValues[field];
  }
  return row;
}

const AdvertisedRowsSchema = z.object({
  items: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    additionalProperties: z.literal(false),
  }),
});

describe('chparl_get_business', () => {
  it('discloses every overview field and byte availability without implicit relationships or large text', async () => {
    serveBusiness({
      ...businessRow,
      ResponsibleDepartment: 1,
      ResponsibleDepartmentName: 'Department',
      ResponsibleDepartmentAbbreviation: 'D',
      FederalCouncilProposal: 0,
      FederalCouncilProposalDate: '/Date(0)/',
      FirstCouncil1: 1,
      FirstCouncil1Name: 'First',
      FirstCouncil2: 2,
      FirstCouncil2Name: 'Second',
      Tags: 'A;B',
      TagNames: 'α;β',
      Category: '',
      Description: 'é界',
      InitialSituation: '',
      Proceedings: null,
    });
    const result = await runToolContract(getBusinessTool, {
      businessId: ' 20991234 ',
      textFields: [],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      found: true,
      section: 'overview',
      business: {
        ...businessSummary,
        responsibleDepartmentId: '1',
        responsibleDepartmentName: 'Department',
        responsibleDepartmentAbbreviation: 'D',
        federalCouncilProposalId: '0',
        federalCouncilProposalDate: '1970-01-01T00:00:00.000',
        firstCouncil1Id: '1',
        firstCouncil1Name: 'First',
        firstCouncil2Id: '2',
        firstCouncil2Name: 'Second',
        tags: 'A;B',
        tagNames: 'α;β',
        category: '',
      },
      effectiveFilters: { businessId: '20991234', language: 'de', section: 'overview' },
    });
    const output = getBusinessTool.output.parse(result.structuredContent);
    expect(output.business?.availableTextFields).toEqual([
      { name: 'description', sizeBytes: 5 },
      { name: 'initialSituation', sizeBytes: 0 },
      { name: 'proceedings' },
      { name: 'draftText' },
      { name: 'submittedText' },
      { name: 'reasonText' },
      { name: 'documentationText' },
      { name: 'motionText' },
      { name: 'federalCouncilResponseText' },
      { name: 'federalCouncilProposalText' },
    ]);
    expect(result.structuredContent).not.toHaveProperty('returnedCount');
    expect(result.structuredContent).not.toHaveProperty('textDocument');
    expect(http.calls).toHaveLength(1);
    expect(decodeURIComponent(new URL(http.calls[0]?.request.url ?? '').pathname)).toBe(
      "/odata.svc/Business(ID=20991234,Language='DE')",
    );
    expectBusinessParity(result);
  });

  it('retains a sparse found record without invented metadata or text values', async () => {
    serveBusiness({ ID: 20991234, Language: 'FR', Title: null, Description: null });
    const result = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      language: 'FR',
      section: 'texts',
    });
    expect(result.structuredContent).toMatchObject({
      found: true,
      business: { businessId: '20991234', metadataLanguage: 'fr' },
      textDocument: { kind: 'full', references: [] },
    });
    expect(getBusinessTool.output.parse(result.structuredContent).business).not.toHaveProperty(
      'title',
    );
    expect(result.structuredContent).not.toHaveProperty('hasMore');
    expectBusinessParity(result);
  });

  it.each(relationCases)(
    'maps every $section field and its independent query',
    async ({ section, entity, key, order, expand, row, expected }) => {
      http.reset();
      http.route({
        match: () => true,
        respond: (request) =>
          Response.json(
            new URL(request.url).pathname.includes('Business(')
              ? { d: businessRow }
              : {
                  d: {
                    results: [{ ...row, Language: 'DE', BusinessNumber: 20991234 }],
                    __count: '4',
                  },
                },
          ),
      });
      const result = await runToolContract(getBusinessTool, {
        businessId: '20991234',
        section,
        limit: 1,
        offset: 2,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        found: true,
        business: businessSummary,
        [key]: [expected],
        effectiveFilters: { businessId: '20991234', section, limit: 1, offset: 2, language: 'de' },
        returnedCount: 1,
        totalCount: 4,
        nextOffset: 3,
        hasMore: true,
      });
      const url = new URL(http.calls[1]?.request.url ?? '');
      expect(url.pathname).toBe(`/odata.svc/${entity}`);
      expect(url.searchParams.get('$filter')).toBe(
        "Language eq 'DE' and (BusinessNumber eq 20991234)",
      );
      expect(url.searchParams.get('$orderby')).toBe(order);
      expect(url.searchParams.get('$expand')).toBe(expand);
      expect(url.searchParams.get('$inlinecount')).toBe('allpages');
      expect(url.searchParams.get('$top')).toBe('1');
      expect(url.searchParams.get('$skip')).toBe('2');
      // The business read plus one section request; meeting context adds no request.
      expect(http.calls).toHaveLength(2);
      expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$select')).not.toContain(
        'Description',
      );
      expectBusinessParity(result);
    },
  );

  it.each(relationCases)(
    'advertises exactly the $key row fields its section mapping can emit',
    async ({ section, key, expected }) => {
      // The source returns every property the section selects, so the mapping emits all it can.
      http.reset();
      http.route({
        match: () => true,
        respond: (request) => {
          const select = new URL(request.url).searchParams.get('$select')?.split(',') ?? [];
          return Response.json({ d: { results: [selectedRow(select)], __count: '1' } });
        },
      });
      const page = await withWorkflow(createMockContext(), (workflow) =>
        listBusinessSection('20991234', section, 'de', { limit: 1, offset: 0 }, workflow),
      );
      const emitted = Object.keys(page.items[0] ?? {}).sort();
      expect(emitted).toEqual(Object.keys(expected).sort());
      const advertised = AdvertisedRowsSchema.parse(
        z.toJSONSchema(getBusinessTool.output, { io: 'output', target: 'draft-2020-12' })
          .properties?.[key],
      );
      expect(Object.keys(advertised.items.properties).sort()).toEqual(emitted);
    },
  );

  // A pick's key order is the order the output parse emits on both surfaces; 0.1.2 used the superset's.
  it.each([
    [
      'statusHistory',
      ['id', 'statusId', 'statusName', 'date', 'isMotionInSecondCouncil', 'newKey', 'modifiedAt'],
    ],
    [
      'bills',
      [
        'id',
        'statusId',
        'modifiedAt',
        'billNumber',
        'billTypeId',
        'billTypeName',
        'title',
        'statusText',
        'statusDate',
        'submissionDate',
        'sourceUrl',
      ],
    ],
    [
      'relatedBusiness',
      [
        'id',
        'modifiedAt',
        'title',
        'relatedBusinessId',
        'shortNumber',
        'typeId',
        'typeName',
        'typeAbbreviation',
        'priorityCode',
      ],
    ],
    [
      'preconsultations',
      [
        'id',
        'modifiedAt',
        'billNumber',
        'billId',
        'committeeId',
        'committeeName',
        'committeeAbbreviation',
        'committeeAbbreviation1',
        'committeeAbbreviation2',
        'preconsultationDate',
        'treatmentCategory',
      ],
    ],
    [
      'subjects',
      [
        'modifiedAt',
        'title',
        'subjectId',
        'businessId',
        'sortOrder',
        'publishedNotes',
        'meetingDate',
        'councilName',
        'sessionId',
        'sessionName',
      ],
    ],
  ] as const)('keeps the 0.1.2 field order of %s rows', (key, order) => {
    const advertised = AdvertisedRowsSchema.parse(
      z.toJSONSchema(getBusinessTool.output, { io: 'output', target: 'draft-2020-12' })
        .properties?.[key],
    );
    expect(Object.keys(advertised.items.properties)).toEqual(order);
  });

  function serveSubject(language: string, subjects?: unknown) {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json(
          new URL(request.url).pathname.includes('Business(')
            ? { d: { ...businessRow, Language: language } }
            : {
                d: {
                  results: [
                    {
                      IdSubject: '48155',
                      BusinessNumber: 20991234,
                      Language: language,
                      Title: 'OR. Aktienrecht',
                      SortOrder: 1,
                      PublishedNotes: 'Differenzen - Divergences\n',
                      ...(subjects !== undefined && { Subjects: subjects }),
                    },
                  ],
                  __count: '1',
                },
              },
        ),
    });
  }

  it.each([
    {
      name: 'French meeting labels',
      language: 'fr',
      subjects: {
        Language: 'FR',
        Meetings: {
          Language: 'FR',
          Date: '/Date(1576627200000)/',
          CouncilName: 'Conseil des Etats',
          IdSession: 5101,
          SessionName: "Session d'hiver 2019",
        },
      },
      meeting: {
        meetingDate: '2019-12-18',
        councilName: 'Conseil des Etats',
        sessionId: '5101',
        sessionName: "Session d'hiver 2019",
      },
    },
    {
      name: 'the local day of an explicit-offset meeting date',
      language: 'de',
      subjects: {
        Language: 'DE',
        Meetings: { ...subjectMeeting.Meetings, Date: '/Date(1576710000000+0060)/' },
      },
      meeting: {
        meetingDate: '2019-12-19',
        councilName: 'Ständerat',
        sessionId: '5101',
        sessionName: 'Wintersession 2019',
      },
    },
    {
      name: 'a sparse meeting',
      language: 'de',
      subjects: {
        Language: 'DE',
        Meetings: {
          Language: 'DE',
          Date: null,
          CouncilName: 'Nationalrat',
          IdSession: null,
          SessionName: null,
        },
      },
      meeting: { councilName: 'Nationalrat' },
    },
    {
      name: 'a null meeting',
      language: 'de',
      subjects: { Language: 'DE', Meetings: null },
      meeting: {},
    },
    { name: 'a null subject', language: 'de', subjects: null, meeting: {} },
  ] as const)(
    'maps the subject meeting context of $name',
    async ({ language, subjects, meeting }) => {
      serveSubject(language.toUpperCase(), subjects);
      const result = await runToolContract(getBusinessTool, {
        businessId: '20991234',
        section: 'subjects',
        language,
      });
      expect(result.isError).not.toBe(true);
      expect(getBusinessTool.output.parse(result.structuredContent).subjects).toEqual([
        {
          subjectId: '48155',
          businessId: '20991234',
          title: 'OR. Aktienrecht',
          sortOrder: 1,
          publishedNotes: 'Differenzen - Divergences\n',
          ...meeting,
        },
      ]);
      expectBusinessParity(result);
    },
  );

  it.each([
    {
      name: 'a deferred subject',
      subjects: {
        __deferred: {
          uri: "https://ws.parlament.ch/odata.svc/SubjectBusiness(BusinessNumber=20991234,IdSubject=48155L,Language='DE')/Subjects",
        },
      },
    },
    {
      name: 'a deferred meeting',
      subjects: {
        Language: 'DE',
        Meetings: {
          __deferred: {
            uri: "https://ws.parlament.ch/odata.svc/Subject(ID=48155L,Language='DE')/Meetings",
          },
        },
      },
    },
    { name: 'a subject in another language', subjects: { ...subjectMeeting, Language: 'FR' } },
    {
      name: 'a meeting in another language',
      subjects: { Language: 'DE', Meetings: { ...subjectMeeting.Meetings, Language: 'FR' } },
    },
    { name: 'a missing expansion', subjects: undefined },
    { name: 'a subject without its Meetings key', subjects: { Language: 'DE' } },
  ])('rejects $name as a serialization error', async ({ subjects }) => {
    serveSubject('DE', subjects);
    const result = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'subjects',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(result.structuredContent).not.toHaveProperty('subjects');
    expect(http.calls).toHaveLength(2);
  });

  it.each([
    { total: '0', offset: 0, guidance: 'no published records' },
    { total: '3', offset: 3, guidance: 'offset:0' },
  ])(
    'distinguishes empty relationship from past end ($total/$offset)',
    async ({ total, offset, guidance }) => {
      http.reset();
      http.route({
        match: () => true,
        respond: (request) =>
          Response.json(
            new URL(request.url).pathname.includes('Business(')
              ? { d: businessRow }
              : { d: { results: [], __count: total } },
          ),
      });
      const result = await runToolContract(getBusinessTool, {
        businessId: '20991234',
        section: 'subjects',
        limit: 101,
        offset,
      });
      expect(result.structuredContent).toMatchObject({
        found: true,
        subjects: [],
        returnedCount: 0,
        totalCount: Number(total),
        hasMore: false,
        effectiveLimit: 100,
      });
      expect(result.structuredContent).not.toHaveProperty('nextOffset');
      expect(textContent(result)).toContain(guidance);
      expect(textContent(result)).toContain('clamped to 100');
      expectBusinessParity(result);
    },
  );

  it('returns every requested relationship row whatever its size and advances by delivered rows', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      Language: 'DE',
      BusinessNumber: 20991234,
      IdSubject: String(index + 1),
      Title: `<p>${'é'.repeat(300)}\r\n${index}</p>`,
      Subjects: subjectMeeting,
    }));
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json(
          new URL(request.url).pathname.includes('Business(')
            ? { d: businessRow }
            : { d: { results: rows, __count: '40' } },
        ),
    });
    const result = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'subjects',
      offset: 5,
    });
    const items = getBusinessTool.output.parse(result.structuredContent).subjects ?? [];
    expect(items.map((item) => item.title)).toEqual(rows.map((row) => row.Title));
    expect(result.structuredContent).toMatchObject({
      returnedCount: 20,
      effectiveLimit: 20,
      nextOffset: 25,
      totalCount: 40,
      hasMore: true,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    // A page over 24,000 bytes still holds every row the limit asked for.
    expect(resultBytes(result)).toBeGreaterThan(24_000);
    expectBusinessParity(result);
  });

  it.each(relationCases)(
    'returns and completely continues 100 full $section rows per page on both surfaces',
    async ({ section, row, expected, key }) => {
      const longField =
        section === 'status_history'
          ? 'BusinessStatusName'
          : section === 'related_business'
            ? 'RelatedBusinessTitle'
            : section === 'preconsultations'
              ? 'CommitteeName'
              : 'Title';
      const outputField =
        section === 'status_history'
          ? 'statusName'
          : section === 'preconsultations'
            ? 'committeeName'
            : 'title';
      const total = 250;
      const rows = Array.from({ length: total }, (_, index) => ({
        ...row,
        Language: 'DE',
        BusinessNumber: 20991234,
        ...(section === 'subjects'
          ? { IdSubject: String(9007199254740993n + BigInt(index)) }
          : { ID: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` }),
        [longField]: `<p>${'界'.repeat(200)}\r\n${index}</p>`,
      }));
      const expectedRows = rows.map((_, index) => {
        const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
        return {
          ...expected,
          ...(section === 'subjects'
            ? { subjectId: String(9007199254740993n + BigInt(index)) }
            : { id }),
          ...(section === 'bills'
            ? {
                sourceUrl: `https://ws.parlament.ch/odata.svc/Bill(ID=guid'${id}',Language='DE')?$format=json`,
              }
            : {}),
          [outputField]: `<p>${'界'.repeat(200)}\r\n${index}</p>`,
        };
      });
      http.reset();
      http.route({
        match: () => true,
        respond: (request) => {
          const url = new URL(request.url);
          if (url.pathname.includes('Business(')) return Response.json({ d: businessRow });
          const offset = Number(url.searchParams.get('$skip'));
          return Response.json({
            d: {
              results: rows.slice(offset, offset + Number(url.searchParams.get('$top'))),
              __count: String(total),
            },
          });
        },
      });
      const collected: unknown[] = [];
      let offset = 0;
      // Two full pages, then the short last page; the walk is bounded by these three calls.
      for (const size of [100, 100, 50]) {
        const result = await runToolContract(getBusinessTool, {
          businessId: '20991234',
          section,
          limit: offset === 0 ? 101 : 100,
          offset,
        });
        expect(result.isError).not.toBe(true);
        const items = getBusinessTool.output.parse(result.structuredContent)[key] ?? [];
        expect(items).toEqual(expectedRows.slice(offset, offset + size));
        const more = offset + size < total;
        expect(result.structuredContent).toMatchObject({
          effectiveLimit: 100,
          returnedCount: size,
          totalCount: total,
          hasMore: more,
          ...(more && { nextOffset: offset + size }),
        });
        if (offset === 0) {
          expect(result.structuredContent).toMatchObject({
            notice: 'Requested limit 101 was clamped to 100.',
          });
        } else {
          expect(result.structuredContent).not.toHaveProperty('notice');
        }
        if (!more) expect(result.structuredContent).not.toHaveProperty('nextOffset');
        expectBusinessParity(result);
        collected.push(...items);
        offset += size;
      }
      expect(collected).toEqual(expectedRows);
      expect(new URL(http.calls[1]?.request.url ?? '').searchParams.get('$top')).toBe('100');
      const pastEnd = await runToolContract(getBusinessTool, {
        businessId: '20991234',
        section,
        limit: 100,
        offset: total,
      });
      expect(pastEnd.structuredContent).toMatchObject({
        [key]: [],
        totalCount: total,
        returnedCount: 0,
        hasMore: false,
        notice: expect.stringContaining('past the last relationship record'),
      });
      expect(pastEnd.structuredContent).not.toHaveProperty('nextOffset');
      expectBusinessParity(pastEnd);
    },
  );

  it('returns every original text field and HTML reference without rewriting its bytes', async () => {
    const html =
      '<p>α\r\n\t``` <a href="https://example.test/a?x=1&amp;y=2">A</a><img src="https://example.test/image.png" alt="Icon [x]"><a href="/relative">R</a><a href="javascript:alert(1)">X</a></p>';
    serveBusiness({
      ...businessRow,
      Description: html,
      InitialSituation: '',
      Proceedings: 'P',
      DraftText: 'D',
      SubmittedText: 'S',
      ReasonText: 'R',
      DocumentationText: 'Doc',
      MotionText: 'M',
      FederalCouncilResponseText: 'Response',
      FederalCouncilProposalText: 'Proposal',
    });
    const result = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
    });
    expect(result.structuredContent).toMatchObject({
      textDocument: {
        kind: 'full',
        description: html,
        initialSituation: '',
        proceedings: 'P',
        draftText: 'D',
        submittedText: 'S',
        reasonText: 'R',
        documentationText: 'Doc',
        motionText: 'M',
        federalCouncilResponseText: 'Response',
        federalCouncilProposalText: 'Proposal',
        references: [
          {
            kind: 'link',
            originalUrl: 'https://example.test/a?x=1&amp;y=2',
            url: 'https://example.test/a?x=1&y=2',
          },
          {
            kind: 'image',
            originalUrl: 'https://example.test/image.png',
            url: 'https://example.test/image.png',
            label: 'Icon [x]',
          },
          { kind: 'link', originalUrl: '/relative' },
          { kind: 'link', originalUrl: 'javascript:alert(1)' },
        ],
      },
    });
    const output = getBusinessTool.output.parse(result.structuredContent);
    expect(output.textDocument?.references?.[2]).not.toHaveProperty('url');
    expect(output.textDocument?.references?.[3]).not.toHaveProperty('url');
    const decoded = expectBusinessParity(result);
    expect(decoded.strings).toContain(html);
    expect(decoded.links).toContain('https://example.test/a?x=1&y=2');
    expect(decoded.images).toContain('https://example.test/image.png');
  });

  it('uses UTF-8 bytes for text disclosure and preserves a single large field', async () => {
    const overhead = new TextEncoder().encode(
      JSON.stringify({ description: '', initialSituation: '' }),
    ).byteLength;
    const below = 'é'.repeat(1000);
    serveBusiness({ ...businessRow, Description: below, InitialSituation: '' });
    const full = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
    });
    expect(full.structuredContent).toMatchObject({
      textDocument: { kind: 'full', description: below },
    });
    const exact =
      below + 'a'.repeat(24_000 - overhead - new TextEncoder().encode(below).byteLength);
    serveBusiness({ ...businessRow, Description: exact, InitialSituation: '' });
    const outlined = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
    });
    expect(outlined.structuredContent).toMatchObject({
      textDocument: {
        kind: 'outline',
        sections: [
          { name: 'description', sizeBytes: 24_000 - overhead },
          { name: 'initialSituation', sizeBytes: 0 },
        ],
      },
    });
    expect(
      getBusinessTool.output.parse(outlined.structuredContent).textDocument,
    ).not.toHaveProperty('references');
    expect(textContent(outlined)).toContain('section:texts');
    expect(textContent(outlined)).toContain('textFields');
    serveBusiness({ ...businessRow, Description: exact, InitialSituation: null });
    const single = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
    });
    expect(single.structuredContent).toMatchObject({
      textDocument: { kind: 'full', description: exact },
    });
    expectBusinessParity(full);
    expectBusinessParity(outlined);
    expectBusinessParity(single);
  });

  it('outlines multiple fields when the complete public reply exceeds 24000 bytes despite a smaller source map', async () => {
    const description = 'é'.repeat(4000);
    const initialSituation = 'β'.repeat(3000);
    expect(
      new TextEncoder().encode(JSON.stringify({ description, initialSituation })).byteLength,
    ).toBeLessThan(24_000);
    serveBusiness({ ...businessRow, Description: description, InitialSituation: initialSituation });
    const explicit = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
      textFields: ['description', 'initialSituation'],
    });
    expect(
      new TextEncoder().encode(
        JSON.stringify({
          structuredContent: explicit.structuredContent,
          content: explicit.content,
        }),
      ).byteLength,
    ).toBeGreaterThanOrEqual(24_000);
    expect(explicit.structuredContent).toMatchObject({
      textDocument: { kind: 'full', description, initialSituation },
    });
    const result = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
    });
    expect(result.structuredContent).toMatchObject({
      textDocument: {
        kind: 'outline',
        sections: [
          { name: 'description', sizeBytes: 8000 },
          { name: 'initialSituation', sizeBytes: 6000 },
        ],
        notice: expect.stringContaining('textFields'),
      },
    });
    expect(getBusinessTool.output.parse(result.structuredContent).textDocument).not.toHaveProperty(
      'description',
    );
    expect(
      new TextEncoder().encode(
        JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
      ).byteLength,
    ).toBeLessThan(24_000);
    expectBusinessParity(result);
  });

  it('preserves original HTML while making HTML-decoded link and image targets usable', async () => {
    const html =
      '<p><a href="https://example.test/&num;chapter">Chapter</a><img src="https://example.test/&#0;" alt="Original"></p>';
    serveBusiness({ ...businessRow, Description: html });
    const result = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
    });
    expect(result.structuredContent).toMatchObject({
      textDocument: {
        description: html,
        references: [
          {
            kind: 'link',
            originalUrl: 'https://example.test/&num;chapter',
            url: 'https://example.test/#chapter',
          },
          {
            kind: 'image',
            originalUrl: 'https://example.test/&#0;',
            url: 'https://example.test/%EF%BF%BD',
            label: 'Original',
          },
        ],
      },
    });
    const decoded = expectBusinessParity(result);
    expect(decoded.strings).toContain(html);
    expect(decoded.links).toContain('https://example.test/#chapter');
    expect(decoded.images).toContain('https://example.test/%EF%BF%BD');
  });

  it('returns explicit oversized selected fields whole and reports valid unavailable names separately', async () => {
    const large = `<p>${'界'.repeat(12_000)}</p>`;
    serveBusiness({
      ...businessRow,
      Description: large,
      Proceedings: '<a href="https://example.test/hidden">hidden</a>',
    });
    const result = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
      textFields: ['description', 'reasonText'],
    });
    expect(result.structuredContent).toMatchObject({
      textDocument: {
        kind: 'full',
        description: large,
        unavailableTextFields: ['reasonText'],
        references: [],
        notice: expect.stringContaining('chparl_get_business'),
      },
    });
    expect(textContent(result)).toContain('textFields');
    expectBusinessParity(result);
    const unavailable = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
      textFields: ['reasonText'],
    });
    expect(unavailable.structuredContent).toMatchObject({
      textDocument: { kind: 'full', unavailableTextFields: ['reasonText'], references: [] },
    });
    expectBusinessParity(unavailable);
    const invalid = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'texts',
      textFields: ['notAField'],
    });
    expect(invalid.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(2);
  });

  it.each(['overview', 'texts', 'subjects'] as const)(
    'returns missing-parent guidance and no collection metadata for %s',
    async (section) => {
      serveBusiness(null);
      const result = await runToolContract(getBusinessTool, { businessId: '20991234', section });
      expect(result.structuredContent).toMatchObject({
        found: false,
        section,
        guidance: expect.stringContaining('chparl_search_business'),
        effectiveFilters: { section },
      });
      expect(result.structuredContent).not.toHaveProperty('business');
      expect(result.structuredContent).not.toHaveProperty('returnedCount');
      expect(result.structuredContent).not.toHaveProperty('totalCount');
      expect(http.calls).toHaveLength(1);
      expectBusinessParity(result);
    },
  );

  it('resolves the exact published short number without inferring a century', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json(
          new URL(request.url).pathname === '/odata.svc/Business'
            ? { d: { results: [{ ID: 20991234, Language: 'DE' }], __count: '1' } }
            : { d: businessRow },
        ),
    });
    const result = await runToolContract(getBusinessTool, { businessId: ' 99.1234 ' });
    expect(result.structuredContent).toMatchObject({ found: true, business: businessSummary });
    const lookup = new URL(http.calls[0]?.request.url ?? '');
    expect(lookup.searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (BusinessShortNumber eq '99.1234')",
    );
    expect(lookup.searchParams.get('$top')).toBe('2');
    expect(lookup.searchParams.get('$select')).toBe('ID,Language');
    expect(http.calls).toHaveLength(2);
    expectBusinessParity(result);
  });

  it('distinguishes an exact short-number miss from ambiguity with declared recovery', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: () => Response.json({ d: { results: [], __count: '0' } }),
    });
    const missing = await runToolContract(getBusinessTool, { businessId: '99.1234' });
    expect(missing.structuredContent).toMatchObject({ found: false });
    expectBusinessParity(missing);
    http.reset();
    http.route({
      match: () => true,
      respond: () =>
        Response.json({
          d: {
            results: [
              { ID: 20991234, Language: 'DE' },
              { ID: 19991234, Language: 'DE' },
            ],
            __count: '2',
          },
        }),
    });
    const ambiguous = await runToolContract(getBusinessTool, { businessId: '99.1234' });
    expect(ambiguous.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'ambiguous_business_number',
          recovery: {
            hint: 'Use chparl_search_business to identify the intended canonical businessId.',
          },
        },
      },
    });
    expect(textContent(ambiguous)).toContain('canonical businessId');
    expect(http.calls).toHaveLength(1);
  });

  it.each([
    { section: 'overview', limit: 1 },
    { section: 'texts', offset: 0 },
    { section: 'subjects', textFields: ['description'] },
  ] as const)('publishes incompatible-fields recovery for %o', async (input) => {
    const result = await runToolContract(getBusinessTool, { businessId: '20991234', ...input });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'incompatible_fields',
          recovery: { hint: expect.stringContaining('section texts') },
        },
      },
    });
    expect(textContent(result)).toContain('incompatible_fields');
    expect(textContent(result)).toContain('relationship section for paging');
    expect(http.calls).toHaveLength(0);
  });

  it('propagates source failures and rate-limit recovery without private payloads', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: () =>
        Response.json(
          { error: { innererror: 'private-stack' } },
          { status: 429, headers: { 'Retry-After': '999' } },
        ),
    });
    const result = await runToolContract(getBusinessTool, { businessId: '20991234' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'upstream_rate_limited',
          recovery: { hint: expect.stringContaining('topic coverage') },
        },
      },
    });
    expect(textContent(result)).toContain('topic coverage');
    expect(JSON.stringify(result)).not.toContain('private-stack');
  });

  it('returns a relationship row over 24000 bytes whole on a limit:1 page without a size notice', async () => {
    const title = `<p>${'界'.repeat(12_000)}</p>`;
    http.reset();
    http.route({
      match: () => true,
      respond: (request) =>
        Response.json(
          new URL(request.url).pathname.includes('Business(')
            ? { d: businessRow }
            : {
                d: {
                  results: [
                    {
                      IdSubject: '1',
                      BusinessNumber: 20991234,
                      Language: 'DE',
                      Title: title,
                      Subjects: subjectMeeting,
                    },
                  ],
                  __count: '2',
                },
              },
        ),
    });
    const result = await runToolContract(getBusinessTool, {
      businessId: '20991234',
      section: 'subjects',
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      subjects: [{ subjectId: '1', title }],
      returnedCount: 1,
      totalCount: 2,
      nextOffset: 1,
      hasMore: true,
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(resultBytes(result)).toBeGreaterThan(24_000);
    expectBusinessParity(result);
  });

  it('treats a keyed 404 as a miss and rejects a mismatched composite key', async () => {
    http.reset();
    http.route({
      match: () => true,
      respond: () => Response.json({ error: 'not found' }, { status: 404 }),
    });
    const missing = await runToolContract(getBusinessTool, { businessId: '20991234' });
    expect(missing.structuredContent).toMatchObject({
      found: false,
      provenance: { sources: [{ url: expect.any(String) }] },
    });
    expectBusinessParity(missing);
    serveBusiness({ ID: 20991235, Language: 'DE' });
    const mismatch = await runToolContract(getBusinessTool, { businessId: '20991234' });
    expect(mismatch.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(textContent(mismatch)).toContain('different business');
  });

  it.each([
    { businessId: '' },
    { businessId: '991234' },
    { businessId: '20991234', section: 'subjects', offset: -1 },
    { businessId: '20991234', section: 'subjects', offset: Number.MAX_SAFE_INTEGER + 1 },
    { businessId: '20991234', section: 'subjects', limit: 0 },
  ] as const)('rejects invalid retrieval arguments %o before HTTP', async (input) => {
    const result = await runToolContract(getBusinessTool, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(http.calls).toHaveLength(0);
  });

  it('settles caller cancellation before HTTP on both public surfaces', async () => {
    const result = await runToolContract(
      getBusinessTool,
      { businessId: '20991234' },
      {
        context: {
          signal: AbortSignal.abort(new DOMException('Stop business retrieval.', 'AbortError')),
        },
      },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled, message: 'Stop business retrieval.' },
    });
    expect(textContent(result)).toContain('Stop business retrieval.');
    expect(http.calls).toHaveLength(0);
  });
});
