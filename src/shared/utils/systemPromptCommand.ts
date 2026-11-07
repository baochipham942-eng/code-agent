const SYSTEM_PROMPT_COMMAND = /osascript|tell application|system events/i;

export function mayCommandAwaitSystemPrompt(command: string): boolean {
  return SYSTEM_PROMPT_COMMAND.test(command);
}
