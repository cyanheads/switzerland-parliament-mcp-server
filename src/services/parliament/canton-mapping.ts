/**
 * @fileoverview Canonical CantonNumber lookup by the published canton abbreviation.
 * @module services/parliament/canton-mapping
 */

import type { Source } from './provenance.js';

/** Official Canton dictionary snapshot used to distinguish Voting.CantonID from CantonNumber. */
export const CANTON_SOURCE: Source = {
  url: 'https://ws.parlament.ch/odata.svc/Canton?%24format=json&%24filter=Language+eq+%27DE%27&%24select=ID%2CLanguage%2CCantonNumber%2CCantonAbbreviation%2CCantonName&%24top=100&%24orderby=CantonNumber+asc%2CID+asc&%24inlinecount=allpages',
  retrievedAt: '2026-10-26',
};

// Transcribed from Canton on the snapshot date; the dictionary assigns TI 27 and has no 21.
const cantonNumbers = new Map<string, string>([
  ['ZH', '1'],
  ['BE', '2'],
  ['LU', '3'],
  ['UR', '4'],
  ['SZ', '5'],
  ['OW', '6'],
  ['NW', '7'],
  ['GL', '8'],
  ['ZG', '9'],
  ['FR', '10'],
  ['SO', '11'],
  ['BS', '12'],
  ['BL', '13'],
  ['SH', '14'],
  ['AR', '15'],
  ['AI', '16'],
  ['SG', '17'],
  ['GR', '18'],
  ['AG', '19'],
  ['TG', '20'],
  ['VD', '22'],
  ['VS', '23'],
  ['NE', '24'],
  ['GE', '25'],
  ['JU', '26'],
  ['TI', '27'],
]);

/** Unknown, missing, and noncanonical abbreviations have no inferred canonical identifier. */
export function canonicalCantonId(abbreviation: string | null | undefined): string | undefined {
  return abbreviation == null ? undefined : cantonNumbers.get(abbreviation);
}
