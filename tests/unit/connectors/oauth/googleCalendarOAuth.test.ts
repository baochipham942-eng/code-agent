import { describe, expect, it } from 'vitest';
import {
  getGoogleCalendarOAuthClientSecret,
  GOOGLE_CALENDAR_OAUTH_DESCRIPTOR,
} from '../../../../src/host/connectors/oauth/googleCalendarOAuth';

describe('Google Calendar OAuth credentials', () => {
  it('declares that token exchange requires a client secret', () => {
    expect(GOOGLE_CALENDAR_OAUTH_DESCRIPTOR.requiresClientSecret).toBe(true);
    expect(GOOGLE_CALENDAR_OAUTH_DESCRIPTOR.clientSecret).toBeUndefined();
  });

  it('reads and trims the injected secret without putting it on the descriptor', () => {
    expect(getGoogleCalendarOAuthClientSecret({
      NEO_GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: '  test-secret  ',
    })).toBe('test-secret');
    expect(getGoogleCalendarOAuthClientSecret({})).toBeUndefined();
  });
});
