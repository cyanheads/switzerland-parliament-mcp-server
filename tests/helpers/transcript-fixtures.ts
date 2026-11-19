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

/** 16.077's 27 debate subjects with their meeting's Council, IdSession, and day, as published. */
export const companyLawSubjects = (
  [
    ['43617', 1, 5013, '2018-06-14'],
    ['43642', 1, 5013, '2018-06-14'],
    ['43644', 1, 5013, '2018-06-15'],
    ['44960', 2, 5015, '2018-12-11'],
    ['45539', 2, 5016, '2019-03-12'],
    ['45544', 2, 5016, '2019-03-12'],
    ['46336', 1, 5018, '2019-06-13'],
    ['46349', 1, 5018, '2019-06-13'],
    ['46351', 1, 5018, '2019-06-13'],
    ['46541', 2, 5018, '2019-06-19'],
    ['46553', 2, 5018, '2019-06-19'],
    ['47398', 2, 5019, '2019-09-26'],
    ['48155', 2, 5101, '2019-12-18'],
    ['48173', 1, 5101, '2019-12-19'],
    ['48501', 2, 5102, '2020-03-04'],
    ['48507', 1, 5102, '2020-03-04'],
    ['48554', 2, 5102, '2020-03-09'],
    ['48719', 1, 5102, '2020-03-11'],
    ['48962', 2, 5104, '2020-06-02'],
    ['48974', 1, 5104, '2020-06-03'],
    ['49091', 1, 5104, '2020-06-08'],
    ['49174', 2, 5104, '2020-06-09'],
    ['49178', 2, 5104, '2020-06-09'],
    ['49366', 1, 5104, '2020-06-16'],
    ['49399', 2, 5104, '2020-06-18'],
    ['49435', 2, 5104, '2020-06-19'],
    ['49477', 1, 5104, '2020-06-19'],
  ] as const
).map(([IdSubject, council, sessionId, day]) => ({ IdSubject, council, sessionId, day }));

/**
 * Answer a SubjectBusiness read of business 20160077 from `companyLawSubjects`, applying its
 * `Subjects/Meetings/*` navigation predicates as the source does: Council and IdSession by equality,
 * Date against inclusive datetime day bounds. Without `withCount` the page carries no `__count`.
 */
export function companyLawSubjectPage(url: URL, withCount = true) {
  const filter = url.searchParams.get('$filter') ?? '';
  const council = /Subjects\/Meetings\/Council eq (\d+)/.exec(filter)?.[1];
  const sessionId = /Subjects\/Meetings\/IdSession eq (\d+)/.exec(filter)?.[1];
  const from = /Subjects\/Meetings\/Date ge datetime'([\d-]+)T00:00:00'/.exec(filter)?.[1];
  const to = /Subjects\/Meetings\/Date le datetime'([\d-]+)T23:59:59\.999'/.exec(filter)?.[1];
  const matching = companyLawSubjects.filter(
    (subject) =>
      (council === undefined || String(subject.council) === council) &&
      (sessionId === undefined || String(subject.sessionId) === sessionId) &&
      (from === undefined || subject.day >= from) &&
      (to === undefined || subject.day <= to),
  );
  const offset = Number(url.searchParams.get('$skip'));
  const top = Number(url.searchParams.get('$top'));
  return Response.json({
    d: {
      results: matching
        .slice(offset, offset + top)
        .map(({ IdSubject }) => ({ IdSubject, BusinessNumber: 20160077, Language: 'DE' })),
      ...(withCount && { __count: String(matching.length) }),
    },
  });
}

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
