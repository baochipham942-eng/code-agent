// ============================================================================
// SkillStatusMessage - Display Skill activation status
// ============================================================================
// Renders special status messages when a Skill is being loaded/activated.
// Shows a loading spinner with the skill name in a compact, styled format.
// ============================================================================

import React from 'react';
import { Loader2, Sparkles } from 'lucide-react';

export interface SkillStatusMessageProps {
  content: string;
}

/**
 * Parse skill status message content
 * Expected format: <command-message>Loading skill: xxx</command-message><command-name>xxx</command-name>
 */
function parseSkillContent(content: string): { message: string | null; name: string | null } {
  const messageMatch = content.match(/<command-message>(.+?)<\/command-message>/);
  const nameMatch = content.match(/<command-name>(.+?)<\/command-name>/);

  return {
    message: messageMatch ? messageMatch[1] : null,
    name: nameMatch ? nameMatch[1] : null,
  };
}

/**
 * SkillStatusMessage Component
 *
 * Displays a compact status indicator when a Skill is being loaded or activated.
 * Used for messages with source='skill' and containing <command-message> tags.
 */
export const SkillStatusMessage: React.FC<SkillStatusMessageProps> = ({ content }) => {
  const { message, name } = parseSkillContent(content);

  // If no valid message format, don't render anything
  if (!message) {
    return null;
  }

  return (
    <div className="skill-status animate-slideUp">
      <div className="inline-flex items-center gap-3 px-4 py-2.5 rounded-xl bg-gradient-to-r from-primary-500/10 to-accent-purple/10 border border-primary-500/20">
        {/* Loading spinner */}
        <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-primary-500/20">
          <Loader2 className="w-4 h-4 text-primary-400 animate-spin" />
        </div>

        {/* Status message */}
        <span className="text-sm text-zinc-300">{message}</span>

        {/* Skill name badge */}
        {name && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-zinc-800/50 border border-zinc-700/50">
            <Sparkles className="w-3 h-3 text-accent-purple" />
            <span className="text-xs font-medium text-zinc-400">/{name}</span>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Check if a message content is a skill status message
 */
export function isSkillStatusContent(content: string): boolean {
  return content.includes('<command-message>') && content.includes('<command-name>');
}
