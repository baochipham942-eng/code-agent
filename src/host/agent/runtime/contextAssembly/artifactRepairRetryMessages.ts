import type { ModelMessage } from '../../../agent/loopTypes';
import type { ContextAssemblyCtx } from './shared';

function normalizeModelMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content || '');
  }
}

function truncateArtifactRepairEvidence(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const head = Math.floor(limit * 0.72);
  const tail = Math.max(800, limit - head - 160);
  return [
    content.slice(0, head),
    `\n...[compact artifact repair retry omitted ${content.length - head - tail} chars]...\n`,
    content.slice(-tail),
  ].join('');
}

export function buildCompactArtifactRepairWriteRetryMessages(
  ctx: ContextAssemblyCtx,
  messages: ModelMessage[],
  errorMessage: string,
): ModelMessage[] {
  const guard = ctx.runtime.artifact.repairGuard;
  const targetFile = guard?.targetFile || 'target artifact';
  const activeIssueCodes = guard?.activeIssueCodes?.length
    ? guard.activeIssueCodes.join(', ')
    : 'unknown';

  const systemMessage: ModelMessage = {
    role: 'system',
    content: [
      '<artifact-repair-compact-write-retry>',
      'The previous artifact repair write-priority inference timed out before emitting a patch.',
      `Timeout: ${errorMessage.split('\n')[0]?.slice(0, 240) || 'provider timeout'}`,
      `Target file: ${targetFile}`,
      `Active issue codes: ${activeIssueCodes}`,
      'Available action: call exactly one mutation tool. Prefer one complete Write of the whole self-contained HTML artifact; a focused Edit is fine when it anchors cleanly. Do not call Read, Bash, Task, or validator tools.',
      'Use the target evidence below. If replacing an interactive test contract, a short old_text anchor around `window.__GAME_TEST__ = {` or `window.__INTERACTIVE_TEST__ = {` is acceptable; the runtime can expand the anchor to the balanced contract region.',
      'For malformed_test_contract, replace the full active test-contract region in one balanced Edit and remove duplicate orphaned start/reset/snapshot/step/runSmokeTest methods after the contract closes.',
      'Contract shape: assign exactly one direct plain object literal, `window.__GAME_TEST__ = { start() { ... }, reset(levelOrScenario) { ... }, snapshot() { return {...}; }, step(inputState = {}, frames = 1) { ...; return this.snapshot(); }, runSmokeTest() { return { passed, checks, failures, coverage }; } };`, or the same shape on `window.__INTERACTIVE_TEST__`.',
      'Do not put the contract in comments, a wrapper function, class, IIFE/factory, Object.assign, or separate top-level function shells. Avoid comments inside the active contract block and remove orphaned method tails.',
      'For mobile canvas failures, constrain both width and height with responsive CSS on the canvas or wrapper. A 390px mobile viewport must show the full playfield and HUD; do not rely on fixed 800px/900px widths or max-height:100vh with width:auto alone.',
      'The patch must remove direct ability/reward grants, test-mode auto collection/progression, and coverage based only on existence/registration. Prove gameplay through before/after snapshot changes driven by step/input.',
      '</artifact-repair-compact-write-retry>',
    ].join('\n'),
  };

  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const evidenceCandidates = messages
    .filter((message) => {
      if (message.role !== 'tool' && message.role !== 'system') return false;
      const content = normalizeModelMessageContent(message.content);
      return /artifact-repair|artifact-validation|window\.__(?:GAME|INTERACTIVE)_TEST__|runSmokeTest|function\s+update|Treat collection|Door check|Stomp from above/i.test(content);
    })
    .slice(-5);

  const evidenceMessages: ModelMessage[] = [];
  let usedChars = 0;
  for (const message of evidenceCandidates) {
    const content = normalizeModelMessageContent(message.content);
    const remaining = Math.max(1_200, 10_000 - usedChars);
    if (usedChars >= 10_000) break;
    const compact = truncateArtifactRepairEvidence(content, Math.min(3_500, remaining));
    usedChars += compact.length;
    evidenceMessages.push({
      role: message.role,
      content: compact,
    } as ModelMessage);
  }

  return [
    systemMessage,
    ...(lastUser ? [{
      role: 'user',
      content: truncateArtifactRepairEvidence(normalizeModelMessageContent(lastUser.content), 1_200),
    } as ModelMessage] : []),
    ...evidenceMessages,
  ];
}
