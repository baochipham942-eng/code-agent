import { describe, expect, it } from 'vitest';
import {
  looksLikeSse,
  parseChatCompletionHttpBody,
  parseSseChatCompletion,
} from '../../../src/host/model/parseSseChatCompletion';

function sseBody(events: string[]): string {
  return `${events.join('\n\n')}\n\n`;
}

describe('looksLikeSse', () => {
  it('recognizes text/event-stream even when the body is not prefixed', () => {
    expect(looksLikeSse('text/event-stream; charset=utf-8', '{"a":1}')).toBe(true);
  });

  it('sniffs a data: prefix when the content-type lies', () => {
    expect(looksLikeSse('application/json', 'data: {"choices":[]}\n\n')).toBe(true);
  });

  it('does not treat ordinary JSON as SSE', () => {
    expect(looksLikeSse('application/json', '{"choices":[]}')).toBe(false);
  });
});

describe('parseSseChatCompletion', () => {
  it('joins delta content across events', () => {
    const raw = sseBody([
      'data: {"choices":[{"delta":{"content":"SSE_"}}]}',
      'data: {"choices":[{"delta":{"content":"RESULT"}}]}',
      'data: [DONE]',
    ]);
    expect(parseSseChatCompletion(raw)).toEqual({ kind: 'content', content: 'SSE_RESULT' });
  });

  it('falls back to the last complete message when there are no deltas', () => {
    const raw = sseBody([
      'data: {"choices":[{"message":{"content":"first"}}]}',
      'data: {"choices":[{"message":{"content":"second"}}]}',
      'data: [DONE]',
    ]);
    expect(parseSseChatCompletion(raw)).toEqual({ kind: 'content', content: 'second' });
  });

  it('keeps the last non-empty complete message when a later event is empty', () => {
    const raw = sseBody([
      'data: {"choices":[{"message":{"content":"keep-me"}}]}',
      'data: {"choices":[{"message":{"content":""}}]}',
      'data: [DONE]',
    ]);
    expect(parseSseChatCompletion(raw)).toEqual({ kind: 'content', content: 'keep-me' });
  });

  it('returns structured invalid instead of throwing on malformed events', () => {
    expect(parseSseChatCompletion(sseBody(['data: not-json', 'data: [DONE]']))).toEqual({
      kind: 'invalid',
      error: 'malformed SSE data',
    });
  });
});

describe('parseChatCompletionHttpBody', () => {
  it('parses ordinary JSON chat completions', async () => {
    const payload = { choices: [{ message: { content: 'json-result' } }] };
    const parsed = await parseChatCompletionHttpBody(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    expect(parsed).toEqual({ kind: 'payload', payload });
  });

  it('sniffs SSE from the body when the header claims JSON', async () => {
    const raw = sseBody([
      'data: {"choices":[{"message":{"content":"body-sniffed"}}]}',
      'data: [DONE]',
    ]);
    const parsed = await parseChatCompletionHttpBody(new Response(raw, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    expect(parsed).toEqual({
      kind: 'payload',
      payload: { choices: [{ message: { content: 'body-sniffed' } }] },
    });
  });

  it('returns invalid JSON without throwing JSON.parse', async () => {
    const parsed = await parseChatCompletionHttpBody(new Response('not json or sse', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    expect(parsed).toEqual({ kind: 'invalid', error: 'invalid JSON' });
  });
});
