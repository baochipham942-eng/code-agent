import { describe, expect, it } from 'vitest';

import {
  EXTERNAL_FORK_CONTEXT_CAPABILITIES,
  ExternalForkContextError,
  buildValidatedExternalForkContextHandoff,
  composeExternalForkLaunchPrompt,
  type BuildExternalForkContextHandoffInput,
  type ExternalForkContextSupportedEngine,
} from '../../../../src/host/services/sessionFork/context';

const SOURCE_PREFIX_DIGEST = 'a'.repeat(64);

function mappedPrefix(): Array<BuildExternalForkContextHandoffInput['mappedActivePrefix'][number]> {
  return [
    {
      ordinal: 0,
      sourceMessageId: 'u1',
      childMessageId: 'cu1',
      message: {
        role: 'user',
        content: 'first question',
        timestamp: 1,
        visibility: 'active',
      },
    },
    {
      ordinal: 1,
      sourceMessageId: 'a1',
      childMessageId: 'ca1',
      message: {
        role: 'assistant',
        content: 'first answer',
        timestamp: 2,
        visibility: 'active',
      },
    },
    {
      ordinal: 2,
      sourceMessageId: 'u2',
      childMessageId: 'cu2',
      message: {
        role: 'user',
        content: 'second question',
        timestamp: 3,
        visibility: 'active',
        attachments: [{
          id: 'att-1',
          type: 'file',
          category: 'text',
          name: 'requirements.md',
          size: 42,
          mimeType: 'text/markdown',
          data: 'raw attachment bytes must not be delivered',
          path: '/Users/alice/private/requirements.md',
          metadata: { localOnly: true },
        }],
      },
    },
    {
      ordinal: 3,
      sourceMessageId: 'a2',
      childMessageId: 'ca2',
      message: {
        role: 'assistant',
        content: 'second answer',
        timestamp: 4,
        visibility: 'active',
        artifacts: [{
          id: 'artifact-1',
          type: 'document',
          title: 'Decision',
          content: 'mutable artifact body must not be delivered',
          version: 3,
        }],
      },
    },
  ];
}

function buildInput(
  engine: ExternalForkContextSupportedEngine = 'codex_cli',
  overrides: Partial<BuildExternalForkContextHandoffInput> = {},
): BuildExternalForkContextHandoffInput {
  return {
    engine,
    forkId: 'fork-1',
    sourceSessionId: 'source-session',
    childSessionId: 'child-session',
    sourceAnchorMessageId: 'a2',
    anchorChildMessageId: 'ca2',
    sourcePrefixDigest: SOURCE_PREFIX_DIGEST,
    mappedActivePrefix: mappedPrefix(),
    firstUserPrompt: 'continue from the branch',
    policy: {
      privacyMode: 'redact',
      tokenBudget: {
        maxInputTokens: 16_000,
        reservedOutputTokens: 4_000,
      },
      allowInternalMessages: false,
      allowAttachmentProvenance: true,
      allowReadOnlyArtifactProvenance: true,
    },
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('external fork context capability matrix', () => {
  it('supports only verified Codex and Claude stdin handoff paths', () => {
    expect(EXTERNAL_FORK_CONTEXT_CAPABILITIES).toMatchObject({
      codex_cli: {
        deliveryMode: 'validated_context_handoff',
        providerNativeFork: false,
        firstRunTransport: 'stdin_text',
      },
      claude_code: {
        deliveryMode: 'validated_context_handoff',
        providerNativeFork: false,
        firstRunTransport: 'stdin_text',
      },
      mimo_code: {
        deliveryMode: 'unsupported',
        providerNativeFork: false,
      },
      kimi_code: {
        deliveryMode: 'unsupported',
        providerNativeFork: false,
      },
    });
  });

  it.each(['mimo_code', 'kimi_code'] as const)('fails closed for %s', (engine) => {
    expect(() => buildValidatedExternalForkContextHandoff({
      ...buildInput(),
      engine,
    })).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'UNSUPPORTED_ENGINE',
    }));
  });
});

describe('buildValidatedExternalForkContextHandoff', () => {
  it('keeps the semantic payload digest stable when only createdAt changes', () => {
    const first = buildValidatedExternalForkContextHandoff(buildInput('codex_cli', {
      createdAt: 1_700_000_000_000,
    }));
    const retry = buildValidatedExternalForkContextHandoff(buildInput('codex_cli', {
      createdAt: 1_700_000_000_999,
    }));

    expect(retry.createdAt).not.toBe(first.createdAt);
    expect(retry.payloadDigest).toBe(first.payloadDigest);
  });

  it.each([
    ['toolCalls', [{
      id: 'tool-call-1',
      name: 'read_file',
      arguments: { path: '/private/secret.txt' },
    }]],
    ['toolResults', [{
      toolCallId: 'tool-call-1',
      success: true,
      output: 'private tool output',
    }]],
    ['contentParts', [{
      type: 'tool_call',
      toolCallId: 'tool-call-1',
    }]],
  ] as const)('fails closed when a mapped message contains non-empty %s', (field, value) => {
    const prefix = mappedPrefix();
    prefix[1] = {
      ...prefix[1],
      message: {
        ...prefix[1].message,
        [field]: value,
      },
    };

    expect(() => buildValidatedExternalForkContextHandoff(buildInput('codex_cli', {
      mappedActivePrefix: prefix,
    }))).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'TOOL_CONTEXT_REJECTED',
    }));
  });

  it('builds an immutable mapped prefix with metadata-only attachment and artifact provenance', () => {
    const handoff = buildValidatedExternalForkContextHandoff(buildInput());

    expect(handoff.messages.map((message) => [
      message.sourceMessageId,
      message.childMessageId,
      message.content,
    ])).toEqual([
      ['u1', 'cu1', 'first question'],
      ['a1', 'ca1', 'first answer'],
      ['u2', 'cu2', 'second question'],
      ['a2', 'ca2', 'second answer'],
    ]);
    expect(handoff).toMatchObject({
      scope: 'first_child_run',
      deliveryMode: 'validated_context_handoff',
      engine: 'codex_cli',
      providerNativeFork: false,
      sourceRuntimeIdentityCopied: false,
      privacy: {
        verdict: 'passed',
        redactedFieldCount: 0,
      },
      budget: {
        verdict: 'passed',
      },
    });
    expect(handoff.attachments).toEqual([
      expect.objectContaining({
        sourceMessageId: 'u2',
        attachmentId: 'att-1',
        name: 'requirements.md',
        access: 'read_only',
        contentIncluded: false,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(handoff.artifacts).toEqual([
      expect.objectContaining({
        sourceMessageId: 'a2',
        artifactId: 'artifact-1',
        access: 'read_only',
        contentIncluded: false,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(JSON.stringify(handoff)).not.toContain('raw attachment bytes');
    expect(JSON.stringify(handoff)).not.toContain('/Users/alice/private');
    expect(JSON.stringify(handoff)).not.toContain('mutable artifact body');
    expect(Object.isFrozen(handoff)).toBe(true);
    expect(Object.isFrozen(handoff.messages)).toBe(true);
    expect(Object.isFrozen(handoff.messages[0])).toBe(true);

    const launchPrompt = composeExternalForkLaunchPrompt({
      engine: 'codex_cli',
      handoff,
      prompt: 'continue from the branch',
    });
    expect(launchPrompt).toContain('first question');
    expect(launchPrompt).toContain('second answer');
    expect(launchPrompt).toContain('continue from the branch');
    expect(launchPrompt).toContain('provenance only and remain read-only');
    expect(launchPrompt).not.toContain('raw attachment bytes');
    expect(launchPrompt).not.toContain('mutable artifact body');
  });

  it('redacts sensitive prefix and first-prompt fields before external delivery', () => {
    const prefix = mappedPrefix();
    const handoff = buildValidatedExternalForkContextHandoff(buildInput('claude_code', {
      mappedActivePrefix: prefix.map((entry) => entry.ordinal === 0
        ? {
            ...entry,
            message: {
              ...entry.message,
              content: 'use sk-12345678901234567890 for the old request',
            },
          }
        : entry),
      firstUserPrompt: 'continue with Bearer abcdefghijklmnopqrstuvwxyz',
    }));

    expect(handoff.privacy).toEqual({
      mode: 'redact',
      verdict: 'passed_with_redactions',
      redactedFieldCount: 2,
    });
    const serialized = JSON.stringify(handoff);
    expect(serialized).not.toContain('12345678901234567890');
    expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyz');

    const launchPrompt = composeExternalForkLaunchPrompt({
      engine: 'claude_code',
      handoff,
      prompt: 'continue with Bearer abcdefghijklmnopqrstuvwxyz',
    });
    expect(launchPrompt).not.toContain('12345678901234567890');
    expect(launchPrompt).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(launchPrompt).toContain('[REDACTED]');
  });

  it('rejects sensitive material when policy requires rejection', () => {
    expect(() => buildValidatedExternalForkContextHandoff(buildInput('codex_cli', {
      firstUserPrompt: 'use sk-12345678901234567890',
      policy: {
        ...buildInput().policy,
        privacyMode: 'reject',
      },
    }))).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'PRIVACY_REJECTED',
    }));
  });

  it('fails closed instead of truncating a prefix that exceeds its budget', () => {
    expect(() => buildValidatedExternalForkContextHandoff(buildInput('codex_cli', {
      policy: {
        ...buildInput().policy,
        tokenBudget: {
          maxInputTokens: 512,
          reservedOutputTokens: 300,
        },
      },
    }))).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'TOKEN_BUDGET_EXCEEDED',
    }));
  });

  it('rejects hidden, reordered, or incomplete mapped prefixes', () => {
    const hiddenPrefix = mappedPrefix();
    hiddenPrefix[2] = {
      ...hiddenPrefix[2],
      message: {
        ...hiddenPrefix[2].message,
        visibility: 'rewound',
      },
    };
    expect(() => buildValidatedExternalForkContextHandoff(buildInput('codex_cli', {
      mappedActivePrefix: hiddenPrefix,
    }))).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'INVALID_PREFIX',
    }));

    const reordered = mappedPrefix();
    reordered[2] = { ...reordered[2], ordinal: 7 };
    expect(() => buildValidatedExternalForkContextHandoff(buildInput('codex_cli', {
      mappedActivePrefix: reordered,
    }))).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'INVALID_PREFIX',
    }));
  });

  it('rejects stale prompts, resume identity, and tampered payloads before launch', () => {
    const handoff = buildValidatedExternalForkContextHandoff(buildInput());

    expect(() => composeExternalForkLaunchPrompt({
      engine: 'codex_cli',
      handoff,
      prompt: 'different prompt',
    })).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'PROMPT_MISMATCH',
    }));

    expect(() => composeExternalForkLaunchPrompt({
      engine: 'codex_cli',
      handoff,
      prompt: 'continue from the branch',
      resumeLaunchPresent: true,
    })).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'IDENTITY_REUSE_FORBIDDEN',
    }));

    const tampered = {
      ...handoff,
      messages: handoff.messages.map((message, index) => index === 0
        ? { ...message, content: 'tampered' }
        : message),
    };
    expect(() => composeExternalForkLaunchPrompt({
      engine: 'codex_cli',
      handoff: tampered,
      prompt: 'continue from the branch',
    })).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'PAYLOAD_TAMPERED',
    }));

    const identityInjected = {
      ...handoff,
      externalSessionId: 'source-provider-session',
    };
    expect(() => composeExternalForkLaunchPrompt({
      engine: 'codex_cli',
      handoff: identityInjected as typeof handoff,
      prompt: 'continue from the branch',
    })).toThrowError(expect.objectContaining<Partial<ExternalForkContextError>>({
      code: 'IDENTITY_REUSE_FORBIDDEN',
    }));
  });
});
