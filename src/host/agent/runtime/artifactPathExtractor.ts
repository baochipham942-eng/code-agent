import type { Message } from '../../../shared/contract';

function extractAbsoluteFilePaths(text: string): string[] {
  const pattern = /\/[\w.~-]+\/[^\s,，。、;；:：""""'']+\.\w{2,5}/g;
  const files: string[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const p = match[0];
    const tokenStart = text.lastIndexOf(' ', match.index) + 1;
    const prefix = text.substring(tokenStart, match.index);
    if (prefix.includes('://') || prefix.endsWith('/') || prefix.endsWith(':')) continue;
    if (!files.includes(p)) files.push(p);
  }
  return files;
}

export function extractArtifactFilePathFromMessages(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const rawContent: unknown = message.content;
    const content = typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((part: unknown) => {
          if (!part || typeof part !== 'object') return '';
          const textPart = part as { type?: unknown; text?: unknown };
          return textPart.type === 'text' && typeof textPart.text === 'string' ? textPart.text : '';
        }).join('\n')
        : '';
    const matches = extractAbsoluteFilePaths(content).filter((candidate) => /\.(html?|tsx?|jsx?|css|md)$/i.test(candidate));
    if (matches.length > 0) return matches[0];
  }
  return null;
}
