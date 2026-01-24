// ============================================================================
// Skills - Display triggered skills with details
// ============================================================================

import React, { useState, useMemo } from 'react';
import { Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { useI18n } from '../../hooks/useI18n';

interface SkillInfo {
  name: string;
  input?: string;
  timestamp: number;
}

export const Skills: React.FC = () => {
  const { messages } = useSessionStore();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(true);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  // Extract skills from tool calls in messages
  const triggeredSkills = useMemo(() => {
    const skills: SkillInfo[] = [];
    const seenSkills = new Set<string>();

    // Look at recent messages for skill tool calls
    for (const message of messages.slice(-20).reverse()) {
      if (message.toolCalls) {
        for (const toolCall of message.toolCalls) {
          if (toolCall.name === 'skill') {
            const args = toolCall.arguments as Record<string, unknown>;
            const skillName = args?.name as string | undefined;
            if (skillName && !seenSkills.has(skillName)) {
              seenSkills.add(skillName);
              skills.push({
                name: skillName,
                input: args?.input as string | undefined,
                timestamp: message.timestamp,
              });
              if (skills.length >= 5) break;
            }
          }
        }
      }
      if (skills.length >= 5) break;
    }

    return skills;
  }, [messages]);

  const toggleSkillExpand = (name: string) => {
    setExpandedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  if (triggeredSkills.length === 0) {
    return null;
  }

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center w-full"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Sparkles className="w-4 h-4 text-amber-400 flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            {t.taskPanel.skills}
          </span>
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="space-y-1 mt-3">
          {triggeredSkills.map((skill, index) => {
            const isExpanded = expandedSkills.has(skill.name);

            return (
              <div key={`${skill.name}-${index}`} className="rounded overflow-hidden">
                <button
                  onClick={() => skill.input && toggleSkillExpand(skill.name)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 text-left transition-colors ${
                    skill.input ? 'hover:bg-zinc-800/50 cursor-pointer' : 'cursor-default'
                  }`}
                >
                  <Sparkles className="w-3.5 h-3.5 text-amber-400/70" />
                  <span className="flex-1 text-sm text-zinc-300 truncate">{skill.name}</span>
                  {skill.input && (
                    isExpanded ? (
                      <ChevronDown className="w-3 h-3 text-zinc-500" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-zinc-500" />
                    )
                  )}
                </button>

                {/* Expanded skill details */}
                {isExpanded && skill.input && (
                  <div className="px-2 py-2 bg-zinc-900/50 text-xs">
                    <div className="text-zinc-400 mb-1">Input:</div>
                    <div className="text-zinc-300 whitespace-pre-wrap break-all">
                      {skill.input}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
