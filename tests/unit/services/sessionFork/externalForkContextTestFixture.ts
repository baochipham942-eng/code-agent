import {
  buildValidatedExternalForkContextHandoff,
  type ExternalForkContextHandoff,
  type ExternalForkContextSupportedEngine,
} from '../../../../src/host/services/sessionFork/context';

export function buildTestExternalForkContextHandoff(
  engine: ExternalForkContextSupportedEngine,
  firstUserPrompt = 'continue the branch',
): ExternalForkContextHandoff {
  return buildValidatedExternalForkContextHandoff({
    engine,
    forkId: engine === 'codex_cli' ? 'fork-codex' : 'fork-claude',
    sourceSessionId: 'source-session',
    childSessionId: 'child-session',
    sourceAnchorMessageId: 'a2',
    anchorChildMessageId: 'ca2',
    sourcePrefixDigest: (engine === 'codex_cli' ? 'a' : 'b').repeat(64),
    mappedActivePrefix: [
      {
        ordinal: 0,
        sourceMessageId: 'u1',
        childMessageId: 'cu1',
        message: { role: 'user', content: 'question one', timestamp: 1, visibility: 'active' },
      },
      {
        ordinal: 1,
        sourceMessageId: 'a1',
        childMessageId: 'ca1',
        message: { role: 'assistant', content: 'answer one', timestamp: 2, visibility: 'active' },
      },
      {
        ordinal: 2,
        sourceMessageId: 'u2',
        childMessageId: 'cu2',
        message: { role: 'user', content: 'question two', timestamp: 3, visibility: 'active' },
      },
      {
        ordinal: 3,
        sourceMessageId: 'a2',
        childMessageId: 'ca2',
        message: { role: 'assistant', content: 'answer two', timestamp: 4, visibility: 'active' },
      },
    ],
    firstUserPrompt,
    policy: {
      privacyMode: 'redact',
      tokenBudget: { maxInputTokens: 8_000, reservedOutputTokens: 2_000 },
      allowInternalMessages: false,
      allowAttachmentProvenance: true,
      allowReadOnlyArtifactProvenance: true,
    },
    createdAt: 1_700_000_000_000,
  });
}
