/**
 * @fileoverview Checked-in identifier, language, coverage, and status reference snapshots.
 * @module services/parliament/static-reference
 */

import type { Language } from './normalization.js';
import type { Source } from './provenance.js';
import type { ReferenceItem, ReferenceTopic } from './reference-model.js';
import { STATUS_SOURCE, statusCatalog } from './status-catalog.js';

const METADATA: Source = {
  url: 'https://ws.parlament.ch/odata.svc/$metadata',
  retrievedAt: '2026-10-25',
};
const CONDITIONS: Source = {
  url: 'https://www.parlament.ch/de/%C3%BCber-das-parlament/fakten-und-zahlen/open-data-web-services',
  retrievedAt: '2026-10-25',
};

const identifiers: readonly ReferenceItem[] = [
  {
    id: 'business',
    label: 'Business identifiers',
    description:
      'Server explanation: Business.ID is an eight-digit decimal string; BusinessShortNumber is the published short number, such as 99.1234. Resolve short numbers exactly; do not infer a century.',
  },
  {
    id: 'council',
    label: 'Council selectors',
    description:
      'Server explanation: tool council selectors are N or S, or the exact Nationalrat / Conseil national / Consiglio nazionale and Ständerat / Conseil des États / Consiglio degli Stati aliases. Numeric council dictionary keys are separate source values.',
  },
  {
    id: 'dates',
    label: 'Calendar dates',
    description:
      'Server explanation: caller dates are calendar-valid YYYY-MM-DD with inclusive bounds. OData DateTime has no inferred timezone; explicit source offsets are retained. MeetingDate uses YYYYMMDD upstream.',
  },
  {
    id: 'person',
    label: 'PersonNumber',
    description:
      'Server explanation: use the positive signed Int32 PersonNumber as a decimal string. It differs from Person.ID, PersonIdCode, and history-row keys.',
  },
  {
    id: 'reference',
    label: 'Reference identifiers',
    description:
      'Server explanation: reference IDs are positive decimal strings in their metadata integer range. CantonNumber, PartyNumber, ParlGroupNumber, and CommitteeNumber identify the corresponding reference topics; session IDs are Session.ID. Member decision cantonId uses canonical CantonNumber mapped from the published canton abbreviation; votingCantonId preserves the separate raw Voting.CantonID numbering.',
  },
  {
    id: 'subject',
    label: 'Subject identifiers',
    description:
      'Server explanation: Subject and SubjectBusiness identifiers are signed Int64 decimal strings. Preserve them as strings; OData numeric filters use the L suffix.',
  },
  {
    id: 'transcript',
    label: 'Transcript identifiers',
    description:
      'Server explanation: transcript IDs are positive signed Int64 decimal strings. Transcript.IdSession is a string field and must be quoted in OData filters.',
  },
  {
    id: 'vote',
    label: 'Vote identifiers',
    description:
      'Server explanation: vote IDs are positive signed Int32 decimal strings. Discover roll calls by businessId or sessionId, read member history by personNumber, or select a voteId for member decisions and complete group totals.',
  },
];

const coverage: readonly ReferenceItem[] = [
  {
    id: 'attribution',
    label: 'Unofficial reproduction',
    description:
      'Server explanation: results credit Parlamentsdienste der Bundesversammlung, Bern and include source download dates. Underlying author rights remain intact; this server does not assert an additional license over source contents.',
  },
  {
    id: 'bulletin',
    label: 'Bulletin coverage',
    description:
      'Server explanation: Bulletin coverage begins with the 1999 winter session and includes both councils. Source debate text stays in its published language.',
  },
  {
    id: 'limits',
    label: 'Source paging and availability',
    description:
      'Server explanation: source pages cap at 1000 rows. Live updates can change offset-based results between calls. A complete workflow has a 45-second deadline and at most one retry per HTTP request; a narrow request may still encounter an upstream outage or slow text search.',
  },
  {
    id: 'member_votes',
    label: 'Nationalrat member roll calls',
    description:
      'Server explanation: member roll calls cover the Nationalrat from the 2003 winter session. Ständerat member decisions are unavailable here; aggregate Bulletin announcements remain ordinary source text.',
  },
  {
    id: 'metadata',
    label: 'Metadata language coverage',
    description:
      'Server explanation: de, fr, and it metadata rows are available, but completeness of every Italian field is not established. EN and RM rows are not reliable translations. Missing labels and text-language markers remain unknown.',
  },
  {
    id: 'statuses',
    label: 'Status vocabulary snapshot',
    description:
      'Server explanation: status reference labels come from sections 1.1 and 1.2 of the official document dated 21 June 2023, effective 1 July 2023. BusinessStatus is a per-business history table. Unknown live codes are preserved; legacy codes are not silently mapped to current codes.',
  },
];

const languages: readonly ReferenceItem[] = [
  {
    id: 'de',
    label: 'Deutsch',
    code: 'de',
    description:
      'Server explanation: German metadata row; the upstream Language filter is DE. Metadata language does not establish the language of debate text.',
  },
  {
    id: 'fr',
    label: 'Français',
    code: 'fr',
    description:
      'Server explanation: French metadata row; the upstream Language filter is FR. Published debate text is not translated.',
  },
  {
    id: 'it',
    label: 'Italiano',
    code: 'it',
    description:
      'Server explanation: Italian metadata row; the upstream Language filter is IT. Completeness of every Italian field is not established; absent labels remain unknown.',
  },
];

/** Static topic data and its true snapshot dates; explanations remain server-authored facts. */
export function staticReference(
  topic: Extract<ReferenceTopic, 'statuses' | 'identifiers' | 'languages' | 'coverage'>,
  language: Language,
): { items: ReferenceItem[]; sources: Source[] } {
  if (topic === 'statuses') return { items: statusCatalog(language), sources: [STATUS_SOURCE] };
  if (topic === 'identifiers') return { items: [...identifiers], sources: [METADATA] };
  if (topic === 'languages') return { items: [...languages], sources: [METADATA, CONDITIONS] };
  return { items: [...coverage], sources: [METADATA, CONDITIONS, STATUS_SOURCE] };
}
