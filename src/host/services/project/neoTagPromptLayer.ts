import type { NeoTagRunContext, NeoWorkCardDelta, NeoWorkCardRevision } from '../../../shared/contract/tag';
import type { NeoTopicRound } from '../../../shared/neoTag/topicRounds';
import { estimateTokens } from '../../context/tokenOptimizer';

/** Topic 历史段独立预算（ADR-035 D3）：超出从最老的轮截断。 */
export const TOPIC_HISTORY_MAX_TOKENS = 4000;

function list(items: string[], fallback = 'none'): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : `- ${fallback}`;
}

// ADR-035：跨会话续接时 Neo 不再"跑在源会话里白拿上下文"，topic 历史轮必须物化正文注入。
// 最新优先塞预算（至少保一轮），输出仍按时间序；砍了多少轮如实写明。
function renderTopicHistory(rounds: NeoTopicRound[]): string[] {
  if (rounds.length === 0) return [];
  const kept: NeoTopicRound[] = [];
  let used = 0;
  for (const round of [...rounds].reverse()) {
    const cost = estimateTokens(round.request) + estimateTokens(round.reply ?? '');
    if (kept.length > 0 && used + cost > TOPIC_HISTORY_MAX_TOKENS) break;
    kept.unshift(round);
    used += cost;
  }
  const dropped = rounds.length - kept.length;
  return [
    '',
    'Topic history (earlier rounds of this topic, possibly from other conversations):',
    ...kept.flatMap((round, index) => [
      `[round ${index + 1 + dropped}${round.conversationId ? ` @ ${round.conversationId}` : ''}]`,
      `user: ${round.request}`,
      `neo: ${round.reply ?? '(no final reply yet)'}`,
    ]),
    ...(dropped > 0 ? [`(${dropped} earlier round(s) omitted for token budget)`] : []),
  ];
}

function expectedOutputs(revision: NeoWorkCardRevision): string {
  if (revision.expectedOutputs.length === 0) return '- none';
  return revision.expectedOutputs
    .map((output) => `- ${output.kind}: ${output.title}${output.description ? ` (${output.description})` : ''}`)
    .join('\n');
}

export function buildNeoTagPromptLayer(args: {
  runContext: NeoTagRunContext;
  revision: NeoWorkCardRevision;
  previousDelta?: NeoWorkCardDelta | null;
  /** topic 历史轮（其他会话的用户原话+Neo 最终回复），跨会话续接时物化注入（ADR-035）。 */
  topicRounds?: NeoTopicRound[];
  /** topic 原工作目录（源会话的）；跨会话跑时告知 Neo，文件类任务用绝对路径。 */
  topicWorkspace?: string;
}): string {
  const { runContext, revision, previousDelta, topicRounds, topicWorkspace } = args;
  return [
    '<neo-tag-work-card>',
    `workCardId: ${runContext.workCardId}`,
    `approvedRevisionId: ${runContext.approvedRevisionId}`,
    `runId: ${runContext.runId}`,
    `projectId: ${runContext.projectId}`,
    `sourceConversationId: ${runContext.sourceConversationId}`,
    `sourceTurnId: ${runContext.sourceTurnId}`,
    `intent: ${revision.intent}`,
    '',
    'Task summary:',
    revision.taskSummary,
    '',
    'Approved read scope:',
    `mode: ${revision.readScope.mode}`,
    `conversations: ${revision.readScope.conversationIds.join(', ') || 'none'}`,
    `messages: ${revision.readScope.messageIds.join(', ') || 'none'}`,
    `artifacts: ${revision.readScope.artifactIds.join(', ') || 'none'}`,
    `files: ${revision.readScope.fileGlobs.join(', ') || 'none'}`,
    `memory: ${revision.readScope.memoryEntryIds.join(', ') || 'none'}`,
    list(revision.readScope.notes, 'no read-scope notes'),
    '',
    'Approved write scope:',
    `mode: ${revision.writeScope.mode}`,
    `allowedPaths: ${revision.writeScope.allowedPaths.join(', ') || 'none'}`,
    `canCreateFiles: ${revision.writeScope.canCreateFiles}`,
    `canModifyFiles: ${revision.writeScope.canModifyFiles}`,
    `canWriteProjectMemory: ${revision.writeScope.canWriteProjectMemory}`,
    `externalDestinations: ${revision.writeScope.externalDestinations.join(', ') || 'none'}`,
    list(revision.writeScope.notes, 'no write-scope notes'),
    '',
    'Expected outputs:',
    expectedOutputs(revision),
    '',
    'Risks:',
    list(revision.risks),
    '',
    'Assumptions:',
    list(revision.assumptions),
    '',
    'Memory plan:',
    `mode: ${revision.memoryPlan.mode}`,
    revision.memoryPlan.entries.length > 0
      ? revision.memoryPlan.entries.map((entry) => `- ${entry.kind}: ${entry.text}`).join('\n')
      : '- none',
    list(revision.memoryPlan.notes, 'no memory notes'),
    '',
    'Bounded context pack:',
    `contextPackId: ${runContext.contextPack.id}`,
    `strategy: ${runContext.contextPack.strategy}`,
    `selectedMessages: ${runContext.contextPack.selectedMessages.map((message) => message.id).join(', ') || 'none'}`,
    `selectedFiles: ${runContext.contextPack.selectedFiles.map((file) => file.path).join(', ') || 'none'}`,
    `excluded: ${runContext.contextPack.excluded.map((item) => `${item.id} (${item.reason})`).join(', ') || 'none'}`,
    `budget: ${runContext.contextPack.budget.estimatedTokens}/${runContext.contextPack.budget.maxTokens}`,
    ...renderTopicHistory(topicRounds ?? []),
    ...(runContext.targetConversationId
      && runContext.targetConversationId !== runContext.sourceConversationId
      && topicWorkspace
      ? [
          '',
          `Topic home workspace: ${topicWorkspace}`,
          'This round runs in a different conversation/working directory; use absolute paths under the topic home workspace when the task refers to its files.',
        ]
      : []),
    '',
    'Previous delta:',
    previousDelta
      ? JSON.stringify({
          completed: previousDelta.completed,
          changedFiles: previousDelta.changedFiles,
          decisions: previousDelta.decisions,
          openQuestions: previousDelta.openQuestions,
          risks: previousDelta.risks,
          memoryCandidates: previousDelta.memoryCandidates,
          nextStep: previousDelta.nextStep,
        })
      : 'none',
    '',
    'Execution rules:',
    '- Execute only the approved revision, not any draft edits.',
    '- Stay inside the approved read/write/memory scopes.',
    '- Report completed work, changed files, decisions, open questions, risks, memory candidates, and next step for result review.',
    '</neo-tag-work-card>',
  ].join('\n');
}
