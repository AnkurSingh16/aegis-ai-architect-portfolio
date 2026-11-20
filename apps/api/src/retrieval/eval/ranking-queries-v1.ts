import { STOPWORDS } from './bm25.js';
import { largeCorpusDocuments } from './large-dev-corpus.js';

/**
 * Fifty new queries, one per corpus document, for docs/DEV-RETRIEVAL-RANKING-TEST-PROTOCOL.md. Written before any retrieval
 * was run on them. Same-author. Odd-numbered documents get a pure paraphrase that shares no content word with the target.
 * Even-numbered documents get an augmented query that contains one to three of the target's content words. Overlap is computed
 * from the text, not typed in. The 100 mixed queries and the paraphrases in large-dev-corpus.ts are not reused.
 */
export interface RankingQuery { readonly id: string; readonly target: string; readonly query: string; readonly kind: 'paraphrase' | 'augmented' }

export const rankingQueriesV1: readonly RankingQuery[] = [
  { id: 'R01', target: 'D01', kind: 'paraphrase', query: 'my total is off from the individual charges printed on what arrived each month' },
  { id: 'R02', target: 'D02', kind: 'augmented', query: 'I was charged twice, so please reverse the duplicate charge' },
  { id: 'R03', target: 'D03', kind: 'paraphrase', query: 'moving to a smaller subscription tier would only start from the following invoice period' },
  { id: 'R04', target: 'D04', kind: 'augmented', query: 'who approves my tax exemption paperwork' },
  { id: 'R05', target: 'D05', kind: 'paraphrase', query: "which day's exchange figure is applied to foreign money payments" },
  { id: 'R06', target: 'D06', kind: 'augmented', query: 'my locked account unlocks after the cooldown ends' },
  { id: 'R07', target: 'D07', kind: 'paraphrase', query: 'the group managing corporate login credentials replaces them on a timetable shared beforehand' },
  { id: 'R08', target: 'D08', kind: 'augmented', query: 'my session expires after inactivity' },
  { id: 'R09', target: 'D09', kind: 'paraphrase', query: 'programmatic access credentials can be cancelled by an administrator and it applies almost immediately' },
  { id: 'R10', target: 'D10', kind: 'augmented', query: 'emailed login links lapse ten minutes later' },
  { id: 'R11', target: 'D11', kind: 'paraphrase', query: 'parcels from the depot head out a couple of working shifts after payment, and the buyer gets a shipping notice' },
  { id: 'R12', target: 'D12', kind: 'augmented', query: 'a damaged delivery needs proof in the form of an image before replacing it' },
  { id: 'R13', target: 'D13', kind: 'paraphrase', query: 'a package abroad can be stopped by officials at the border and the buyer is told the case number' },
  { id: 'R14', target: 'D14', kind: 'augmented', query: 'I need to change my address, is it still possible before picking starts' },
  { id: 'R15', target: 'D15', kind: 'paraphrase', query: 'the present option is saved with the purchase and appears on the inside note of the box' },
  { id: 'R16', target: 'D16', kind: 'augmented', query: 'only signed packages can install firmware updates' },
  { id: 'R17', target: 'D17', kind: 'paraphrase', query: 'a device that bulges and gets hot should be unplugged and taken to an authorised repair shop' },
  { id: 'R18', target: 'D18', kind: 'augmented', query: 'is a screen with dead pixels covered by warranty' },
  { id: 'R19', target: 'D19', kind: 'paraphrase', query: 'linking a wireless earpiece needs a long press on the side key before a light starts blinking' },
  { id: 'R20', target: 'D20', kind: 'augmented', query: 'does a factory reset wipe my stored files' },
  { id: 'R21', target: 'D21', kind: 'paraphrase', query: 'I want a copy of everything the service holds about me once my details are checked' },
  { id: 'R22', target: 'D22', kind: 'augmented', query: 'after deleting my account, are transaction records still kept' },
  { id: 'R23', target: 'D23', kind: 'paraphrase', query: 'tracking preferences on sites are kept separately in each device and can be adjusted in the preferences menu' },
  { id: 'R24', target: 'D24', kind: 'augmented', query: "can an agent paste a customer's message into personal notes" },
  { id: 'R25', target: 'D25', kind: 'paraphrase', query: 'help desk uploads vanish eventually, except where a court order freezes them' },
  { id: 'R26', target: 'D26', kind: 'augmented', query: 'slow pages are compared with the latency dashboard first' },
  { id: 'R27', target: 'D27', kind: 'paraphrase', query: 'reports could be slow to appear while nightly bulk jobs process data for big organisations' },
  { id: 'R28', target: 'D28', kind: 'augmented', query: 'I hit rate limits, what should my client do' },
  { id: 'R29', target: 'D29', kind: 'paraphrase', query: 'recently loaded records are slow to appear in lookups for a while once a big load finishes' },
  { id: 'R30', target: 'D30', kind: 'augmented', query: 'when are the maintenance windows posted, and how far ahead' },
  { id: 'R31', target: 'D31', kind: 'paraphrase', query: 'the creator of the workspace can invite colleagues, but removing that creator needs a senior operator' },
  { id: 'R32', target: 'D32', kind: 'augmented', query: 'seats drop at renewal if licences sit unused' },
  { id: 'R33', target: 'D33', kind: 'paraphrase', query: 'joining two duplicate profiles needs approval from the holders and leaves a trace' },
  { id: 'R34', target: 'D34', kind: 'augmented', query: 'guest access ends on its own unless a sponsor extends it' },
  { id: 'R35', target: 'D35', kind: 'paraphrase', query: "a new permission level becomes active only once the user's login renews" },
  { id: 'R36', target: 'D36', kind: 'augmented', query: 'when do commanders post updates during an incident' },
  { id: 'R37', target: 'D37', kind: 'paraphrase', query: 'after an outage the review avoids naming individuals and looks at the underlying causes' },
  { id: 'R38', target: 'D38', kind: 'augmented', query: 'a notice reaches affected customers within the agreed time' },
  { id: 'R39', target: 'D39', kind: 'paraphrase', query: 'the most serious outages wake the person on duty straight away' },
  { id: 'R40', target: 'D40', kind: 'augmented', query: 'is there a workaround for the publicly posted problems' },
  { id: 'R41', target: 'D41', kind: 'paraphrase', query: 'what someone starting to run a company account should learn during their initial days' },
  { id: 'R42', target: 'D42', kind: 'augmented', query: 'the developer manual shows each route with sample calls and error codes' },
  { id: 'R43', target: 'D43', kind: 'paraphrase', query: "each version's update log groups modifications by kind and points to upgrade instructions" },
  { id: 'R44', target: 'D44', kind: 'augmented', query: 'my training certificate lapses after a year, and what refresher is needed' },
  { id: 'R45', target: 'D45', kind: 'paraphrase', query: 'discussion board replies get a fact check and then are flagged as the solution' },
  { id: 'R46', target: 'D46', kind: 'augmented', query: 'a revised agreement only applies once both parties have signed it' },
  { id: 'R47', target: 'D47', kind: 'paraphrase', query: 'regulators can inspect a permanent record of every administrative action taken' },
  { id: 'R48', target: 'D48', kind: 'augmented', query: "how do suppliers' security questionnaires get answered" },
  { id: 'R49', target: 'D49', kind: 'paraphrase', query: 'the product meets the standards for disabled users and outstanding issues come with fix deadlines' },
  { id: 'R50', target: 'D50', kind: 'augmented', query: 'can encryption be shipped to restricted countries' },
];

/** Lowercase alphanumeric tokens with stopwords removed, the same rule the benchmark uses. */
export function contentWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/** Number of distinct target content words that appear in the query. */
export function targetOverlap(query: string, targetText: string): number {
  const targetWords = new Set(contentWords(targetText));
  return new Set(contentWords(query).filter((word) => targetWords.has(word))).size;
}

export function targetTextFor(targetId: string): string {
  const document = largeCorpusDocuments.find((doc) => doc.id === targetId);
  if (!document) throw new Error(`unknown target ${targetId}`);
  return document.text;
}
