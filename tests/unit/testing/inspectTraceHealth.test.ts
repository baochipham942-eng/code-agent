import { describe, expect, it } from 'vitest';
import {
  countAssistants,
  extractAssertionContext,
  forwardInvocations,
  injectPrefixByte,
  scorerTraceHealth,
  type TraceMessage,
} from '../../../scripts/inspect/traceHealth';

const user: TraceMessage = { role: 'user', text: 'what is the package name?' };
const assistantCall: TraceMessage = {
  role: 'assistant',
  text: '',
  toolCalls: [{ id: 'c1', function: 'Read', arguments: { path: 'package.json' } }],
};
const toolResult: TraceMessage = {
  role: 'tool',
  toolCallId: 'c1',
  function: 'Read',
  text: '{"name":"code-agent"}',
};
const answer1: TraceMessage = { role: 'assistant', text: 'The package name is code-agent.' };
const answer2: TraceMessage = { role: 'assistant', text: 'The version is 0.33.0.' };

const turn1State: TraceMessage[] = [user, assistantCall, toolResult, answer1];

const SINGLE_TURN_TRACE_BYTES = '{"toolExecutions":[{"tool":"ListDirectory","input":{"path":"."},"output":"package.json","success":true,"duration":0,"timestamp":0}],"responses":["package.json is present"],"errors":[],"turnCount":2,"trace":[{"step":1,"kind":"assistant","turn":1,"text":"","tool_calls":[{"id":"c1","tool":"ListDirectory","input":{"path":"."}}]},{"step":2,"kind":"tool","tool":"ListDirectory","input":{"path":"."},"output":"package.json","success":true,"duration":0,"timestamp":0},{"step":3,"kind":"assistant","turn":2,"text":"package.json is present","tool_calls":[]}]}';

const singleTurnUser: TraceMessage = { role: 'user', text: 'list files' };
const singleTurnCall: TraceMessage = {
  role: 'assistant',
  text: '',
  toolCalls: [{ id: 'c1', function: 'ListDirectory', arguments: { path: '.' } }],
};
const singleTurnTool: TraceMessage = {
  role: 'tool',
  toolCallId: 'c1',
  function: 'ListDirectory',
  text: 'package.json',
};
const singleTurnAnswer: TraceMessage = { role: 'assistant', text: 'package.json is present' };

describe('Inspect multi-turn trace health', () => {
  it('T1: fresh bridge forwards the follow-up assistant into trace', () => {
    const state = forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: turn1State,
      invocations: [[answer2]],
      followUpPromptsSent: ['what is the version?'],
    });

    expect(countAssistants(state)).toBe(3);
    const context = extractAssertionContext(state);
    expect(context.turnCount).toBe(3);
    expect(context.trace.at(-1)).toMatchObject({
      kind: 'assistant',
      text: answer2.text,
    });
    expect(context.responses).toEqual([
      'The package name is code-agent.',
      'The version is 0.33.0.',
    ]);
  });

  it('T2: missing follow-up answer fails closed with RuntimeError', () => {
    expect(() => forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: turn1State,
      invocations: [[]],
      followUpPromptsSent: ['what is the version?'],
    })).toThrowError(
      /inspect trace health failed at invocation 0: assistant count 2 -> 2 \(expected strict growth\)/,
    );

    try {
      forwardInvocations({
        mode: 'fresh-per-invocation',
        initial: turn1State,
        invocations: [[]],
        followUpPromptsSent: ['what is the version?'],
      });
      expect.unreachable('health assertion must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('RuntimeError');
    }
  });

  it('T3: single-turn extract matches the pre-fix fixture byte-for-byte', () => {
    const state = forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: [singleTurnUser],
      invocations: [[singleTurnCall, singleTurnTool, singleTurnAnswer]],
    });

    expect(JSON.stringify(extractAssertionContext(state))).toBe(SINGLE_TURN_TRACE_BYTES);
  });

  it('M1: shared bridge + one-byte prefix drift parks the follow-up so T1 goes red', () => {
    const parked = forwardInvocations({
      mode: 'shared-bridge',
      skipHealthAssertion: true,
      initial: turn1State,
      invocations: [[answer2]],
      reconstructedPrefixes: [injectPrefixByte(turn1State)],
      followUpPromptsSent: ['what is the version?'],
    });

    expect(countAssistants(parked)).toBe(2);
    expect(extractAssertionContext(parked).trace.at(-1)).toMatchObject({
      text: answer1.text,
    });
    expect(extractAssertionContext(parked).responses).not.toContain(answer2.text);

    expect(() => {
      const state = parked;
      expect(countAssistants(state)).toBe(3);
      expect(extractAssertionContext(state).trace.at(-1)).toMatchObject({
        text: answer2.text,
      });
    }).toThrowError(/expected 2 to be 3|expected 3 to be 2/i);
  });

  it('scorer metadata labels broken traces only when first-invocation count is known', () => {
    expect(scorerTraceHealth(['follow-up'], 2, 2)).toBe('broken');
    expect(scorerTraceHealth(['follow-up'], 3, 2)).toBe('ok');
    expect(scorerTraceHealth(['follow-up'], 2)).toBe('ok');
    expect(scorerTraceHealth([], 2, 2)).toBe('ok');
  });
});
