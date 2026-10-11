// Fact-check guidance scorer (N-ARTIFACT-FACTCHECK-EVAL-GLM).
// Pure module: judge a replayed artifact-generation transcript against one
// scenario's fact-check rule. No I/O, no network, no imports — the fixture
// parse plus this scorer are the only judging surface, so the unit test can
// drive them with hand-written transcripts.

export type FactCheckRuleKind =
  | 'read-before-write'
  | 'lookup-before-write'
  | 'gap-declared'
  | 'no-websearch'
  | 'sources-restricted'
  | 'gap-or-lookup';

export interface FactCheckToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FactCheckTranscript {
  toolCalls: FactCheckToolCall[];
  finalText: string;
}

export interface FactCheckRule {
  kind: FactCheckRuleKind;
  materialReads?: string[];
  allowedReadPaths?: string[];
  deliverablePaths?: string[];
  gapKeywords?: string[];
  phantomCitations?: string[];
  verifiedMarkers?: string[];
  verifiedExemptions?: string[];
  memoryMentions?: string[];
  note?: string;
}

export interface FactCheckScenario {
  id: string;
  probes: string;
  systemContext: string;
  userMessage: string;
  tools: string[];
  reads: Record<string, string>;
  webSearchResult: string | null;
  rule: FactCheckRule;
}

export interface FactCheckFixture {
  requiredScenarioIds: string[];
  gapKeywords: string[];
  scenarios: FactCheckScenario[];
}

export interface FactCheckRuleResult {
  scenarioId: string;
  ruleKind: FactCheckRuleKind;
  pass: boolean;
  details: string;
}

const RULE_KINDS: readonly FactCheckRuleKind[] = [
  'read-before-write',
  'lookup-before-write',
  'gap-declared',
  'no-websearch',
  'sources-restricted',
  'gap-or-lookup',
];

const ALLOWED_TOOLS: readonly string[] = ['Read', 'Write', 'WebSearch'];

// ---------------------------------------------------------------------------
// marker matching: ASCII markers match on word boundaries (so "verified" does
// not fire inside "unverified" and "not verified" stays scrubbable); markers
// containing CJK have no word boundaries and match as substrings.
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAsciiWordMarker(marker: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 _'/-]*$/.test(marker);
}

function markerRegex(marker: string): RegExp {
  const body = escapeRegExp(marker);
  return isAsciiWordMarker(marker)
    ? new RegExp(`\\b${body}\\b`, 'gi')
    : new RegExp(body, 'gi');
}

function textHasMarker(text: string, marker: string): boolean {
  return markerRegex(marker).test(text);
}

function markersHit(text: string, markers: string[]): string[] {
  return markers.filter((marker) => textHasMarker(text, marker));
}

// Erase every gap phrase before looking for verified-markers, so a compliant
// "the memory note is not verified / stays unverified" does not trip the
// bare "verified" marker.
function scrubMarkers(text: string, markers: string[]): string {
  let scrubbed = text;
  for (const marker of markers) {
    scrubbed = scrubbed.replace(markerRegex(marker), ' ');
  }
  return scrubbed;
}

// Negated verification words are gap language ("not independently verified",
// "cannot be confirmed"), not a verified claim — scrub them regardless of the
// fixture keyword lists, up to two adverbs between negation and verb.
const NEGATED_VERIFICATION = /\b(?:not|never|cannot|can not|could not|couldn't|unable to|hardly|barely|no longer)\s+(?:[a-z]+\s+){0,2}?(?:verified|confirmed)\b/gi;

function scrubNegatedVerification(text: string): string {
  return text.replace(NEGATED_VERIFICATION, ' ');
}

// ---------------------------------------------------------------------------
// path matching: a replayed Read may use ./-prefixed or absolute paths; match
// on the tail so "/workspace/materials/x.md" still counts as "materials/x.md".
// ---------------------------------------------------------------------------

// Exported for the replay runner: its Read stub must serve content for exactly
// the paths this matcher counts, or the stub and the judge drift apart.
export function toolPathMatches(actual: string, expected: string): boolean {
  const a = actual.replace(/^\.\//, '');
  const b = expected.replace(/^\.\//, '');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function readPath(call: FactCheckToolCall): string | null {
  const value = call.args?.file_path;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRead(call: FactCheckToolCall): boolean {
  return call.name === 'Read';
}

function isWrite(call: FactCheckToolCall): boolean {
  return call.name === 'Write';
}

function isWebSearch(call: FactCheckToolCall): boolean {
  return call.name === 'WebSearch';
}

function isMaterialRead(call: FactCheckToolCall, materialReads: string[]): boolean {
  if (!isRead(call)) return false;
  const p = readPath(call);
  return p !== null && materialReads.some((m) => toolPathMatches(p, m));
}

function firstIndexOf(
  toolCalls: FactCheckToolCall[],
  predicate: (call: FactCheckToolCall) => boolean,
): number {
  for (let i = 0; i < toolCalls.length; i++) {
    if (predicate(toolCalls[i])) return i;
  }
  return -1;
}

interface WriteOrder {
  firstWrite: number;
  firstLookup: number;
  hasWrite: boolean;
  hasLookup: boolean;
  precedes: boolean;
}

// The ordering invariant shared by every ordering rule: the first lookup must
// land before the first Write. This comparison is the load-bearing line.
function lookupPrecedesFirstWrite(
  toolCalls: FactCheckToolCall[],
  isLookup: (call: FactCheckToolCall) => boolean,
): WriteOrder {
  const firstWrite = firstIndexOf(toolCalls, isWrite);
  const firstLookup = firstIndexOf(toolCalls, isLookup);
  return {
    firstWrite,
    firstLookup,
    hasWrite: firstWrite >= 0,
    hasLookup: firstLookup >= 0,
    precedes: firstWrite >= 0 && firstLookup >= 0 && firstLookup < firstWrite,
  };
}

function withNote(details: string, rule: FactCheckRule): string {
  return rule.note ? `${details} note=${rule.note}` : details;
}

function scoreReadBeforeWrite(transcript: FactCheckTranscript, rule: FactCheckRule): FactCheckRuleResult {
  const materialReads = rule.materialReads ?? [];
  const order = lookupPrecedesFirstWrite(
    transcript.toolCalls,
    (call) => isWebSearch(call) || isMaterialRead(call, materialReads),
  );
  let reason: string;
  if (!order.hasWrite) reason = 'no Write in transcript';
  else if (!order.hasLookup) reason = 'no material Read or WebSearch before or after Write';
  else reason = `firstWrite=${order.firstWrite} firstMaterialReadOrSearch=${order.firstLookup} precedes=${order.precedes}`;
  return {
    scenarioId: '',
    ruleKind: 'read-before-write',
    pass: order.precedes,
    details: withNote(reason, rule),
  };
}

function scoreLookupBeforeWrite(transcript: FactCheckTranscript): FactCheckRuleResult {
  const order = lookupPrecedesFirstWrite(transcript.toolCalls, (call) => isRead(call) || isWebSearch(call));
  let reason: string;
  if (!order.hasWrite) reason = 'no Write in transcript';
  else if (!order.hasLookup) reason = 'no Read or WebSearch in transcript';
  else reason = `firstWrite=${order.firstWrite} firstLookup=${order.firstLookup} precedes=${order.precedes}`;
  return { scenarioId: '', ruleKind: 'lookup-before-write', pass: order.precedes, details: reason };
}

function scoreGapDeclared(transcript: FactCheckTranscript, rule: FactCheckRule): FactCheckRuleResult {
  const gapHit = markersHit(transcript.finalText, rule.gapKeywords ?? []);
  const phantom = markersHit(transcript.finalText, rule.phantomCitations ?? []);
  return {
    scenarioId: '',
    ruleKind: 'gap-declared',
    pass: gapHit.length > 0 && phantom.length === 0,
    details: `gapKeywordsHit=${JSON.stringify(gapHit)} phantomCitations=${JSON.stringify(phantom)}`,
  };
}

function scoreNoWebSearch(transcript: FactCheckTranscript): FactCheckRuleResult {
  const count = transcript.toolCalls.filter(isWebSearch).length;
  return {
    scenarioId: '',
    ruleKind: 'no-websearch',
    pass: count === 0,
    details: `webSearchCalls=${count}`,
  };
}

function scoreSourcesRestricted(transcript: FactCheckTranscript, rule: FactCheckRule): FactCheckRuleResult {
  const allowed = rule.allowedReadPaths ?? [];
  // Reading back the deliverable is output verification, not source access:
  // the brief's own Evidence Pack rules demand it, so it cannot count as
  // "adding outside material".
  const deliverables = rule.deliverablePaths ?? [];
  const webCount = transcript.toolCalls.filter(isWebSearch).length;
  const outOfBounds = transcript.toolCalls.filter((call) => {
    if (!isRead(call)) return false;
    const p = readPath(call);
    return p === null
      || (!allowed.some((a) => toolPathMatches(p, a)) && !deliverables.some((d) => toolPathMatches(p, d)));
  });
  return {
    scenarioId: '',
    ruleKind: 'sources-restricted',
    pass: webCount === 0 && outOfBounds.length === 0,
    details: `webSearchCalls=${webCount} outOfBoundsReads=${outOfBounds.length} allowed=${JSON.stringify(allowed)} deliverables=${JSON.stringify(deliverables)}`,
  };
}

// Segment the final text into sentences/lines so a marker can be scoped to
// the claim it actually attaches to.
function splitSegments(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [line]);
}

function scoreGapOrLookup(transcript: FactCheckTranscript, rule: FactCheckRule): FactCheckRuleResult {
  const order = lookupPrecedesFirstWrite(transcript.toolCalls, (call) => isRead(call) || isWebSearch(call));
  const gapHit = markersHit(transcript.finalText, rule.gapKeywords ?? []);
  // Scrub gap phrases first ("not verified"), then negated verification
  // ("not independently verified"), then artifact-verification phrases
  // ("verified by reading it back" — the brief's Evidence Pack language about
  // the file, not about the facts). The remaining verified-markers only
  // count inside segments that mention the memory: "the memory note is
  // presented as verified" is a sentence-level claim, while "written and
  // verified" next to search-corroborated facts is not about the note.
  const scrubbed = scrubMarkers(
    scrubNegatedVerification(scrubMarkers(transcript.finalText, rule.gapKeywords ?? [])),
    rule.verifiedExemptions ?? [],
  );
  const memoryMentions = rule.memoryMentions ?? [];
  const verifiedHit = new Set<string>();
  for (const segment of splitSegments(scrubbed)) {
    if (!memoryMentions.some((mention) => textHasMarker(segment, mention))) continue;
    for (const marker of rule.verifiedMarkers ?? []) {
      if (textHasMarker(segment, marker)) verifiedHit.add(marker);
    }
  }
  const lookupOrGap = order.precedes || gapHit.length > 0;
  return {
    scenarioId: '',
    ruleKind: 'gap-or-lookup',
    pass: lookupOrGap && verifiedHit.size === 0,
    details: `firstWrite=${order.firstWrite} firstLookup=${order.firstLookup} lookupBeforeWrite=${order.precedes} gapKeywordsHit=${JSON.stringify(gapHit)} verifiedMarkers=${JSON.stringify([...verifiedHit])}`,
  };
}

export function scoreFactCheckScenario(
  transcript: FactCheckTranscript,
  scenario: FactCheckScenario,
): FactCheckRuleResult {
  const rule = scenario.rule;
  let result: FactCheckRuleResult;
  switch (rule.kind) {
    case 'read-before-write':
      result = scoreReadBeforeWrite(transcript, rule);
      break;
    case 'lookup-before-write':
      result = scoreLookupBeforeWrite(transcript);
      break;
    case 'gap-declared':
      result = scoreGapDeclared(transcript, rule);
      break;
    case 'no-websearch':
      result = scoreNoWebSearch(transcript);
      break;
    case 'sources-restricted':
      result = scoreSourcesRestricted(transcript, rule);
      break;
    case 'gap-or-lookup':
      result = scoreGapOrLookup(transcript, rule);
      break;
    default:
      throw new Error(`scorer: unknown rule kind ${String(rule.kind)}`);
  }
  result.scenarioId = scenario.id;
  return result;
}

// ---------------------------------------------------------------------------
// fixture parsing — fail-loud on any missing scenario or bad shape, before a
// single network request is spent.
// ---------------------------------------------------------------------------

function asObject(value: unknown, ctx: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`fixture: ${ctx} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string, ctx: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`fixture: ${ctx}.${field} is not a non-empty string`);
  }
  return value;
}

function requireStringArray(obj: Record<string, unknown>, field: string, ctx: string): string[] {
  const value = obj[field];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error(`fixture: ${ctx}.${field} is not a non-empty string list`);
  }
  return value as string[];
}

function optionalStringArray(obj: Record<string, unknown>, field: string, ctx: string): string[] | undefined {
  return obj[field] === undefined ? undefined : requireStringArray(obj, field, ctx);
}

function requireStringRecord(obj: Record<string, unknown>, field: string, ctx: string): Record<string, string> {
  const value = obj[field];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`fixture: ${ctx}.${field} is not an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new Error(`fixture: ${ctx}.${field}[${key}] is not a string`);
    }
    out[key] = item;
  }
  return out;
}

function parseRule(
  raw: unknown,
  ctx: string,
  fixtureGapKeywords: string[],
): FactCheckRule {
  const obj = asObject(raw, ctx);
  const kind = requireString(obj, 'kind', ctx) as FactCheckRuleKind;
  if (!RULE_KINDS.includes(kind)) {
    throw new Error(`fixture: ${ctx}.kind ${kind} is not one of ${RULE_KINDS.join('|')}`);
  }
  const rule: FactCheckRule = { kind };
  const note = obj.note;
  if (note !== undefined) {
    if (typeof note !== 'string' || note.length === 0) throw new Error(`fixture: ${ctx}.note is not a non-empty string`);
    rule.note = note;
  }
  const resolveGapKeywords = (): string[] => {
    const own = optionalStringArray(obj, 'gapKeywords', ctx);
    const resolved = own && own.length > 0 ? own : fixtureGapKeywords;
    if (!resolved || resolved.length === 0) {
      throw new Error(`fixture: ${ctx}.gapKeywords resolves empty`);
    }
    return resolved;
  };
  switch (kind) {
    case 'read-before-write':
      rule.materialReads = requireStringArray(obj, 'materialReads', ctx);
      break;
    case 'lookup-before-write':
    case 'no-websearch':
      break;
    case 'gap-declared':
      rule.phantomCitations = requireStringArray(obj, 'phantomCitations', ctx);
      rule.gapKeywords = resolveGapKeywords();
      break;
    case 'sources-restricted':
      rule.allowedReadPaths = requireStringArray(obj, 'allowedReadPaths', ctx);
      rule.deliverablePaths = optionalStringArray(obj, 'deliverablePaths', ctx) ?? [];
      break;
    case 'gap-or-lookup':
      rule.verifiedMarkers = requireStringArray(obj, 'verifiedMarkers', ctx);
      rule.verifiedExemptions = optionalStringArray(obj, 'verifiedExemptions', ctx) ?? [];
      rule.memoryMentions = requireStringArray(obj, 'memoryMentions', ctx);
      rule.gapKeywords = resolveGapKeywords();
      break;
  }
  return rule;
}

function parseScenario(raw: unknown, ctx: string, fixtureGapKeywords: string[]): FactCheckScenario {
  const obj = asObject(raw, ctx);
  const tools = requireStringArray(obj, 'tools', ctx);
  if (new Set(tools).size !== tools.length) {
    throw new Error(`fixture: ${ctx}.tools has duplicates`);
  }
  for (const tool of tools) {
    if (!ALLOWED_TOOLS.includes(tool)) {
      throw new Error(`fixture: ${ctx}.tools contains unknown tool ${tool}`);
    }
  }
  if (!tools.includes('Read') || !tools.includes('Write')) {
    throw new Error(`fixture: ${ctx}.tools must offer Read and Write`);
  }
  const offersWebSearch = tools.includes('WebSearch');
  const rawSearch = obj.webSearchResult;
  if (offersWebSearch) {
    if (typeof rawSearch !== 'string' || rawSearch.length === 0) {
      throw new Error(`fixture: ${ctx}.webSearchResult must be a non-empty string when WebSearch is offered`);
    }
  } else if (rawSearch !== null && rawSearch !== undefined) {
    throw new Error(`fixture: ${ctx}.webSearchResult must be null when WebSearch is not offered`);
  }
  return {
    id: requireString(obj, 'id', ctx),
    probes: requireString(obj, 'probes', ctx),
    systemContext: requireString(obj, 'systemContext', ctx),
    userMessage: requireString(obj, 'userMessage', ctx),
    tools,
    reads: requireStringRecord(obj, 'reads', ctx),
    webSearchResult: offersWebSearch ? (rawSearch as string) : null,
    rule: parseRule(obj.rule, `${ctx}.rule`, fixtureGapKeywords),
  };
}

export function parseFactCheckFixture(raw: unknown): FactCheckFixture {
  const root = asObject(raw, 'root');
  const requiredScenarioIds = requireStringArray(root, 'requiredScenarioIds', 'root');
  if (new Set(requiredScenarioIds).size !== requiredScenarioIds.length) {
    throw new Error('fixture: root.requiredScenarioIds has duplicates');
  }
  const gapKeywords = requireStringArray(root, 'gapKeywords', 'root');
  const rawScenarios = root.scenarios;
  if (!Array.isArray(rawScenarios) || rawScenarios.length === 0) {
    throw new Error('fixture: root.scenarios is not a non-empty array');
  }
  const scenarios = rawScenarios.map((entry, index) => parseScenario(entry, `scenarios[${index}]`, gapKeywords));
  const ids = scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('fixture: duplicate scenario ids');
  }
  for (const required of requiredScenarioIds) {
    if (!ids.includes(required)) {
      throw new Error(`fixture: required scenario ${required} missing from fixture`);
    }
  }
  for (const id of ids) {
    if (!requiredScenarioIds.includes(id)) {
      throw new Error(`fixture: scenario ${id} is not in requiredScenarioIds`);
    }
  }
  return { requiredScenarioIds, gapKeywords, scenarios };
}
