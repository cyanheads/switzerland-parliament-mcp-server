/**
 * @fileoverview Original business text disclosure with UTF-8 outlines and HTML reference indexes.
 * @module services/parliament/business-text
 */

import { z } from '@cyanheads/mcp-ts-core';
import { decodeHTMLAttribute } from 'entities';
import {
  BUSINESS_TEXT_FIELDS,
  BusinessTextFieldSchema,
  type RawBusiness,
} from './business-model.js';

const encoder = new TextEncoder();
const OriginalTextSchema = z.object({
  description: z.string().optional().describe('Original Description text or HTML.'),
  initialSituation: z.string().optional().describe('Original InitialSituation text or HTML.'),
  proceedings: z.string().optional().describe('Original Proceedings text or HTML.'),
  draftText: z.string().optional().describe('Original DraftText text or HTML.'),
  submittedText: z.string().optional().describe('Original SubmittedText text or HTML.'),
  reasonText: z.string().optional().describe('Original ReasonText text or HTML.'),
  documentationText: z.string().optional().describe('Original DocumentationText text or HTML.'),
  motionText: z.string().optional().describe('Original MotionText text or HTML.'),
  federalCouncilResponseText: z
    .string()
    .optional()
    .describe('Original FederalCouncilResponseText text or HTML.'),
  federalCouncilProposalText: z
    .string()
    .optional()
    .describe('Original FederalCouncilProposalText text or HTML.'),
});

/** Reference index accompanies original unmodified text; relative references remain unexpanded. */
export const BusinessTextReferenceSchema = z
  .object({
    kind: z.enum(['link', 'image']).describe('HTML link or image reference.'),
    originalUrl: z.string().describe('Original reference attribute value, before HTML decoding.'),
    label: z.string().optional().describe('Original image alt attribute, when present.'),
    url: z
      .string()
      .optional()
      .describe('Clickable absolute HTTP(S) target when the reference supplies one.'),
  })
  .describe('One reference present in returned original HTML.');

/** Object schema keeps both presence-based full and outline arms advertised. */
export const BusinessTextDocumentSchema = OriginalTextSchema.extend({
  kind: z
    .enum(['full', 'outline'])
    .describe('Complete selected fields or an automatic field-size outline.'),
  sections: z
    .array(
      z
        .object({
          name: BusinessTextFieldSchema.describe('Populated field selectable with textFields.'),
          sizeBytes: z.number().int().nonnegative().describe('Original field UTF-8 byte length.'),
        })
        .describe('One populated text field.'),
    )
    .optional()
    .describe('Populated fields sorted largest first, only on the outline arm.'),
  notice: z.string().optional().describe('How to retrieve complete named fields from an outline.'),
  unavailableTextFields: z
    .array(BusinessTextFieldSchema.describe('Valid requested name without a published value.'))
    .optional()
    .describe('Selected fields absent from this metadata row.'),
  references: z
    .array(BusinessTextReferenceSchema)
    .optional()
    .describe('References extracted only from the original text fields returned in full.'),
}).describe('Original business text without shortening or translation.');

/** Read HTML references without changing the original string or inventing relative URL bases. */
export function businessTextReferences(
  text: string,
): z.infer<typeof BusinessTextReferenceSchema>[] {
  const references: z.infer<typeof BusinessTextReferenceSchema>[] = [];
  const attribute = (tag: string, name: string): string | undefined => {
    const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
      tag,
    );
    return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
  };
  for (const match of text.matchAll(/<(a|img)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
    const tag = match[0];
    const kind = match[1]?.toLowerCase() === 'img' ? 'image' : 'link';
    const originalUrl = attribute(tag, kind === 'image' ? 'src' : 'href');
    if (originalUrl === undefined) continue;
    const decoded = decodeHTMLAttribute(originalUrl);
    const target = URL.parse(decoded);
    const label = kind === 'image' ? attribute(tag, 'alt') : undefined;
    references.push({
      kind,
      originalUrl,
      ...(label !== undefined && { label }),
      ...(target && ['http:', 'https:'].includes(target.protocol) && { url: target.href }),
    });
  }
  return references;
}

/** Return complete selected fields, or a field outline chosen after measuring the full tool result. */
export function businessTextDocument(
  raw: RawBusiness,
  selected?: readonly z.infer<typeof BusinessTextFieldSchema>[] | 'outline',
): z.infer<typeof BusinessTextDocumentSchema> {
  const fields: z.infer<typeof OriginalTextSchema> = {};
  for (const name of BusinessTextFieldSchema.options) {
    const value = raw[BUSINESS_TEXT_FIELDS[name]];
    if (value != null) fields[name] = value;
  }
  if (selected === 'outline') {
    return {
      kind: 'outline',
      sections: BusinessTextFieldSchema.options
        .filter((name) => fields[name] !== undefined)
        .map((name) => ({ name, sizeBytes: encoder.encode(fields[name]).byteLength }))
        .sort((a, b) => b.sizeBytes - a.sizeBytes),
      notice:
        'Call chparl_get_business with the same businessId and language, section:texts, and textFields containing the named fields you need. Each selected field is returned complete even when larger than 24000 bytes.',
    };
  }
  const returned: z.infer<typeof OriginalTextSchema> = {};
  const unavailableTextFields: z.infer<typeof BusinessTextFieldSchema>[] = [];
  for (const name of selected?.length ? selected : BusinessTextFieldSchema.options) {
    const value = fields[name];
    if (value !== undefined) returned[name] = value;
    else if (selected?.length) unavailableTextFields.push(name);
  }
  return {
    kind: 'full',
    ...returned,
    references: Object.values(returned)
      .filter((value) => value !== undefined)
      .flatMap(businessTextReferences),
    ...(unavailableTextFields.length > 0 && { unavailableTextFields }),
  };
}
