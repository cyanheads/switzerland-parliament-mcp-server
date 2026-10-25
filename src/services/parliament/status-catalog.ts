/**
 * @fileoverview Faithful DE/FR/IT transcription of official status-document sections 1.1 and 1.2.
 * @module services/parliament/status-catalog
 */

import type { Language } from './normalization.js';
import type { ReferenceItem } from './reference-model.js';

/** Document dated 21 June 2023, effective 1 July 2023; section 2 decision codes are excluded. */
export const STATUS_SOURCE = {
  url: 'https://www.parlament.ch/centers/documents/de/Dokumentation%20Gesch%C3%A4ftsst%C3%A4nde%20per%201.%20Juli%202023.pdf',
  retrievedAt: '2026-10-25',
} as const;

type StatusRow = readonly [code: number, de: string, fr: string, it: string];

const legacy: readonly StatusRow[] = [
  [1, 'Folge gegeben', 'Donné suite', 'Vi è stato dato seguito'],
  [
    2,
    'Behandelt vom Nationalrat',
    'Traité par le Conseil national',
    'Trattato dal Consiglio nazionale',
  ],
  [
    3,
    'Behandelt vom Ständerat',
    'Traité par le Conseil des Etats',
    'Trattato dal Consiglio degli Stati',
  ],
  [4, 'Von beiden Räten behandelt', 'Traité par les deux conseils', 'Trattato dalle due Camere'],
  [9, 'Eingereicht', 'Déposé', 'Depositato'],
  [11, 'Motion an 2. Rat', 'Motion au 2e conseil', 'Mozione alla seconda Camera'],
  [
    13,
    'In der Kommission noch nicht behandelt',
    'Pas encore traité par la commission',
    'Non ancora trattato dalla Commissione',
  ],
  [
    24,
    'Im Rat noch nicht behandelt',
    'Non encore traité au conseil',
    'Non ancora trattato dalla Camera',
  ],
  [25, 'Abgeschrieben', 'Classé', 'Tolto dal ruolo'],
  [26, 'Angenommen', 'Adopté', 'Adottato'],
  [27, 'Erledigt', 'Liquidé', 'Liquidato'],
  [
    28,
    'Vorprüfung - Behandelt vom Nationalrat',
    'Examen préalable par le Conseil national',
    'Esame preliminare. Trattato dal Consiglio nazionale',
  ],
  [
    29,
    'Vorprüfung - Behandelt vom Ständerat',
    'Examen préalable par le Conseil des Etats',
    'Esame preliminare. Trattato dal Consiglio degli Stati',
  ],
  [
    30,
    'Vorprüfung - Von beiden Räten behandelt',
    'Examen préalable par les deux conseils',
    'Esame preliminare. Trattato da entrambi i Consigli',
  ],
  [
    33,
    'An die Kommission zur Vorberatung zugewiesen',
    'Transmis à la commission pour examen préalable',
    'Assegnato alla Commissione per l’esame preliminare',
  ],
  [34, 'Angemeldet', 'Inscription', 'Registrazione'],
  [50, 'Hängig', 'En suspens', 'In sospeso'],
  [60, 'Abgeschlossen', 'Terminé', 'Terminato'],
];

// Spelling, accents, apostrophes, and grammatical quirks are the document's own.
const current: readonly StatusRow[] = [
  [201, 'Angemeldet', 'Annoncé', 'Annunciato'],
  [202, 'Eingereicht', 'Déposé', 'Depositato'],
  [
    203,
    'Stellungnahme zum Vorstoss liegt vor',
    'L’avis relatif à l’intervention est disponible',
    'La dichichiarazione sull’intervento è disponibile',
  ],
  [
    204,
    'Zugewiesen an die behandelnde Kommission',
    'Attribué à la commission compétente',
    'Assegnato alla commissione competente',
  ],
  [
    205,
    'In Nationalrat geplant',
    'Planifié au Conseil national',
    'Pianificato nel Consiglio nazionale',
  ],
  [
    206,
    'In Kommission des Ständerats',
    'En commission du Conseil des États',
    'Nella Commissione del Consiglio degli Stati',
  ],
  [
    207,
    'In Ständerat geplant',
    'Planifié au Conseil des États',
    'Pianificato nel Consiglio degli Stati',
  ],
  [
    208,
    'In Kommission des Nationalrats',
    'En commission du Conseil national',
    'Nella Commissione del Consiglio nazionale',
  ],
  [
    209,
    'Überwiesen an den Bundesrat',
    'Transmis au Conseil fédéral',
    'Trasmesso al Consiglio federale',
  ],
  [210, 'Überwiesen an das Ratsbüro', 'Transmis au bureau du conseil', 'Trasmesso all’Ufficio'],
  [
    211,
    'Überwiesen an das Bundesgericht',
    'Transmis au Tribunal fédéral',
    'Trasmesso al Tribunale federale',
  ],
  [212, 'Überwiesen an die AB-BA', 'Transmis à l’AS-MPC', 'Trasmesso all’AV-MPC'],
  [
    215,
    'Berichterstattung zum Umsetzungsstand des Vorstosses liegt vor',
    'Le rapport sur l’état d’avancement de l’intervention est disponible',
    'Il rapporto sullo stato di attuazione dell’intervento è disponibile',
  ],
  [
    216,
    'Abschreibungsantrag liegt vor',
    'La proposition de classement est disponible',
    'Proposta di stralcio è disponibile',
  ],
  [
    218,
    'Bericht in Erfüllung des Vorstosses liegt vor',
    'Le rapport en réponse de l’intervention est disponible',
    'Il rapporto in adempimento dell’intervento è disponibile',
  ],
  [
    219,
    'Geplant für die Schlussabstimmung',
    'Planifié pour le vote final',
    'Pianificato per il voto finale',
  ],
  [
    220,
    'Zurückgewiesen an den Bundesrat',
    'Renvoyé au Conseil fédéral',
    'Rinviato al Consiglio federale',
  ],
  [
    221,
    'In Einigungskonferenz',
    'En conférence de conciliation',
    'Nella conferenza di unificazione',
  ],
  [
    222,
    'Mehrere Entwürfe in Beratung',
    'Plusieurs projets en délibération',
    'Diversi progetti in deliberazione',
  ],
  [
    223,
    'Vorprüfung - in Kommission des Nationalrates',
    'Examen préalable : en commission du Conseil national',
    'Esame preliminare - nella Commissione del Consiglio nazionale',
  ],
  [
    225,
    'Vorprüfung - in Kommission des Ständerates',
    'Examen préalable : en commission du Conseil des États',
    'Esame preliminare - nella Commissione del Consiglio degli Stati',
  ],
  [227, 'In beiden Kommissionen', 'Dans les deux commissions', 'Nelle due Commissioni'],
  [
    228,
    'In beiden Räten geplant',
    'Planifié dans les deux conseils',
    'Pianificato in entrambi i Consigli',
  ],
  [229, 'Erledigt', 'Liquidé', 'Liquidato'],
  [
    230,
    'Beratung in Kommission des Ständerates abgeschlossen',
    'Examen achevé par la commission du Conseil des États',
    'Fine delle discussioni della Commissione del degli Stati',
  ],
  [
    231,
    'Beratung in Kommission des Nationalrates abgeschlossen',
    'Examen achevé par la commission du Conseil national',
    'Fine delle discussioni della Commissione del Consiglio nazionale',
  ],
  [
    232,
    'In Vereinigter Bundesversammlung geplant',
    'Planifié à l’Assemblée fédérale (Chambres réunies)',
    'Pianificato nell’ Assemblea federale plenaria',
  ],
  [233, 'In Beratung', 'En délibération', 'In deliberazione'],
];

/** Complete dictionary snapshot, in numeric code order, without mapping legacy codes to current ones. */
export function statusCatalog(language: Language): ReferenceItem[] {
  const column = { de: 1, fr: 2, it: 3 } as const;
  return (
    [
      ['legacy', legacy],
      ['current', current],
    ] as const
  ).flatMap(([era, rows]) =>
    rows.map((row) => ({
      id: String(row[0]),
      code: String(row[0]),
      label: row[column[language]],
      era,
    })),
  );
}
