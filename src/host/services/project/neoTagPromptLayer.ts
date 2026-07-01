import type { NeoTagRunContext, NeoWorkCardDelta, NeoWorkCardRevision } from '../../../shared/contract/tag';

function list(items: string[], fallback = 'none'): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : `- ${fallback}`;
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
}): string {
  const { runContext, revision, previousDelta } = args;
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
