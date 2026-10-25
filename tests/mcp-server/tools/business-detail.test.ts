/**
 * @fileoverview Business retrieval sections, text disclosure, and public recovery contracts.
 * @module tests/mcp-server/tools/business-detail.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBusinessTool } from '@/mcp-server/tools/definitions/get-business.tool.js';
import { businessRow, businessSummary, expectBusinessParity } from '../../helpers/business.js';
import { parliamentHttp, textContent } from '../../helpers/parliament.js';

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
const relationCases = [
  {
    section: 'status_history',
    entity: 'BusinessStatus',
    key: 'statusHistory',
    order: 'BusinessStatusDate asc,ID asc',
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
    row: {
      IdSubject: '9007199254740993',
      Title: 'Débat',
      SortOrder: 0,
      PublishedNotes: '<p>Notes\r\n```</p>',
      Modified: '/Date(1000)/',
    },
    expected: {
      subjectId: '9007199254740993',
      businessId: '20991234',
      title: 'Débat',
      sortOrder: 0,
      publishedNotes: '<p>Notes\r\n```</p>',
      modifiedAt: modified,
    },
  },
] as const;

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
    async ({ section, entity, key, order, row, expected }) => {
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
      expect(url.searchParams.get('$inlinecount')).toBe('allpages');
      expect(url.searchParams.get('$top')).toBe('1');
      expect(url.searchParams.get('$skip')).toBe('2');
      expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('$select')).not.toContain(
        'Description',
      );
      expectBusinessParity(result);
    },
  );

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

  it('fits whole relationship rows and advances by delivered rows', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      Language: 'DE',
      BusinessNumber: 20991234,
      IdSubject: String(index + 1),
      Title: `<p>${'é'.repeat(300)}\r\n${index}</p>`,
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
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(20);
    expect(items.map((item) => item.title)).toEqual(
      rows.slice(0, items.length).map((row) => row.Title),
    );
    expect(result.structuredContent).toMatchObject({
      returnedCount: items.length,
      nextOffset: 5 + items.length,
      totalCount: 40,
      hasMore: true,
    });
    expect(
      new TextEncoder().encode(
        JSON.stringify({ structuredContent: result.structuredContent, content: result.content }),
      ).byteLength,
    ).toBeLessThan(24_000);
    expectBusinessParity(result);
  });

  it.each(relationCases)(
    'fits and completely continues 100 full $section rows on both surfaces',
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
      const rows = Array.from({ length: 100 }, (_, index) => ({
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
              __count: '100',
            },
          });
        },
      });
      const collected: unknown[] = [];
      let offset = 0;
      for (;;) {
        const result = await runToolContract(getBusinessTool, {
          businessId: '20991234',
          section,
          limit: offset === 0 ? 101 : 100,
          offset,
        });
        expect(result.isError).not.toBe(true);
        const items = getBusinessTool.output.parse(result.structuredContent)[key] ?? [];
        expect(items).toEqual(expectedRows.slice(offset, offset + items.length));
        expect(items.length).toBeGreaterThan(0);
        expect(result.structuredContent).toMatchObject({
          effectiveLimit: 100,
          returnedCount: items.length,
          totalCount: 100,
          hasMore: offset + items.length < 100,
        });
        expect(
          new TextEncoder().encode(
            JSON.stringify({
              structuredContent: result.structuredContent,
              content: result.content,
            }),
          ).byteLength,
        ).toBeLessThan(24_000);
        expectBusinessParity(result);
        collected.push(...items);
        offset += items.length;
        if (offset === 100) {
          expect(result.structuredContent).not.toHaveProperty('nextOffset');
          break;
        }
        expect(result.structuredContent).toMatchObject({
          nextOffset: offset,
          notice: expect.stringContaining('whole'),
        });
      }
      expect(collected).toEqual(expectedRows);
      expect(new URL(http.calls[1]?.request.url ?? '').searchParams.get('$top')).toBe('100');
      const pastEnd = await runToolContract(getBusinessTool, {
        businessId: '20991234',
        section,
        limit: 100,
        offset: 100,
      });
      expect(pastEnd.structuredContent).toMatchObject({
        [key]: [],
        totalCount: 100,
        returnedCount: 0,
        hasMore: false,
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

  it('preserves an indivisible oversized relationship row and names its exact retrieval path', async () => {
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
                    { IdSubject: '1', BusinessNumber: 20991234, Language: 'DE', Title: title },
                  ],
                  __count: '1',
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
      hasMore: false,
      notice: expect.stringContaining(
        'businessId:20991234, section:subjects, language:de, offset:0, limit:1',
      ),
    });
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
