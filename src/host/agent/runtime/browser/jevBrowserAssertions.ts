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

function normalize(value: string): string {
  return value.toLowerCase();
}

function includesInsensitive(hay: string, needle: string): boolean {
  return normalize(hay).includes(normalize(needle));
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

export function extractJevAssertions(
  task: string,
  override?: JevPageAssertion[],
): JevPageAssertion[] {
  if (override && override.length > 0) {
    return override.map((assertion, index) => ({
      ...assertion,
      id: assertion.id || `a${index + 1}`,
    }));
  }

  const found: JevPageAssertion[] = [];
  const seen = new Set<string>();
  const add = (kind: JevAssertionKind, needle: string) => {
    const trimmed = needle.trim();
    if (!trimmed) return;
    const key = `${kind}:${normalize(trimmed)}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ id: `a${found.length + 1}`, kind, needle: trimmed });
  };

  for (const match of task.match(URL_RE) || []) {
    add('url_includes', stripUrlQuerySecrets(match));
  }

  QUOTE_RE.lastIndex = 0;
  let quoted: RegExpExecArray | null = QUOTE_RE.exec(task);
  while (quoted) {
    const fragment = quoted[1] || quoted[2] || quoted[3] || quoted[4] || '';
    const prefix = task.slice(Math.max(0, quoted.index - 12), quoted.index);
    if (/title|标题/i.test(prefix)) add('title_includes', fragment);
    else add('element_text_includes', fragment);
    quoted = QUOTE_RE.exec(task);
  }

  PATH_RE.lastIndex = 0;
  let pathMatch: RegExpExecArray | null = PATH_RE.exec(task);
  while (pathMatch) {
    const path = pathMatch[1];
    if (looksLikePath(path)) add('url_includes', path);
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
  return {
    allMet: assertions.length > 0 && results.every((result) => result.met),
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
