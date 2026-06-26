import { describe, expect, it } from 'vitest';
import { getPostHogDistinctId } from '../../../src/host/observability/posthogNode';

describe('PostHog Node privacy helpers', () => {
  it('derives a stable distinct_id without exposing the raw user id', () => {
    const rawUserId = '00000000-0000-4000-8000-000000000001';
    const distinctId = getPostHogDistinctId(rawUserId);

    expect(distinctId).toBe(getPostHogDistinctId(rawUserId));
    expect(distinctId).toMatch(/^user_[a-f0-9]{32}$/);
    expect(distinctId).not.toContain(rawUserId);
  });
});
