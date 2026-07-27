import type { Message } from '../../../../../src/shared/contract/message';
import type { Session } from '../../../../../src/shared/contract/session';

export const OWNER_ID = 'owner-1';
export const PROJECT_ID = 'project-1';

export function session(
  id: string,
  overrides: Partial<Session> & Record<string, unknown> = {},
): Session & Record<string, unknown> {
  return {
    id,
    userId: OWNER_ID,
    projectId: PROJECT_ID,
    title: `Session ${id}`,
    modelConfig: {
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'must-not-export',
      baseUrl: 'https://private.example.test',
      temperature: 0.2,
    },
    workingDirectory: `/Users/private/worktrees/${id}`,
    status: 'completed',
    engine: {
      kind: 'codex_cli',
      model: 'gpt-test',
      runId: `run-${id}`,
      externalSessionId: `external-${id}`,
      logPath: `/tmp/${id}.log`,
      cwd: `/Users/private/worktrees/${id}`,
      permissionProfile: 'workspace_write',
      origin: 'external',
    },
    parentSessionId: id === 'root' ? undefined : 'root',
    sourceRunId: `source-run-${id}`,
    streamSnapshot: {
      sessionId: id,
      runId: `stream-run-${id}`,
      turnId: `turn-${id}`,
      content: 'partial',
      reasoning: '',
      toolCalls: [],
      estimatedTokens: 1,
      timestamp: 1,
      isFinal: false,
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: [],
    },
    createdAt: 1,
    updatedAt: 2,
    approvalQueue: [{ id: `approval-${id}`, secret: true }],
    taskLease: { id: `lease-${id}` },
    queuedInputs: ['do not export'],
    ...overrides,
  };
}

export function message(
  id: string,
  role: Message['role'],
  content: string,
  timestamp: number,
  overrides: Partial<Message> & Record<string, unknown> = {},
): Message & Record<string, unknown> {
  return {
    id,
    role,
    content,
    timestamp,
    autoAssign: false,
    requireApproval: false,
    ...overrides,
  };
}

export function subtreeDraft() {
  return {
    exportId: 'export-1',
    exportedAt: 100,
    ownerScopeId: OWNER_ID,
    projectId: PROJECT_ID,
    rootSessionId: 'root',
    mode: 'subtree' as const,
    sessions: [
      {
        session: session('root'),
        messages: [
          message('u1', 'user', 'hello', 1),
          message('a1', 'assistant', 'world', 2),
        ],
        workspace: {
          mode: 'shared_current' as const,
          label: '历史对话 + 当前文件' as const,
        },
      },
      {
        session: session('child'),
        messages: [
          message('cu1', 'user', 'hello', 1),
          message('ca1', 'assistant', 'world', 2, {
            attachments: [{
              id: 'attachment-1',
              type: 'file',
              category: 'text',
              name: 'secret.txt',
              size: 12,
              mimeType: 'text/plain',
              data: 'secret body',
              path: '/Users/private/secret.txt',
              thumbnail: 'base64-private',
              files: [{ path: 'nested.txt', content: 'secret nested body', size: 18 }],
              metadata: { localPath: '/Users/private/secret.txt', token: 'secret' },
            }],
            artifacts: [{
              id: 'artifact-1',
              type: 'document',
              title: 'Read only evidence',
              content: 'artifact body must not travel',
              version: 2,
            }],
          }),
        ],
        workspace: {
          mode: 'isolated_at_anchor' as const,
          label: '历史对话 + 锚点文件' as const,
          isolatedAnchor: {
            evidenceId: 'evidence-1',
            repositoryIdentityDigest: `sha256:${'1'.repeat(64)}`,
            baseCommit: 'abc123',
            diffDigest: `sha256:${'2'.repeat(64)}`,
            untrackedManifestDigest: `sha256:${'3'.repeat(64)}`,
            absoluteWorktreePath: '/Users/private/.codex/worktrees/child',
            pathMappings: [
              {
                sourceRootDigest: `sha256:${'4'.repeat(64)}`,
                relativePath: 'src/index.ts',
              },
            ],
          },
        },
      },
    ],
    lineage: {
      createdAt: 100,
      nodes: [
        {
          forkId: null,
          sessionId: 'root',
          parentSessionId: null,
          rootSessionId: 'root',
          sourceAnchorMessageId: null,
          anchorChildMessageId: null,
          depth: 0,
          ordinal: 0,
          workspaceMode: 'shared_current' as const,
          contextDeliveryMode: 'neo_native_prefix' as const,
          createdAt: 1,
        },
        {
          forkId: 'fork-1',
          sessionId: 'child',
          parentSessionId: 'root',
          rootSessionId: 'root',
          sourceAnchorMessageId: 'a1',
          anchorChildMessageId: 'ca1',
          depth: 1,
          ordinal: 0,
          workspaceMode: 'isolated_at_anchor' as const,
          contextDeliveryMode: 'validated_context_handoff' as const,
          createdAt: 2,
        },
      ],
      messageMappings: [
        {
          forkId: 'fork-1',
          ordinal: 0,
          sourceSessionId: 'root',
          childSessionId: 'child',
          sourceMessageId: 'u1',
          childMessageId: 'cu1',
          sourceTimestamp: 1,
          sourceOrderKey: '0000000000001:00000001',
          sourceRowDigest: `sha256:${'5'.repeat(64)}`,
        },
        {
          forkId: 'fork-1',
          ordinal: 1,
          sourceSessionId: 'root',
          childSessionId: 'child',
          sourceMessageId: 'a1',
          childMessageId: 'ca1',
          sourceTimestamp: 2,
          sourceOrderKey: '0000000000002:00000002',
          sourceRowDigest: `sha256:${'6'.repeat(64)}`,
        },
      ],
    },
  };
}
