/**
 * In-repo testable copy of the Neo/Grok inspect follow-up stitch.
 * Mirrors `scripts/inspect/neo_five_case.py` `_invocation_tail` (line 211)
 * and `_forward_bridged_invocations` (line 352). Change one, change the other.
 *
 * Intentional shape differences vs Python (not bugs):
 * 1. Empty generation returns the seeded state. Python's no-model-call leaves
 *    the forwarded AgentState (history still present). The TS fixture uses []
 *    for that case; treating [] as "no history" would mis-fire the history gate.
 * 2. isFollowUp is `index>0 || countAssistants(state)>0`. Python only uses
 *    `index>0`. Tests seed turn-1 as `initial` and pass the follow-up as
 *    invocations[0]; the assistant-count disjunct walks them into the
 *    follow-up branch.
 * 3. Same-tail equality is skipped when there is no previous assistant
 *    (`previous && ...`). Python compares against previous_text="" and can
 *    enter that branch. Follow-up with empty state is not a production path
 *    (index>0 implies the first invocation already ran).
 */
export type BridgeMode = 'fresh-per-invocation' | 'shared-bridge';

export interface TraceToolCall {
  id: string;
  function: string;
  arguments: unknown;
}

export interface TraceMessage {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: TraceToolCall[];
  toolCallId?: string;
  function?: string;
  error?: string | null;
}

export interface AssertionContext {
  toolExecutions: Array<{
    tool: string;
    input: unknown;
    output: string;
    success: boolean;
    error?: string;
    duration: number;
    timestamp: number;
  }>;
  responses: string[];
  errors: string[];
  turnCount: number;
  trace: Array<Record<string, unknown>>;
}

class TraceHealthError extends Error {
  override readonly name = 'RuntimeError';

  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export function countAssistants(messages: TraceMessage[]): number {
  return messages.filter((message) => message.role === 'assistant').length;
}

function assertInvocationGrew(before: number, after: number, invocation: number): void {
  if (after <= before) {
    throw new TraceHealthError(
      `inspect trace health failed at invocation ${invocation}: assistant count ${before} -> ${after} (expected strict growth)`,
    );
  }
}

function assertFollowUpComplete(
  final: number,
  baseline: number,
  followUps: string[],
): void {
  const required = baseline + followUps.length;
  if (final < required) {
    throw new TraceHealthError(
      `inspect trace health failed after follow-ups: assistant count ${final} < ${required} (baseline ${baseline} + ${followUps.length} follow-ups)`,
    );
  }
}

export function scorerTraceHealth(
  followUpPromptsSent: string[],
  turnCount: number,
  firstInvocationAssistantCount?: number,
): 'ok' | 'broken' {
  if (followUpPromptsSent.length === 0) return 'ok';
  if (typeof firstInvocationAssistantCount !== 'number') return 'ok';
  const required = firstInvocationAssistantCount + followUpPromptsSent.length;
  return turnCount < required ? 'broken' : 'ok';
}

function fingerprint(messages: TraceMessage[]): string {
  return JSON.stringify(messages);
}

function prefixEquals(inFlight: TraceMessage[], reconstructed: TraceMessage[]): boolean {
  if (reconstructed.length < inFlight.length) return false;
  return fingerprint(reconstructed.slice(0, inFlight.length)) === fingerprint(inFlight);
}

export function injectPrefixByte(messages: TraceMessage[]): TraceMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  return [
    ...messages.slice(0, -1),
    { ...last, text: `${last.text ?? ''}\0` },
  ];
}

function lastAssistant(messages: TraceMessage[]): TraceMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') return messages[index];
  }
  return undefined;
}

function followUpRequestHasHistory(messages: TraceMessage[]): boolean {
  let lastUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role === 'user') lastUser = index;
  }
  const prefix = lastUser >= 0 ? messages.slice(0, lastUser) : [];
  if (prefix.some((message) => message.role === 'tool')) return true;
  return countAssistants(prefix) >= 1;
}

function assertFollowUpCarriedHistory(
  messages: TraceMessage[],
  invocation: number,
): void {
  if (!followUpRequestHasHistory(messages)) {
    throw new TraceHealthError(
      `inspect trace health failed at invocation ${invocation}: follow-up request did not carry first-turn history`,
    );
  }
}

function messageFingerprint(message: TraceMessage): string {
  return JSON.stringify([message.role, (message.text ?? '').trim()]);
}

/** New messages from this invocation. Mirrors neo_five_case.py:_invocation_tail. */
function invocationTail(
  adopted: TraceMessage[],
  forwarded: TraceMessage[],
): TraceMessage[] {
  const forwardedFps = forwarded.map(messageFingerprint);
  const adoptedFps = adopted.map(messageFingerprint);
  let lcp = 0;
  const limit = Math.min(forwardedFps.length, adoptedFps.length);
  while (lcp < limit && forwardedFps[lcp] === adoptedFps[lcp]) {
    lcp += 1;
  }
  if (lcp === forwarded.length) return adopted.slice(lcp);
  let lastUser = -1;
  for (let index = 0; index < adopted.length; index += 1) {
    if (adopted[index].role === 'user') lastUser = index;
  }
  if (lastUser >= 0) return adopted.slice(lastUser + 1);
  return adopted.slice(lcp);
}

/**
 * Model inspect_ai `_track_state` plus the solver follow-up stitch.
 * Fresh bridge first invocation: the first observed generation replaces
 * `state.messages`. Follow-up: the generation (this round's model-event
 * input) must carry first-turn history or we raise before stitch — a
 * 1-assistant first turn plus a 2-assistant tool follow-up cannot pass
 * on count growth after a full replace. With history, append this
 * invocation's full new tail (tool-call assistant + tool + answer) onto
 * the forwarded first-turn trace — Neo restore merges tool-call+answer
 * into one assistant, so replacing would drop turn_count. Same-tail (no
 * new answer) still replaces, then the health assertion fails closed.
 * Empty generation means no model call; seeded state stays. Shared
 * bridge: continuation must be a byte-level prefix of the in-flight
 * thread; otherwise the generation is parked and never promoted.
 */
function adoptInvocation(options: {
  mode: BridgeMode;
  state: TraceMessage[];
  generation: TraceMessage[];
  reconstructedPrefix?: TraceMessage[];
  invocationIndex?: number;
}): TraceMessage[] {
  if (options.mode === 'fresh-per-invocation') {
    if (options.generation.length === 0) return options.state;
    const isFollowUp = (options.invocationIndex ?? 0) > 0 || countAssistants(options.state) > 0;
    if (!isFollowUp) return options.generation;
    assertFollowUpCarriedHistory(options.generation, options.invocationIndex ?? 0);
    const last = lastAssistant(options.generation);
    const previous = lastAssistant(options.state);
    if (!last || (previous && (last.text ?? '').trim() === (previous.text ?? '').trim())) {
      return options.generation;
    }
    return [...options.state, ...invocationTail(options.generation, options.state)];
  }
  const reconstructed = options.reconstructedPrefix ?? options.state;
  if (prefixEquals(options.state, reconstructed)) {
    return [...options.state, ...options.generation];
  }
  return options.state;
}

export function forwardInvocations(options: {
  mode: BridgeMode;
  initial: TraceMessage[];
  invocations: TraceMessage[][];
  reconstructedPrefixes?: Array<TraceMessage[] | undefined>;
  skipHealthAssertion?: boolean;
  followUpPromptsSent?: string[];
}): TraceMessage[] {
  let state = options.initial;
  const baseline = countAssistants(state);
  for (let index = 0; index < options.invocations.length; index += 1) {
    const before = countAssistants(state);
    state = adoptInvocation({
      mode: options.mode,
      state,
      generation: options.invocations[index],
      reconstructedPrefix: options.reconstructedPrefixes?.[index],
      invocationIndex: index,
    });
    if (!options.skipHealthAssertion) {
      assertInvocationGrew(before, countAssistants(state), index);
    }
  }
  if (!options.skipHealthAssertion) {
    assertFollowUpComplete(
      countAssistants(state),
      baseline,
      options.followUpPromptsSent ?? [],
    );
  }
  return state;
}

export function extractAssertionContext(messages: TraceMessage[]): AssertionContext {
  const calls = new Map<string, { tool: string; input: unknown }>();
  const toolExecutions: AssertionContext['toolExecutions'] = [];
  const responses: string[] = [];
  const errors: string[] = [];
  const trace: Array<Record<string, unknown>> = [];
  let turnCount = 0;

  for (const message of messages) {
    if (message.role === 'assistant') {
      turnCount += 1;
      const messageCalls = (message.toolCalls ?? []).map((call) => {
        const record = { id: call.id, tool: call.function, input: call.arguments };
        calls.set(call.id, { tool: record.tool, input: record.input });
        return record;
      });
      const text = (message.text ?? '').trim();
      trace.push({
        step: trace.length + 1,
        kind: 'assistant',
        turn: turnCount,
        text,
        tool_calls: messageCalls,
      });
      if (text && messageCalls.length === 0) {
        responses.push(text);
      }
    } else if (message.role === 'tool') {
      const call = calls.get(message.toolCallId ?? '') ?? {
        tool: message.function ?? 'unknown',
        input: {},
      };
      const error = message.error ? String(message.error) : undefined;
      const output = message.text ?? '';
      const execution = {
        tool: call.tool,
        input: call.input,
        output,
        success: error === undefined,
        ...(error ? { error } : {}),
        duration: 0,
        timestamp: 0,
      };
      toolExecutions.push(execution);
      trace.push({ step: trace.length + 1, kind: 'tool', ...execution });
      if (error) errors.push(error);
    }
  }

  return {
    toolExecutions,
    responses,
    errors,
    turnCount,
    trace,
  };
}
