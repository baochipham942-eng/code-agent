import React, { useMemo, useState } from 'react';
import type { EvalCaseEvidence } from '@shared/contract/evaluation';
import type { EvalCaseDrawerLabels } from '../i18n/evalCaseDrawer';
import { Button } from '@renderer/components/primitives/Button';

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

interface EvalCaseTranscriptProps {
  evidence: EvalCaseEvidence | null;
  promptVersion?: string;
  labels: EvalCaseDrawerLabels;
}

export const EvalCaseTranscript: React.FC<EvalCaseTranscriptProps> = ({
  evidence,
  promptVersion,
  labels,
}) => {
  const [toolsOpen, setToolsOpen] = useState(false);
  const userTurns = useMemo(() => {
    if (!evidence) return [];
    const turns: Array<{ turn: number; text: string; matchedRule?: string }> = [
      ...(evidence.prompt ? [{ turn: 1, text: evidence.prompt }] : []),
      ...(evidence.followUpPrompts ?? []).map((text, index) => ({ turn: index + 2, text })),
      ...(evidence.simTurns ?? []).map((turn) => ({
        turn: turn.turn,
        text: turn.userText,
        matchedRule: turn.matchedRule,
      })),
    ];
    return turns.sort((left, right) => left.turn - right.turn);
  }, [evidence]);

  if (!evidence) {
    return <p className="text-xs text-zinc-500">{labels.noProcessEvidence}</p>;
  }

  return (
    <div className="space-y-3" data-testid="eval-case-transcript">
      {promptVersion && (
        <div className="rounded-md bg-[var(--bg-hover)] px-3 py-2 text-xs text-zinc-500">
          {fill(labels.promptVersion, { version: promptVersion })} · {labels.productionDefault}
        </div>
      )}
      {userTurns.length === 0 ? (
        <p className="text-xs text-zinc-500">{labels.noPromptEvidence}</p>
      ) : userTurns.map((turn, index) => (
        <div key={`${turn.turn}-${index}`} className="ml-10 rounded-lg bg-[var(--bg-active)] px-3 py-2 text-sm text-zinc-200" data-testid="eval-case-user-turn">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">{labels.input}</div>
          <div className="whitespace-pre-wrap break-words">{turn.text}</div>
          {turn.matchedRule && (
            <div className="mt-2 text-[10px] text-badge-info">{fill(labels.simulatorRule, { rule: turn.matchedRule })}</div>
          )}
        </div>
      ))}
      {evidence.toolCalls.length > 0 && (
        <div className="rounded-md bg-[var(--bg-hover)] px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-xs text-zinc-400"
            onClick={() => setToolsOpen((open) => !open)}
          >
            {fill(toolsOpen ? labels.toolsExpanded : labels.toolsCollapsed, { count: evidence.toolCalls.length })}
          </Button>
          {toolsOpen && (
            <div className="space-y-1 px-2 pb-2 pt-1">
              {evidence.toolCalls.map((call, index) => (
                <div key={`${call.tool}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 text-[11px]">
                  <div className="min-w-0">
                    <span className="font-mono text-zinc-300">{call.tool}</span>
                    <span className="ml-2 break-all text-zinc-500">{call.inputSummary}</span>
                    <div className={call.ok ? 'text-badge-success' : 'text-badge-danger'}>
                      ⎿ {call.ok ? labels.toolOk : fill(labels.toolFailed, { error: call.error ?? labels.toolFailureMissing })}
                    </div>
                  </div>
                  <span className="text-zinc-600">{call.durationMs} ms</span>
                </div>
              ))}
              {(evidence.toolCallsTruncated ?? 0) > 0 && (
                <div className="text-[11px] text-zinc-500">
                  {fill(labels.toolsTruncated, { count: evidence.toolCallsTruncated ?? 0 })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {evidence.responseExcerpt ? (
        <div className="mr-10 rounded-lg bg-[var(--bg-hover)] px-3 py-2 text-sm text-zinc-300">
          <div className="mb-1 flex items-center justify-between gap-3 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            <span>{labels.actualOutput}</span>
            <span className="normal-case">
              {fill(labels.responseExcerpt, {
                shown: evidence.responseExcerpt.length,
                total: evidence.responseTotalChars,
              })}
            </span>
          </div>
          <div className="whitespace-pre-wrap break-words">{evidence.responseExcerpt}</div>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">{labels.noOutputEvidence}</p>
      )}
    </div>
  );
};
