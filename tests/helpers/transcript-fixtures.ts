/**
 * @fileoverview Synthetic Int64 Bulletin passages with original multilingual HTML.
 * @module tests/helpers/transcript-fixtures
 */

/** IDs exceed JavaScript's exact-number range and must never pass through Number. */
export const transcriptId = '9007199254740993';
export const subjectId = '9007199254740995';

/** Original HTML includes relative and absolute references plus significant whitespace. */
export const transcriptText =
  '<p>Été français 原\r\n\t<a href="https://example.test/a?q=1&amp;x=2">référence</a><img src="/image.png"><img src="https://example.test/image.png" alt="Original"></p>';

/** A German metadata row deliberately contains French speaker text. */
export const transcriptRow = {
  ID: transcriptId,
  Language: 'DE',
  IdSubject: subjectId,
  PersonNumber: 1001,
  SpeakerFullName: ' Synthetic [Speaker] ',
  SpeakerFunction: '',
  MeetingCouncilAbbreviation: 'N',
  CouncilId: 1,
  MeetingDate: '20261025',
  IdSession: '50',
  SortOrder: 3,
  Start: '/Date(0)/',
  StartTimeWithTimezone: '/Date(0+0120)/',
  EndTimeWithTimezone: '/Date(1000+0120)/',
  LanguageOfText: 'fr',
  Text: transcriptText,
};
