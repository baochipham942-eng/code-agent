/** `/btw` plus an optional question. `/btwx` is not this command. */
export function parseBtwCommand(input: string): { question: string } | null {
  const match = input.trim().match(/^\/btw(?:\s+([\s\S]+))?$/);
  if (!match) return null;
  return { question: match[1]?.trim() ?? '' };
}

/** Question words for the shared command handler. Empty when the question is missing. */
export function btwQuestionArgs(input: string): string[] {
  const parsed = parseBtwCommand(input);
  if (!parsed?.question) return [];
  return [parsed.question];
}
