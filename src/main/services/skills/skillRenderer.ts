// ============================================================================
// Skill Renderer
// Process !cmd and $ARGUMENTS in skill content
// ============================================================================

import { execSync } from 'child_process';

export interface SkillRenderOptions {
  /** Arguments passed to the skill invocation */
  arguments?: string;
  /** Working directory for !cmd execution */
  workingDirectory?: string;
}

/**
 * Render skill content: process !cmd lines and $ARGUMENTS substitution
 *
 * - $ARGUMENTS is replaced with the actual arguments (or empty string)
 * - Lines starting with ! are executed as shell commands and replaced with output
 */
export function renderSkillContent(content: string, options: SkillRenderOptions = {}): string {
  let rendered = content;

  // Replace $ARGUMENTS with actual arguments
  if (options.arguments) {
    rendered = rendered.replace(/\$ARGUMENTS/g, options.arguments);
  } else {
    rendered = rendered.replace(/\$ARGUMENTS/g, '');
  }

  // Process !cmd lines (execute shell commands and replace with output)
  rendered = rendered.replace(/^!(.+)$/gm, (_, cmd) => {
    try {
      const output = execSync(cmd.trim(), {
        timeout: 5000,
        cwd: options.workingDirectory,
        encoding: 'utf-8',
      });
      return output.trim();
    } catch {
      return `[Command failed: ${cmd.trim()}]`;
    }
  });

  return rendered;
}
