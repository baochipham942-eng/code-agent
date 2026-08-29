import type { ProviderDescriptor } from './providerDescriptor';

const GOOGLE_CALENDAR_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

function createGoogleCalendarOAuthDescriptor(
  clientId = process.env.NEO_GOOGLE_CALENDAR_OAUTH_CLIENT_ID?.trim() ?? '',
): ProviderDescriptor {
  return {
    id: 'google-calendar',
    displayName: 'Google Calendar',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId,
    scopes: {
      'calendar.events': GOOGLE_CALENDAR_EVENTS_SCOPE,
    },
    apiHosts: ['calendar.googleapis.com'],
    httpRequestScope: GOOGLE_CALENDAR_EVENTS_SCOPE,
    // Calendar-only is a product boundary. A future Gmail descriptor must be reviewed and shipped
    // separately instead of widening this connector by editing the requested scope string.
    allowedScopes: [GOOGLE_CALENDAR_EVENTS_SCOPE],
    extraAuthorizeParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
    redirect: { mode: 'loopback-random' },
    loopbackRedirectUriSupport: 'confirmed',
    requiresClientSecret: false,
    authMode: 'oauth',
  };
}

export const GOOGLE_CALENDAR_OAUTH_DESCRIPTOR = createGoogleCalendarOAuthDescriptor();
