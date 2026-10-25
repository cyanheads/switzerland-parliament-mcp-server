/**
 * @fileoverview Public-source attribution and response download provenance.
 * @module services/parliament/provenance
 */

import { z } from '@cyanheads/mcp-ts-core';

/** One contributing HTTP response or checked-in source snapshot. */
export const SourceSchema = z
  .object({
    url: z.string().describe('HTTPS source response or official snapshot document URL.'),
    retrievedAt: z
      .string()
      .describe('Actual UTC download timestamp, or the date of a static source snapshot.'),
  })
  .describe('A source used to produce this result.');

/** Source citation carried alongside every successful result, including empty results. */
export type Source = z.infer<typeof SourceSchema>;

/** Source attribution required by the Parliament open-data conditions. */
export const ProvenanceSchema = z
  .object({
    attribution: z
      .literal('Parlamentsdienste der Bundesversammlung, Bern')
      .describe('Official source attribution.'),
    officialPublication: z
      .literal(false)
      .describe('This server is an unofficial reproduction of the source.'),
    sources: z
      .array(SourceSchema)
      .describe('Every HTTP response contributing data, or each static source snapshot.'),
  })
  .describe('Attribution, publication status, and source download dates.');

/** Build attribution without claiming a new download for a static snapshot. */
export function provenance(sources: readonly Source[]): z.infer<typeof ProvenanceSchema> {
  return {
    attribution: 'Parlamentsdienste der Bundesversammlung, Bern',
    officialPublication: false,
    sources: [...sources],
  };
}
