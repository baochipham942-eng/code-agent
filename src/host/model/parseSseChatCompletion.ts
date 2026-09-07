// Shared SSE sniff for OpenAI-compatible chat/completions.
// Non-streaming callers declare stream:false; some upstreams still return
// text/event-stream or a body that starts with `data:`. JSON.parse on that
// body throws a SyntaxError into user-facing paths. This module sniffs first
// and never lets JSON.parse exceptions escape.

type ChatCompletionHttpBodyParseResult =
  | { kind: 'payload'; payload: unknown }
  | { kind: 'empty' }
  | { kind: 'invalid'; error: string };

type SseChatCompletionParseResult =
  | { kind: 'content'; content: string }
  | { kind: 'empty' }
  | { kind: 'invalid'; error: string };

type ChatCompletionHttpResponse = {
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function parseChatCompletionContent(payload: unknown): string | null {
  if (!isUnknownRecord(payload) || !isUnknownArray(payload.choices)) {
    return null;
  }

  const firstChoice = payload.choices[0];
  if (!isUnknownRecord(firstChoice) || !isUnknownRecord(firstChoice.message)) {
    return null;
  }

  const content = firstChoice.message.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

function parseChatCompletionDeltaContent(payload: unknown): string | null {
  if (!isUnknownRecord(payload) || !isUnknownArray(payload.choices)) {
    return null;
  }

  const firstChoice = payload.choices[0];
  if (!isUnknownRecord(firstChoice) || !isUnknownRecord(firstChoice.delta)) {
    return null;
  }

  const content = firstChoice.delta.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

function isChatCompletionMessagePayload(payload: unknown): boolean {
  if (!isUnknownRecord(payload) || !isUnknownArray(payload.choices)) {
    return false;
  }
  const firstChoice = payload.choices[0];
  return isUnknownRecord(firstChoice) && isUnknownRecord(firstChoice.message);
}

function readContentType(response: ChatCompletionHttpResponse): string {
  try {
    return response.headers?.get('content-type') ?? '';
  } catch {
    return '';
  }
}

export function looksLikeSse(contentType: string, rawBody: string): boolean {
  return contentType.toLowerCase().includes('text/event-stream')
    || rawBody.trimStart().startsWith('data:');
}

function parseSseChatCompletionPayload(rawBody: string): ChatCompletionHttpBodyParseResult {
  const events = rawBody.replace(/\r\n/g, '\n').split(/\n\n+/);
  const deltaParts: string[] = [];
  const completePayloads: unknown[] = [];
  let jsonEventCount = 0;
  let malformedEventCount = 0;

  for (const event of events) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
      jsonEventCount++;
    } catch {
      malformedEventCount++;
      continue;
    }

    const delta = parseChatCompletionDeltaContent(payload);
    if (delta) {
      deltaParts.push(delta);
      continue;
    }
    if (isChatCompletionMessagePayload(payload)) {
      completePayloads.push(payload);
    }
  }

  if (deltaParts.length > 0) {
    return {
      kind: 'payload',
      payload: { choices: [{ message: { content: deltaParts.join('') } }] },
    };
  }
  const completePayload = completePayloads.at(-1);
  if (completePayload !== undefined) {
    return { kind: 'payload', payload: completePayload };
  }
  if (jsonEventCount > 0) return { kind: 'empty' };
  return {
    kind: 'invalid',
    error: malformedEventCount > 0
      ? 'malformed SSE data'
      : 'invalid SSE response',
  };
}

export function parseSseChatCompletion(rawBody: string): SseChatCompletionParseResult {
  const parsed = parseSseChatCompletionPayload(rawBody);
  if (parsed.kind !== 'payload') return parsed;
  const content = parseChatCompletionContent(parsed.payload);
  return content ? { kind: 'content', content } : { kind: 'empty' };
}

export async function parseChatCompletionHttpBody(
  response: ChatCompletionHttpResponse,
): Promise<ChatCompletionHttpBodyParseResult> {
  const rawBody = await response.text();
  if (looksLikeSse(readContentType(response), rawBody)) {
    return parseSseChatCompletionPayload(rawBody);
  }
  const trimmedBody = rawBody.trimStart();
  if (!trimmedBody) return { kind: 'empty' };
  try {
    return { kind: 'payload', payload: JSON.parse(trimmedBody) as unknown };
  } catch {
    return { kind: 'invalid', error: 'invalid JSON' };
  }
}
