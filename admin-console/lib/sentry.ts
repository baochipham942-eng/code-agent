export type SentryIssueSummary = {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  level: string | null;
  status: string | null;
  count: string | null;
  userCount: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  permalink: string;
  projectSlug: string | null;
};

export type SentrySessionLookup = {
  searchUrl: string | null;
  issues: SentryIssueSummary[];
  error: string | null;
  isConfigured: boolean;
  canFetch: boolean;
};

const DEFAULT_SENTRY_BASE_URL = 'https://sentry.io';

export async function getSentryIssuesForSession(
  sessionId: string,
  limit = 5,
): Promise<SentrySessionLookup> {
  const orgSlug = process.env.SENTRY_ORG_SLUG?.trim();
  const authToken = process.env.SENTRY_AUTH_TOKEN?.trim();
  const projectId = process.env.SENTRY_PROJECT_ID?.trim();
  const searchUrl = orgSlug ? buildSentryIssueSearchUrl(sessionId, orgSlug, projectId) : null;

  if (!orgSlug) {
    return {
      searchUrl,
      issues: [],
      error: 'missing SENTRY_ORG_SLUG',
      isConfigured: false,
      canFetch: false,
    };
  }

  if (!authToken) {
    return {
      searchUrl,
      issues: [],
      error: 'missing SENTRY_AUTH_TOKEN',
      isConfigured: true,
      canFetch: false,
    };
  }

  const apiUrl = buildSentryIssuesApiUrl(sessionId, orgSlug, projectId, limit);
  try {
    const response = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      return {
        searchUrl,
        issues: [],
        error: `Sentry API ${response.status}`,
        isConfigured: true,
        canFetch: true,
      };
    }

    const payload: unknown = await response.json();
    const rows = Array.isArray(payload) ? payload : [];
    return {
      searchUrl,
      issues: rows.map(toIssueSummary).filter((item): item is SentryIssueSummary => Boolean(item)),
      error: null,
      isConfigured: true,
      canFetch: true,
    };
  } catch (error) {
    return {
      searchUrl,
      issues: [],
      error: error instanceof Error ? error.message : 'Sentry API request failed',
      isConfigured: true,
      canFetch: true,
    };
  }
}

function buildSentryIssuesApiUrl(
  sessionId: string,
  orgSlug: string,
  projectId: string | undefined,
  limit: number,
): string {
  const baseUrl = process.env.SENTRY_API_BASE_URL?.trim() || DEFAULT_SENTRY_BASE_URL;
  const url = new URL(`/api/0/organizations/${encodeURIComponent(orgSlug)}/issues/`, baseUrl);
  url.searchParams.set('query', buildSessionSearchQuery(sessionId));
  url.searchParams.set('sort', 'date');
  url.searchParams.set('limit', String(limit));
  if (projectId) url.searchParams.append('project', projectId);
  return url.toString();
}

function buildSentryIssueSearchUrl(
  sessionId: string,
  orgSlug: string,
  projectId: string | undefined,
): string {
  const baseUrl = process.env.SENTRY_WEB_BASE_URL?.trim()
    || process.env.SENTRY_API_BASE_URL?.trim()
    || DEFAULT_SENTRY_BASE_URL;
  const url = new URL(`/organizations/${encodeURIComponent(orgSlug)}/issues/`, baseUrl);
  url.searchParams.set('query', buildSessionSearchQuery(sessionId));
  if (projectId) url.searchParams.set('project', projectId);
  return url.toString();
}

function buildSessionSearchQuery(sessionId: string): string {
  return `sessionId:"${sessionId.replaceAll('"', '\\"')}"`;
}

function toIssueSummary(value: unknown): SentryIssueSummary | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = readString(row.id);
  const title = readString(row.title);
  if (!id || !title) return null;

  return {
    id,
    shortId: readString(row.shortId) ?? id,
    title,
    culprit: readString(row.culprit),
    level: readString(row.level),
    status: readString(row.status),
    count: readString(row.count),
    userCount: readNumber(row.userCount),
    firstSeen: readString(row.firstSeen),
    lastSeen: readString(row.lastSeen),
    permalink: readString(row.permalink) ?? buildFallbackIssueUrl(id),
    projectSlug: readProjectSlug(row.project),
  };
}

function buildFallbackIssueUrl(issueId: string): string {
  const baseUrl = process.env.SENTRY_WEB_BASE_URL?.trim()
    || process.env.SENTRY_API_BASE_URL?.trim()
    || DEFAULT_SENTRY_BASE_URL;
  const orgSlug = process.env.SENTRY_ORG_SLUG?.trim();
  if (!orgSlug) return baseUrl;
  return new URL(`/organizations/${encodeURIComponent(orgSlug)}/issues/${issueId}/`, baseUrl).toString();
}

function readProjectSlug(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  return readString((value as Record<string, unknown>).slug);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
