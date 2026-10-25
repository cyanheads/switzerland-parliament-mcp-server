/**
 * @fileoverview Source-key reference mapping and checked-in snapshot provenance.
 * @module tests/services/parliament/reference.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ParliamentService } from '@/services/parliament/parliament-service.js';
import type { ReferenceFilters } from '@/services/parliament/reference-model.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import { parliamentHttp } from '../../helpers/parliament.js';

let http: ReturnType<typeof parliamentHttp> | undefined;
afterEach(() => http?.restore());

function list(topic: ReferenceFilters['topic'], options: Partial<ReferenceFilters> = {}) {
  return withWorkflow(createMockContext(), async (workflow) => ({
    page: await new ParliamentService().listReference(
      { topic, language: 'de', limit: 100, offset: 0, ...options },
      workflow,
    ),
    sources: workflow.sources,
  }));
}

describe('Parliament reference data', () => {
  it('serves static topics without network and keeps actual snapshot dates', async () => {
    http = parliamentHttp(() => {
      throw new Error('Static reference must not fetch.');
    });
    const statuses = await list('statuses', { language: 'fr' });
    expect(statuses.page.items).toHaveLength(46);
    expect(statuses.page.items.find((item) => item.id === '9')).toEqual({
      id: '9',
      code: '9',
      label: 'Déposé',
      era: 'legacy',
    });
    expect(statuses.page.items.find((item) => item.id === '202')).toEqual({
      id: '202',
      code: '202',
      label: 'Déposé',
      era: 'current',
    });
    expect(statuses.sources).toEqual([
      {
        url: 'https://www.parlament.ch/centers/documents/de/Dokumentation%20Gesch%C3%A4ftsst%C3%A4nde%20per%201.%20Juli%202023.pdf',
        retrievedAt: '2026-10-25',
      },
    ]);
    const languages = await list('languages');
    expect(languages.page.items.map((item) => [item.id, item.label])).toEqual([
      ['de', 'Deutsch'],
      ['fr', 'Français'],
      ['it', 'Italiano'],
    ]);
    expect(languages.sources.map((source) => source.retrievedAt)).toEqual([
      '2026-10-25',
      '2026-10-25',
    ]);
    const identifiers = await list('identifiers');
    expect(identifiers.page.items.map((item) => item.id)).toEqual([
      'business',
      'council',
      'dates',
      'person',
      'reference',
      'subject',
      'transcript',
      'vote',
    ]);
    const coverage = await list('coverage');
    expect(coverage.page.items.find((item) => item.id === 'bulletin')?.description).toContain(
      '1999 winter session',
    );
    expect(coverage.page.items.find((item) => item.id === 'member_votes')?.description).toContain(
      '2003 winter session',
    );
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    {
      topic: 'business_types',
      entity: 'BusinessType',
      fields: { BusinessTypeName: 'Type', BusinessTypeAbbreviation: '' },
      expected: { id: '90', label: 'Type', abbreviation: '' },
    },
    {
      topic: 'councils',
      entity: 'Council',
      fields: { CouncilName: 'Conseil synthétique', CouncilAbbreviation: 'SYN' },
      expected: { id: '90', label: 'Conseil synthétique', abbreviation: 'SYN' },
    },
    {
      topic: 'cantons',
      entity: 'Canton',
      fields: { CantonNumber: 7, CantonName: null },
      expected: { id: '7' },
    },
    {
      topic: 'parties',
      entity: 'Party',
      fields: { PartyNumber: 8, PartyName: 'Parti', StartDate: '/Date(0)/', EndDate: null },
      expected: { id: '8', label: 'Parti', startDate: '1970-01-01T00:00:00.000' },
    },
    {
      topic: 'groups',
      entity: 'ParlGroup',
      fields: { ParlGroupNumber: 9, ParlGroupCode: '', IsActive: false },
      expected: { id: '9', code: '', active: false },
    },
    {
      topic: 'committees',
      entity: 'Committee',
      fields: {
        CommitteeNumber: 10,
        CommitteeName: 'Commission',
        Abbreviation1: 'C',
        Council: 0,
        CommitteeTypeName: 'Type',
      },
      expected: {
        id: '10',
        label: 'Commission',
        abbreviation: 'C',
        councilId: '0',
        description: 'Type',
      },
    },
    {
      topic: 'sessions',
      entity: 'Session',
      fields: {
        SessionName: 'Session',
        SessionNumber: 0,
        TypeName: '',
        LegislativePeriodNumber: 0,
        StartDate: '/Date(0+0060)/',
      },
      expected: {
        id: '90',
        label: 'Session',
        description: 'SessionNumber: 0\nTypeName: ',
        legislativePeriod: 0,
        startDate: '1970-01-01T01:00:00.000+01:00',
      },
    },
  ] as const)(
    'maps $topic with its actual dictionary key and sparse fields',
    async ({ topic, entity, fields, expected }) => {
      http = parliamentHttp(() =>
        Response.json({
          d: { results: [{ ID: 90, Language: 'FR', ...fields, Extra: 'ignored' }], __count: '1' },
        }),
      );
      const result = await list(topic, { language: 'fr' });
      expect(result.page).toEqual({ items: [expected], totalCount: 1, hasMore: false });
      const url = new URL(http.calls[0]?.request.url ?? '');
      expect(url.pathname).toBe(`/odata.svc/${entity}`);
      expect(url.searchParams.get('$filter')).toBe("Language eq 'FR'");
      expect(result.sources).toHaveLength(1);
    },
  );

  it('conjoins session date bounds and stable source ordering without local filtering', async () => {
    http = parliamentHttp(() => Response.json({ d: [] }));
    await list('sessions', { dateFrom: '2024-02-29', dateTo: '2024-03-01', limit: 2, offset: 7 });
    const url = new URL(http.calls[0]?.request.url ?? '');
    expect(url.searchParams.get('$filter')).toBe(
      "Language eq 'DE' and (StartDate ge datetime'2024-02-29T00:00:00' and EndDate le datetime'2024-03-01T23:59:59.999')",
    );
    expect(url.searchParams.get('$orderby')).toBe('StartDate desc,ID desc');
    expect(url.searchParams.get('$top')).toBe('2');
    expect(url.searchParams.get('$skip')).toBe('7');
  });

  it('rejects a mismatched source language or missing dictionary key', async () => {
    http = parliamentHttp(() => Response.json({ d: [{ ID: 1, Language: 'IT' }] }));
    await expect(list('councils')).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
    http.reset();
    http.route({ match: () => true, respond: Response.json({ d: [{ ID: 1, Language: 'DE' }] }) });
    await expect(list('cantons')).rejects.toMatchObject({
      code: JsonRpcErrorCode.SerializationError,
    });
  });
});
