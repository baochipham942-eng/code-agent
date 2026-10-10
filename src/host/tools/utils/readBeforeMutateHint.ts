/**
 * One-line escape a model can copy when Write or Edit refuses to mutate
 * until this agent has Read the file. file_path is JSON-escaped so the
 * call still parses when the path contains spaces or quotes.
 */
export function readThenRetryHint(toolName: 'Write' | 'Edit', absPath: string): string {
  return `To proceed: call Read with {"file_path": ${JSON.stringify(absPath)}} (no other arguments), then repeat this exact ${toolName} call.`;
}
