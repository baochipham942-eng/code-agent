// ============================================================================
// OpenchronicleContextFilter — drop sensitive captures before injection
//
// OC daemon captures EVERYTHING in foreground (incl. password fields, bank
// pages, private chats). The daemon trusts the user; the *injection path*
// into LLM context is where we apply the privacy filter, because that's where
// captured content leaves the local machine (sent to Claude / GLM / etc).
// ============================================================================

import type { OpenchronicleSettings } from '../../../shared/contract/openchronicle';

interface CaptureLike {
  app_name?: string;
  window_title?: string;
  url?: string;
  focused_role?: string;
}

// AX role for password fields — content is masked already by macOS, but the
// metadata (window title, URL) can still leak which bank / login flow it was.
const SECURE_ROLES = new Set(['AXSecureTextField']);

// ---------------------------------------------------------------------------
// Glob → RegExp (one-shot, no caching since blacklists are tiny)
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map(globToRegex);
}

// ---------------------------------------------------------------------------
// Single-capture predicate
// ---------------------------------------------------------------------------

export interface CompiledFilter {
  appNames: Set<string>;
  urlRegexes: RegExp[];
}

export function compileFilter(settings: OpenchronicleSettings): CompiledFilter {
  return {
    appNames: new Set(settings.blacklistApps.map((s) => s.toLowerCase())),
    urlRegexes: compilePatterns(settings.blacklistUrlPatterns),
  };
}

export function isBlacklisted(capture: CaptureLike, filter: CompiledFilter): boolean {
  // Secure text fields → drop entirely
  if (capture.focused_role && SECURE_ROLES.has(capture.focused_role)) {
    return true;
  }

  // App name substring match (case-insensitive)
  if (capture.app_name) {
    const lower = capture.app_name.toLowerCase();
    for (const banned of filter.appNames) {
      if (lower.includes(banned)) return true;
    }
  }

  // URL pattern match
  if (capture.url) {
    const url = capture.url;
    for (const re of filter.urlRegexes) {
      if (re.test(url)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Bulk filtering helpers
// ---------------------------------------------------------------------------

export function filterCaptures<T extends CaptureLike>(
  captures: T[] | undefined,
  filter: CompiledFilter,
): T[] {
  if (!captures) return [];
  return captures.filter((c) => !isBlacklisted(c, filter));
}
