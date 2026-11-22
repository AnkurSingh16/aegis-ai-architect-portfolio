import { describe, expect, it } from 'vitest';
import { boundedMessageReason, boundedOutcome } from './telemetry.js';

describe('P5 metric labels are bounded', () => {
  it('maps unknown outcomes and reasons to other, so identifiers and free text never become label values', () => {
    expect(boundedOutcome('delivered')).toBe('delivered');
    expect(boundedOutcome('019f3c2e-0000-4000-8000-000000000000')).toBe('other');
    expect(boundedMessageReason('peer_identity_refused')).toBe('peer_identity_refused');
    expect(boundedMessageReason('payload contains a secret')).toBe('other');
    expect(boundedMessageReason(null)).toBe('none');
  });
});
