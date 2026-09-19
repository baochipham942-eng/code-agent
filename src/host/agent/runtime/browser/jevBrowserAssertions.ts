// ============================================================================
// Jev browser step assertions — rule extraction + page evidence (no model)
// ============================================================================

type JevAssertionKind =
  | 'url_includes'
  | 'url_equals'
  | 'title_includes'
  | 'heading_includes'
  | 'element_text_includes'
  | 'form_value_equals'
  | 'element_exists'
  | 'download_artifact_present'
  | 'url_not_includes';

export interface JevPageAssertion {
  id: string;
  kind: JevAssertionKind;
  needle: string;
  role?: string;
  name?: string;
  selectorHint?: string;
  /** Self-extracted navigate-target url_includes. Does not participate in allMet. */
  precondition?: boolean;
}

export interface JevAssertionEvidence {
  url: string;
  title: string;
  headings: Array<{ text: string }>;
  elements: Array<{
    text: string;
    ariaLabel?: string | null;
    name?: string;
    placeholder?: string | null;
    role?: string | null;
    selectorHint?: string;
  }>;
  formValues: Record<string, string>;
  downloads: Array<{ name: string; sha256: string }>;
}

const URL_RE = /https?:\/\/[^\s<>"'`)]+/gi;
const QUOTE_RE = /[“”«»『』「」]([^“”«»『』「」]{1,80})[“”«»『』「」]|"([^"]{1,80})"|'([^']{1,80})'|‘([^’]{1,80})’/g;
const PATH_RE = /(?:^|[\s,;:（(])(\/[\w\-./]+)(?=$|[\s,;:)）])/g;

const JEV_ASSERTION_KINDS: readonly JevAssertionKind[] = [
  'url_includes',
  'url_equals',
  'title_includes',
  'heading_includes',
  'element_text_includes',
  'form_value_equals',
  'element_exists',
  'download_artifact_present',
  'url_not_includes',
];

function isAssertionKind(value: unknown): value is JevAssertionKind {
  return typeof value === 'string' && (JEV_ASSERTION_KINDS as readonly string[]).includes(value);
}

function needleRequired(kind: JevAssertionKind): boolean {
  return kind !== 'element_exists';
}

function hasElementExistsLocator(candidate: {
  role?: unknown;
  name?: unknown;
  selectorHint?: unknown;
}): boolean {
  const selector = typeof candidate.selectorHint === 'string' ? candidate.selectorHint.trim() : '';
  if (selector) return true;
  const role = typeof candidate.role === 'string' ? candidate.role.trim() : '';
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  return Boolean(role && name);
}

function quotedActionPrecondition(prefix: string): boolean {
  return /点|点击|click|按|提交|submit/i.test(prefix);
}

function normalize(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

function includesInsensitive(hay: unknown, needle: unknown): boolean {
  return normalize(hay).includes(normalize(needle));
}

function traceDroppedAssertion(reason: string, index: number, kind: unknown): void {
  console.warn(`[jevBrowserAssertions] drop assertion: ${reason} index=${index} kind=${String(kind)}`);
}

function sanitizeOverrideAssertion(raw: unknown, index: number): JevPageAssertion | null {
  if (!raw || typeof raw !== 'object') {
    traceDroppedAssertion('not an object', index, undefined);
    return null;
  }
  const candidate = raw as {
    id?: unknown;
    kind?: unknown;
    needle?: unknown;
    role?: unknown;
    name?: unknown;
    selectorHint?: unknown;
  };
  if (!isAssertionKind(candidate.kind)) {
    traceDroppedAssertion('kind not in whitelist', index, candidate.kind);
    return null;
  }
  const trimmedNeedle = typeof candidate.needle === 'string' ? candidate.needle.trim() : '';
  if (needleRequired(candidate.kind) && typeof candidate.needle !== 'string') {
    traceDroppedAssertion('needle missing', index, candidate.kind);
    return null;
  }
  if (needleRequired(candidate.kind) && !trimmedNeedle) {
    traceDroppedAssertion('needle empty', index, candidate.kind);
    return null;
  }
  if (candidate.kind === 'element_exists' && !hasElementExistsLocator(candidate)) {
    traceDroppedAssertion('element_exists without locator', index, candidate.kind);
    return null;
  }
  const assertion: JevPageAssertion = {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : `a${index + 1}`,
    kind: candidate.kind,
    needle: trimmedNeedle,
  };
  if (typeof candidate.role === 'string') assertion.role = candidate.role;
  if (typeof candidate.name === 'string') assertion.name = candidate.name;
  if (typeof candidate.selectorHint === 'string') assertion.selectorHint = candidate.selectorHint;
  return assertion;
}

function stripUrlQuerySecrets(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    return `${url.origin}${url.pathname}`.replace(/\/$/, '') || url.origin;
  } catch {
    return raw.split(/[?#]/)[0];
  }
}

function looksLikePath(value: string): boolean {
  if (value.length < 2 || value.length > 80) return false;
  if (!value.startsWith('/')) return false;
  if (value === '/') return false;
  return /[a-z]/i.test(value);
}

function sameOriginAndPath(left: string, right: string): boolean {
  try {
    const a = new URL(stripUrlQuerySecrets(left));
    const b = new URL(stripUrlQuerySecrets(right));
    return a.origin.toLowerCase() === b.origin.toLowerCase()
      && a.pathname.replace(/\/$/, '').toLowerCase() === b.pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return stripUrlQuerySecrets(left).toLowerCase() === stripUrlQuerySecrets(right).toLowerCase();
  }
}

export function extractJevAssertions(
  task: string,
  override?: Array<JevPageAssertion | Record<string, unknown>>,
): JevPageAssertion[] {
  if (override && override.length > 0) {
    const kept: JevPageAssertion[] = [];
    override.forEach((assertion, index) => {
      const sanitized = sanitizeOverrideAssertion(assertion, index);
      if (sanitized) kept.push(sanitized);
    });
    return kept;
  }

  const found: JevPageAssertion[] = [];
  const seen = new Set<string>();
  const add = (kind: JevAssertionKind, needle: string, precondition = false) => {
    const trimmed = needle.trim();
    if (!trimmed) return;
    const key = `${kind}:${normalize(trimmed)}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({
      id: `a${found.length + 1}`,
      kind,
      needle: trimmed,
      ...(precondition ? { precondition: true } : {}),
    });
  };

  const taskUrls = task.match(URL_RE) || [];
  const navigateTarget = taskUrls[0] ? stripUrlQuerySecrets(taskUrls[0]) : null;
  for (const match of taskUrls) {
    const needle = stripUrlQuerySecrets(match);
    const precondition = Boolean(navigateTarget && sameOriginAndPath(needle, navigateTarget));
    add('url_includes', needle, precondition);
  }

  QUOTE_RE.lastIndex = 0;
  let quoted: RegExpExecArray | null = QUOTE_RE.exec(task);
  while (quoted) {
    const fragment = quoted[1] || quoted[2] || quoted[3] || quoted[4] || '';
    const prefix = task.slice(Math.max(0, quoted.index - 12), quoted.index);
    if (/title|标题/i.test(prefix)) add('title_includes', fragment);
    else add('element_text_includes', fragment, quotedActionPrecondition(prefix));
    quoted = QUOTE_RE.exec(task);
  }

  PATH_RE.lastIndex = 0;
  let pathMatch: RegExpExecArray | null = PATH_RE.exec(task);
  while (pathMatch) {
    const path = pathMatch[1];
    const fromTaskUrl = taskUrls.some((url) => url.includes(path));
    if (looksLikePath(path) && !fromTaskUrl) add('url_includes', path);
    pathMatch = PATH_RE.exec(task);
  }

  return found;
}

export function evaluateJevAssertions(
  assertions: JevPageAssertion[],
  evidence: JevAssertionEvidence,
): { allMet: boolean; results: Array<JevPageAssertion & { met: boolean }> } {
  const results = assertions.map((assertion) => ({
    ...assertion,
    met: matchAssertion(assertion, evidence),
  }));
  const goal = results.filter((result) => !result.precondition);
  return {
    allMet: goal.length > 0 && goal.every((result) => result.met),
    results,
  };
}

function matchAssertion(assertion: JevPageAssertion, evidence: JevAssertionEvidence): boolean {
  switch (assertion.kind) {
    case 'url_includes':
      return includesInsensitive(evidence.url, assertion.needle);
    case 'url_equals':
      return normalize(stripUrlQuerySecrets(evidence.url)) === normalize(stripUrlQuerySecrets(assertion.needle));
    case 'url_not_includes':
      return !includesInsensitive(evidence.url, assertion.needle);
    case 'title_includes':
      return includesInsensitive(evidence.title, assertion.needle);
    case 'heading_includes':
      return evidence.headings.some((heading) => includesInsensitive(heading.text, assertion.needle));
    case 'element_text_includes':
      return evidence.elements.some((element) => (
        includesInsensitive(element.text || '', assertion.needle)
        || includesInsensitive(element.ariaLabel || '', assertion.needle)
        || includesInsensitive(element.name || '', assertion.needle)
        || includesInsensitive(element.placeholder || '', assertion.needle)
      ));
    case 'form_value_equals':
      return Object.values(evidence.formValues).some((value) => normalize(value) === normalize(assertion.needle));
    case 'element_exists':
      return evidence.elements.some((element) => {
        if (assertion.selectorHint && element.selectorHint === assertion.selectorHint) return true;
        if (assertion.role && assertion.name) {
          return (element.role || '') === assertion.role && includesInsensitive(element.name || element.text, assertion.name);
        }
        return false;
      });
    case 'download_artifact_present':
      return evidence.downloads.some((artifact) => (
        includesInsensitive(artifact.name, assertion.needle)
        || normalize(artifact.sha256) === normalize(assertion.needle)
      ));
    default:
      return false;
  }
}

export function pageFingerprint(evidence: JevAssertionEvidence, inViewNames: string[]): string {
  const form = Object.entries(evidence.formValues)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(';');
  return [
    evidence.url,
    evidence.title,
    [...inViewNames].sort().join(','),
    form,
  ].join('|');
}
