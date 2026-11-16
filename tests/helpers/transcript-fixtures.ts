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

/** Speeches from the 2020 winter session (5107) on debate subject 50854; metadata as published, text synthetic. */
export const marriageSpeechRows = [
  { ID: '272024', PersonNumber: 4078, SpeakerFullName: 'Schmid Martin', SortOrder: 10 },
  { ID: '272028', PersonNumber: 4055, SpeakerFullName: 'Engler Stefan', SortOrder: 3 },
  { ID: '272029', PersonNumber: 4075, SpeakerFullName: 'Caroni Andrea', SortOrder: 4 },
].map((row) => ({
  ...row,
  Language: 'DE',
  IdSubject: '50854',
  Type: 1,
  MeetingCouncilAbbreviation: 'S',
  CouncilId: 2,
  CouncilName: 'Ständerat',
  MeetingDate: '20201201',
  IdSession: '5107',
  LanguageOfText: 'DE',
  Text: '<p>Ehe für alle</p>',
}));

/** The German SubjectBusiness row published for subject 50854. */
export const marriageSubjectBusiness = {
  IdSubject: '50854',
  BusinessNumber: 20130468,
  Language: 'DE',
  BusinessShortNumber: '13.468',
  Title: 'Ehe für alle',
  SortOrder: 1,
};

/** The 13 German SubjectBusiness rows published for subject 3303, the widest mapping found. */
export const sansPapiersSubjectBusinesses = (
  [
    [20013623, '01.3623', 'Ausnahmebewilligungen für Papierlose'],
    [20013592, '01.3592', 'Aufenthaltsregelung für jugendliche "sans-papiers"'],
    [20013480, '01.3480', 'Sans-papiers. Moratorium für Ausweisungen'],
    [20013476, '01.3476', 'Sans-papiers. Vorläufiger Verzicht auf Ausweisungen'],
    [20013473, '01.3473', 'Papierlose. Konkretisierung der Härtefallklausel'],
    [20013149, '01.3149', 'Aufenthaltsbewilligung für Papierlose in der Schweiz'],
    [20013447, '01.3447', 'Sans-papiers. Illegale Besetzung von Gotteshäusern'],
    [20013442, '01.3442', 'Legalisierung der "sans-papiers"'],
    [20013432, '01.3432', 'Legalisierung der "sans-papiers"'],
    [
      20013587,
      '01.3587',
      'Runder Tisch für die Regularisierung von unbewilligten Aufenthalten und Arbeitsverhältnissen',
    ],
    [20013497, '01.3497', 'Zukunft der Kinder rechtswidrig anwesender Ausländer'],
    [20003370, '00.3370', 'Regularisierung der "sans-papiers"'],
    [20013586, '01.3586', 'Möglichkeit für Härtefallprüfung im Asylbereich'],
  ] as const
).map(([BusinessNumber, BusinessShortNumber, Title], index) => ({
  IdSubject: '3303',
  BusinessNumber,
  Language: 'DE',
  BusinessShortNumber,
  Title,
  SortOrder: index + 1,
}));

/** The subject IDs a SubjectBusiness lookup request names, in filter order. */
export function requestedSubjects(url: URL): string[] {
  return [...(url.searchParams.get('$filter') ?? '').matchAll(/IdSubject eq (\d+)L/g)].map(
    (match) => match[1] ?? '',
  );
}

/** Answer a SubjectBusiness lookup page from `mappings`, keeping only the requested subjects. */
export function subjectBusinessPage(url: URL, mappings: readonly Record<string, unknown>[]) {
  const requested = new Set(requestedSubjects(url));
  const matching = mappings.filter((row) => requested.has(String(row.IdSubject)));
  const offset = Number(url.searchParams.get('$skip'));
  const top = Number(url.searchParams.get('$top'));
  return Response.json({
    d: { results: matching.slice(offset, offset + top), __count: String(matching.length) },
  });
}
