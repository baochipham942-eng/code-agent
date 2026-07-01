export interface ParsedNeoTagInvocation {
  userText: string;
  originalContent: string;
}

export function isLeadingNeoTagInput(value: string): boolean {
  const trimmedStart = value.replace(/^\s+/, '');
  return /^@neo(?:\s|$)/i.test(trimmedStart);
}

export function parseLeadingNeoTagInvocation(content: string): ParsedNeoTagInvocation | null {
  const trimmedStart = content.replace(/^\s+/, '');
  const match = trimmedStart.match(/^@neo(?:\s+|$)/i);
  if (!match) return null;

  return {
    userText: trimmedStart.slice(match[0].length).trim(),
    originalContent: trimmedStart,
  };
}
