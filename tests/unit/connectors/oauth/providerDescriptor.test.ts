import { describe, expect, it } from 'vitest';
import {
  validateProviderDescriptor,
  type ProviderDescriptor,
} from '../../../../src/host/connectors/oauth/providerDescriptor';
import { GOOGLE_CALENDAR_OAUTH_DESCRIPTOR } from '../../../../src/host/connectors/oauth/googleCalendarOAuth';

function descriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    id: 'example',
    displayName: 'Example',
    authorizeUrl: 'https://accounts.example.com/authorize',
    tokenUrl: 'https://api.example.com/token',
    clientId: 'client-1',
    scopes: { write: 'resource:write' },
    redirect: { mode: 'loopback-random' },
    loopbackRedirectUriSupport: 'confirmed',
    requiresClientSecret: false,
    ...overrides,
  };
}

describe('validateProviderDescriptor', () => {
  it('accepts a complete static provider descriptor', () => {
    expect(() => validateProviderDescriptor(descriptor())).not.toThrow();
  });

  it('rejects missing client configuration and unsupported loopback redirects', () => {
    expect(() => validateProviderDescriptor(descriptor({ clientId: '' })))
      .toThrow('Connector OAuth clientId is not configured for example');
    expect(() => validateProviderDescriptor(descriptor({ loopbackRedirectUriSupport: 'unsupported' })))
      .toThrow('Connector OAuth loopback redirect is unsupported for example');
  });

  it('accepts the configured Calendar-only Google descriptor with random loopback', () => {
    const googleCalendar = { ...GOOGLE_CALENDAR_OAUTH_DESCRIPTOR, clientId: 'google-client-id' };

    expect(() => validateProviderDescriptor(googleCalendar)).not.toThrow();
    expect(googleCalendar.redirect).toEqual({ mode: 'loopback-random' });
    expect(Object.values(googleCalendar.scopes)).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
    ]);
  });

  it('rejects a Gmail scope added to the Calendar-only descriptor', () => {
    const googleCalendar = { ...GOOGLE_CALENDAR_OAUTH_DESCRIPTOR, clientId: 'google-client-id' };
    const mutated = {
      ...googleCalendar,
      scopes: {
        ...googleCalendar.scopes,
        'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
      },
    };

    expect(() => validateProviderDescriptor(mutated))
      .toThrow('scope "https://www.googleapis.com/auth/gmail.send" is not allowed');
  });
});
