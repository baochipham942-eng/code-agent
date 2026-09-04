/**
 * injectPrefixByte is the standing M1 mutation fixture: one-byte prefix
 * drift that parks a shared-bridge follow-up. It is regression protection,
 * not dead code.
 */
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
const followUpUser: TraceMessage = { role: 'user', text: 'what is the version?' };
const followUpCall: TraceMessage = {
  role: 'assistant',
  text: '',
  toolCalls: [{ id: 'c2', function: 'Read', arguments: { path: 'package.json' } }],
};
const followUpTool: TraceMessage = {
  role: 'tool',
  toolCallId: 'c2',
  function: 'Read',
  text: '{"name":"code-agent","version":"0.33.0"}',
};

const turn1State: TraceMessage[] = [user, assistantCall, toolResult, answer1];
/** Real resume shape: second CLI process re-sends history + follow-up + new answer. */
const followUpWithHistory: TraceMessage[] = [...turn1State, followUpUser, answer2];
/** 09-04 failure shape: second process sent only the follow-up, no turn-1 history. */
const followUpWithoutHistory: TraceMessage[] = [followUpUser, answer2];
/** Reviewer 09-04 v3: first turn is one plain-text assistant. */
const firstTurnPlain: TraceMessage[] = [user, answer1];
/** Follow-up that called a tool without first-turn history (1 -> 2 would pass growth). */
const followUpToolNoHistory: TraceMessage[] = [
  followUpUser,
  followUpCall,
  followUpTool,
  answer2,
];
const followUpPlainWithHistory: TraceMessage[] = [
  ...firstTurnPlain,
  followUpUser,
  answer2,
];

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
  it('T1: fresh bridge adopts a follow-up request that carries full history', () => {
    const state = forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: turn1State,
      invocations: [followUpWithHistory],
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

  it('T5: Neo merged tool-call+answer resume still stitches a third assistant', () => {
    const mergedFirstTurn: TraceMessage = {
      role: 'assistant',
      text: answer1.text,
      toolCalls: [{ id: 'c1', function: 'Read', arguments: { path: 'package.json' } }],
    };
    const neoResumeGeneration: TraceMessage[] = [
      user,
      mergedFirstTurn,
      toolResult,
      followUpUser,
      answer2,
    ];
    const state = forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: turn1State,
      invocations: [neoResumeGeneration],
      followUpPromptsSent: ['what is the version?'],
    });
    expect(countAssistants(state)).toBe(3);
    expect(extractAssertionContext(state).responses).toEqual([
      'The package name is code-agent.',
      'The version is 0.33.0.',
    ]);
  });

  it('T4: follow-up request without history fails closed 2 -> 1', () => {
    expect(() => forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: turn1State,
      invocations: [followUpWithoutHistory],
      followUpPromptsSent: ['what is the version?'],
    })).toThrowError(
      /inspect trace health failed at invocation 0: follow-up request did not carry first-turn history/,
    );
  });

  it('T8: follow-up without history that calls a tool fails closed 2 -> 2', () => {
    expect(() => forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: turn1State,
      invocations: [[followUpUser, followUpCall, followUpTool, answer2]],
      followUpPromptsSent: ['what is the version?'],
    })).toThrowError(
      /inspect trace health failed at invocation 0: follow-up request did not carry first-turn history/,
    );
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
    }).toThrowError(/expected[\s\S]*\b2\b[\s\S]*\b3\b|expected[\s\S]*\b3\b[\s\S]*\b2\b/);
  });

  it('M2: appending a full-history generation onto seeded state duplicates assistants so T1 goes red', () => {
    const appended = [...turn1State, ...followUpWithHistory];
    expect(countAssistants(appended)).toBe(5);
    expect(extractAssertionContext(appended).responses).toEqual([
      answer1.text,
      answer1.text,
      answer2.text,
    ]);
    expect(() => {
      expect(countAssistants(appended)).toBe(3);
      expect(extractAssertionContext(appended).responses).toEqual([
        'The package name is code-agent.',
        'The version is 0.33.0.',
      ]);
    }).toThrowError(/expected[\s\S]*\b5\b[\s\S]*\b3\b|expected[\s\S]*\b3\b[\s\S]*\b5\b/);
  });

  it('T6: follow-up tool call + tool + answer all land at the tail', () => {
    const generation: TraceMessage[] = [
      ...turn1State,
      followUpUser,
      followUpCall,
      followUpTool,
      answer2,
    ];
    const state = forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: turn1State,
      invocations: [generation],
      followUpPromptsSent: ['what is the version?'],
    });

    expect(state.slice(-3)).toEqual([followUpCall, followUpTool, answer2]);
    const context = extractAssertionContext(state);
    expect(context.toolExecutions).toHaveLength(2);
    expect(context.toolExecutions[1]).toMatchObject({
      tool: 'Read',
      output: followUpTool.text,
    });
    expect(context.turnCount).toBe(4);
    expect(countAssistants(state)).toBe(4);
  });

  it('T7: full-replace generation stitches new tail without duplicating first turn', () => {
    const mergedFirstTurn: TraceMessage = {
      role: 'assistant',
      text: answer1.text,
      toolCalls: [{ id: 'c1', function: 'Read', arguments: { path: 'package.json' } }],
    };
    const generation: TraceMessage[] = [
      user,
      mergedFirstTurn,
      toolResult,
      followUpUser,
      followUpCall,
      followUpTool,
      answer2,
    ];
    const state = forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: turn1State,
      invocations: [generation],
      followUpPromptsSent: ['what is the version?'],
    });

    expect(state.slice(-3)).toEqual([followUpCall, followUpTool, answer2]);
    const context = extractAssertionContext(state);
    expect(context.responses).toEqual([
      'The package name is code-agent.',
      'The version is 0.33.0.',
    ]);
    expect(context.responses.filter((text) => text === answer1.text)).toHaveLength(1);
    expect(context.toolExecutions).toHaveLength(2);
    expect(countAssistants(state)).toBe(4);
    expect(context.turnCount).toBe(4);
  });

  it('M3: stitching only the last assistant drops follow-up tool evidence so T6 goes red', () => {
    const lastOnly = [...turn1State, answer2];
    expect(() => {
      expect(lastOnly.slice(-3)).toEqual([followUpCall, followUpTool, answer2]);
      expect(extractAssertionContext(lastOnly).toolExecutions).toHaveLength(2);
      expect(extractAssertionContext(lastOnly).turnCount).toBe(4);
    }).toThrowError(/expected/);
  });

  it('T9: follow-up without history that grew 1 -> 2 still fails closed', () => {
    expect(() => forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: [user],
      invocations: [firstTurnPlain, followUpToolNoHistory],
      followUpPromptsSent: ['what is the version?'],
    })).toThrowError(
      /inspect trace health failed at invocation 1: follow-up request did not carry first-turn history/,
    );
  });

  it('T10: follow-up with full history and a normal answer is not blocked', () => {
    const state = forwardInvocations({
      mode: 'fresh-per-invocation',
      initial: [user],
      invocations: [firstTurnPlain, followUpPlainWithHistory],
      followUpPromptsSent: ['what is the version?'],
    });
    expect(countAssistants(state)).toBe(2);
    expect(extractAssertionContext(state).responses).toEqual([
      'The package name is code-agent.',
      'The version is 0.33.0.',
    ]);
  });

  it('M4: replacing a no-history 1->2 follow-up drops the first turn so T9 goes red', () => {
    expect(countAssistants(followUpToolNoHistory)).toBeGreaterThan(
      countAssistants(firstTurnPlain),
    );
    expect(() => {
      expect(followUpToolNoHistory.some((message) => message.text === answer1.text)).toBe(true);
      expect(extractAssertionContext(followUpToolNoHistory).responses).toContain(answer1.text);
    }).toThrowError(/expected/);
  });

  it('scorer metadata labels broken traces only when first-invocation count is known', () => {
    expect(scorerTraceHealth(['follow-up'], 2, 2)).toBe('broken');
    expect(scorerTraceHealth(['follow-up'], 3, 2)).toBe('ok');
    expect(scorerTraceHealth(['follow-up'], 2)).toBe('ok');
    expect(scorerTraceHealth([], 2, 2)).toBe('ok');
  });
});
