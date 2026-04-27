// ============================================================================
// Skill Renderer
// Process $ARGUMENTS in skill content
// ============================================================================

export interface SkillRenderOptions {
  /** Arguments passed to the skill invocation */
  arguments?: string;
  /** Retained for caller compatibility; shell commands are not executed here. */
  workingDirectory?: string;
}

/**
 * Render skill content: process $ARGUMENTS substitution
 *
 * - $ARGUMENTS is replaced with the actual arguments (or empty string)
 * - Lines starting with ! are preserved as blocked text, not executed
 */
export function renderSkillContent(content: string, options: SkillRenderOptions = {}): string {
  let rendered = content;

  // Replace $ARGUMENTS with actual arguments
  if (options.arguments) {
    rendered = rendered.replace(/\$ARGUMENTS/g, options.arguments);
  } else {
    rendered = rendered.replace(/\$ARGUMENTS/g, '');
  }

  // Do not execute shell from Skill rendering. Shell work must go through tools.
  rendered = rendered.replace(/^!(.+)$/gm, (_, cmd) => {
    return `[Skill shell command blocked: ${cmd.trim()}]`;
  });

  return rendered;
}
