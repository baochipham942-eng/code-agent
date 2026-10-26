// ============================================================================
// ExternalImportInstructionRules - 说明文件单条规则预览（N-EXTHISTORY-IMPORT-K1A-FU1）
// ============================================================================
//
// 用户级说明文件（~/.codex/AGENTS.md、~/.claude/CLAUDE.md 等）在 host 侧被确定性
// 拆成单条规则（instructionRuleSplit.ts），这里按来源文件分组展示：默认收起只给
// 「找到 N 条规则」，展开后每行是用户原话 + 「导入这一条」，确认走既有
// memoryHarnessImportConfirmDirective 门（confirm 卡显示的正是该行原文）。
// 拆不出规则的用户级文件提示「没有可导入的单条规则」；项目级文件维持整文件
// 「只供对照，不写入」。超出新会话注入上限的行只提示、不拦截。
//
// 上限数字取自 shared/constants 的 SEED_INJECTION（与 host 注入预算同一真源）。

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MemoryImportDryRunResult } from '@shared/contract/memory';
import { SEED_INJECTION } from '@shared/constants';
import { Button } from '../../../primitives';
import type { ExternalImportCopy } from './ExternalImportSettings';

export type DirectiveState = 'pending' | 'imported' | 'declined' | 'already-imported' | 'headless' | 'failed';

type InstructionItem = MemoryImportDryRunResult['instructions'][number];

interface RuleGroup {
  sourcePath: string;
  rules: InstructionItem[];
}

function displayPath(sourcePath: string, homeDir?: string | null): string {
  if (homeDir && sourcePath.startsWith(`${homeDir}/`)) {
    return `~${sourcePath.slice(homeDir.length)}`;
  }
  return sourcePath;
}

function segmentCountOf(item: InstructionItem): unknown {
  return (item.sourceMetadata as { segmentCount?: unknown } | undefined)?.segmentCount;
}

/** 计入「找到 N 条规则」的行：host 拆出的单条规则，整文件对照项不算数。 */
function isImportableRule(item: InstructionItem): boolean {
  return item.reason === 'directive-confirmation-required';
}

/** 预览头部计数与下方分组共用同一口径：只数可逐条导入的规则。 */
export function countImportableRules(instructions: MemoryImportDryRunResult['instructions']): number {
  return instructions.filter(isImportableRule).length;
}

function RuleRow({
  item,
  position,
  state,
  busy,
  copy,
  copyRules,
  onConfirmDirective,
}: {
  item: InstructionItem;
  position: number;
  state: DirectiveState;
  busy: string | null;
  copy: ExternalImportCopy;
  copyRules: ExternalImportCopy['instructionRules'];
  onConfirmDirective: (instructionId: string) => void;
}) {
  const overCap = position > SEED_INJECTION.MAX_ITEMS;
  return (
    <div
      data-testid={`external-import-rule-row-${item.contentHash}`}
      className="flex items-start justify-between gap-2 border-b border-zinc-800/60 py-1.5 last:border-b-0"
    >
      <div className="min-w-0 flex-1 break-all text-xs text-zinc-200">{item.content}</div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {overCap && (
          <span
            data-testid="external-import-rule-overcap"
            className="rounded border border-badge-warning/30 bg-badge-warning/10 px-1.5 py-0.5 text-[10px] text-badge-warning"
          >
            {copyRules.overCap}
          </span>
        )}
        {busy === `directive:${item.id}` ? (
          <span className="text-[11px] text-zinc-500">{copy.confirmingDirective}</span>
        ) : state === 'imported' ? (
          <span className="text-[11px] text-badge-success">{copyRules.importedState}</span>
        ) : state === 'already-imported' ? (
          <span className="text-[11px] text-zinc-500">{copyRules.alreadyImported}</span>
        ) : state === 'declined' ? (
          <span className="text-[11px] text-zinc-500">{copy.directiveNotImported}</span>
        ) : state === 'headless' ? (
          <span className="text-[11px] text-zinc-500">{copyRules.headless}</span>
        ) : state === 'failed' ? (
          <span className="text-[11px] text-badge-danger">{copy.directiveFailed}</span>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            disabled={busy !== null}
            onClick={() => onConfirmDirective(item.id)}
          >
            {copyRules.importThis}
          </Button>
        )}
      </div>
    </div>
  );
}

function RuleGroupSection({
  group,
  rulePositions,
  directiveStates,
  busy,
  homeDir,
  copy,
  onConfirmDirective,
}: {
  group: RuleGroup;
  rulePositions: Map<string, number>;
  directiveStates: Record<string, DirectiveState>;
  busy: string | null;
  homeDir?: string | null;
  copy: ExternalImportCopy;
  onConfirmDirective: (instructionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const copyRules = copy.instructionRules;
  return (
    <div data-testid="external-import-rule-group" data-source-path={group.sourcePath}>
      <div className="flex items-center justify-between gap-2 py-1">
        <div className="min-w-0 truncate font-mono text-[11px] text-zinc-400">
          {displayPath(group.sourcePath, homeDir)}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 whitespace-nowrap"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          rightIcon={expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        >
          {copyRules.rulesFound.replace('{count}', String(group.rules.length))}
        </Button>
      </div>
      {expanded && (
        <div className="mt-1 space-y-0.5">
          {group.rules.map((item) => (
            <RuleRow
              key={item.id}
              item={item}
              position={rulePositions.get(item.id) ?? 0}
              state={directiveStates[item.id] ?? 'pending'}
              busy={busy}
              copy={copy}
              copyRules={copyRules}
              onConfirmDirective={onConfirmDirective}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const ExternalImportInstructionRules: React.FC<{
  instructions: MemoryImportDryRunResult['instructions'];
  directiveStates: Record<string, DirectiveState>;
  busy: string | null;
  homeDir?: string | null;
  copy: ExternalImportCopy;
  onConfirmDirective: (instructionId: string) => void;
}> = ({ instructions, directiveStates, busy, homeDir, copy, onConfirmDirective }) => {
  const copyRules = copy.instructionRules;
  const groups: RuleGroup[] = [];
  const rulePositions = new Map<string, number>();
  const wholeFileItems: InstructionItem[] = [];
  let position = 0;
  for (const item of instructions) {
    if (isImportableRule(item)) {
      position += 1;
      rulePositions.set(item.id, position);
      let group = groups.find((candidate) => candidate.sourcePath === item.sourcePath);
      if (!group) {
        group = { sourcePath: item.sourcePath, rules: [] };
        groups.push(group);
      }
      group.rules.push(item);
    } else {
      wholeFileItems.push(item);
    }
  }

  return (
    <div data-testid="external-import-instruction-rules" className="mt-2 space-y-1">
      {groups.length > 0 && (
        <div
          data-testid="external-import-rule-caphint"
          className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1.5 text-[11px] text-zinc-500"
        >
          {copyRules.capHint
            .replace('{max}', String(SEED_INJECTION.MAX_ITEMS))
            .replace('{chars}', String(SEED_INJECTION.TOTAL_CHARS))}
        </div>
      )}
      {groups.map((group) => (
        <RuleGroupSection
          key={group.sourcePath}
          group={group}
          rulePositions={rulePositions}
          directiveStates={directiveStates}
          busy={busy}
          homeDir={homeDir}
          copy={copy}
          onConfirmDirective={onConfirmDirective}
        />
      ))}
      {wholeFileItems.map((item) => (
        <div
          key={item.id}
          data-testid="external-import-rule-file"
          data-source-path={item.sourcePath}
          className="flex items-center justify-between gap-2 py-1"
        >
          <div className="min-w-0 truncate font-mono text-[11px] text-zinc-500">
            {displayPath(item.sourcePath, homeDir)}
          </div>
          {segmentCountOf(item) === 0 ? (
            <span data-testid="external-import-rule-norules" className="shrink-0 text-zinc-500">
              {copyRules.noRules}
            </span>
          ) : (
            <span className="shrink-0 text-zinc-500">{copy.instructionCompareOnly}</span>
          )}
        </div>
      ))}
    </div>
  );
};
