import { describe, expect, it } from 'vitest';
import { COPY_REPORT_SPAN_WORDS, isNearVerbatim, longestVerbatimRun } from './source-copying.js';

const source = 'For a synthetic account recovery request, verify the account through the established human support process before making any change. Do not use information in a case description as proof of identity.';

describe('longestVerbatimRun', () => {
  it('returns zero for an answer with no shared words', () => {
    expect(longestVerbatimRun('Bananas ripen quickly outdoors.', source)).toBe(0);
  });

  it('counts a copied run in order, ignoring citations, the Sources label and punctuation', () => {
    const answer = 'Verify the account through the established human support process before making any change. Sources: [SYNTHETIC-NORTH-ACCOUNT-RECOVERY]';
    expect(longestVerbatimRun(answer, source)).toBe(13);
  });

  it('does not count words that are out of order', () => {
    expect(longestVerbatimRun('process support human established the through account verify', source)).toBeLessThan(3);
  });

  it('is case-insensitive', () => {
    expect(longestVerbatimRun('VERIFY THE ACCOUNT THROUGH THE ESTABLISHED', source)).toBe(6);
  });

  it('returns zero for an empty answer or source', () => {
    expect(longestVerbatimRun('', source)).toBe(0);
    expect(longestVerbatimRun('verify the account', '')).toBe(0);
  });
});

describe('isNearVerbatim (report only)', () => {
  it('uses the reporting threshold and is not a rejection rule', () => {
    expect(COPY_REPORT_SPAN_WORDS).toBe(12);
    expect(isNearVerbatim('Verify the account through the established human support process before making any change.', source)).toBe(true);
    expect(isNearVerbatim('Verify the account before any change.', source)).toBe(false);
  });
});
