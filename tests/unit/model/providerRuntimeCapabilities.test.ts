import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertExternalRuntimeAttachments,
  assertProviderRuntimeCapability,
  collectNativeRequestCapabilities,
  getProviderRuntimeCapabilityEntry,
  PROVIDER_RUNTIME_CAPABILITIES,
  PROVIDER_RUNTIME_CAPABILITY_MATRIX,
  PROVIDER_RUNTIME_CAPABILITY_STATUSES,
  ProviderRuntimeCapabilityError,
  resolveNativeProtocolFamily,
  validateSupportedCapabilityEvidence,
  type ProviderProtocolFamily,
  type ProviderRuntimeCapability,
  type ProviderRuntimeId,
} from '../../../src/host/model/providerRuntimeCapabilities';
import { buildCodexCliArgs } from '../../../src/host/services/agentEngine/codexCliAdapter';
import { buildClaudeCodeArgs } from '../../../src/host/services/agentEngine/claudeCodeAdapter';
import { buildMimoArgs } from '../../../src/host/services/agentEngine/mimoCliAdapter';
import { buildKimiArgs } from '../../../src/host/services/agentEngine/kimiCliAdapter';
import type { InferenceOptions, ModelMessage } from '../../../src/host/model/types';
import type { ModelConfig } from '../../../src/shared/contract/model';
import { PROVIDER_REGISTRY } from '../../../src/host/model/providerRegistry';

const ROOT = process.cwd();
const FIXTURE_ROOT = path.join(ROOT, 'docs/capabilities/request-shapes');
const LEDGER_PATH = path.join(ROOT, 'docs/capabilities/provider-runtime-live-smoke-ledger.json');

interface NativeFixture {
  runtime: 'native';
  protocolFamily: ProviderProtocolFamily;
  adapterBoundary: string;
  syntheticRequest: {
    provider: string;
    model: string;
    messages: string[];
    toolsPresent: boolean;
    toolChoice?: 'auto' | 'none' | 'required' | 'named';
    reasoningEffort?: 'low' | 'medium' | 'high';
    streaming: boolean;
    abortSignal: boolean;
    requestTimeoutMs?: number;
  };
  expectedRequestedCapabilities: ProviderRuntimeCapability[];
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function buildFixtureMessages(labels: string[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (labels.includes('system:text')) messages.push({ role: 'system', content: '<synthetic-system>' });
  const content: ModelMessage['content'] = labels.includes('user:image-base64')
    ? [
        { type: 'text', text: '<synthetic-user>' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' } },
      ]
    : '<synthetic-user>';
  messages.push({ role: 'user', content });
  return messages;
}

describe('Provider × Runtime capability matrix', () => {
  it('covers every declared capability with an allowed four-state value', () => {
    expect(PROVIDER_RUNTIME_CAPABILITY_MATRIX).toHaveLength(10);
    for (const entry of PROVIDER_RUNTIME_CAPABILITY_MATRIX) {
      expect(Object.keys(entry.capabilities).sort()).toEqual([...PROVIDER_RUNTIME_CAPABILITIES].sort());
      for (const capability of PROVIDER_RUNTIME_CAPABILITIES) {
        expect(PROVIDER_RUNTIME_CAPABILITY_STATUSES).toContain(entry.capabilities[capability].status);
      }
    }
  });

  it('covers every registered Native provider without using the web-search matrix', () => {
    const coveredProviders = new Set(
      PROVIDER_RUNTIME_CAPABILITY_MATRIX
        .filter((entry) => entry.runtime === 'native')
        .flatMap((entry) => entry.providerScope),
    );
    for (const provider of Object.keys(PROVIDER_REGISTRY)) {
      expect(coveredProviders.has(provider), `missing Native provider ${provider}`).toBe(true);
    }
  });

  it('requires fixture, automated test, and verified ledger evidence for every supported cell', () => {
    expect(validateSupportedCapabilityEvidence()).toEqual([]);
    const ledger = readJson<{ records: Array<{ id: string; verificationStatus: string }> }>(LEDGER_PATH);
    const ledgerById = new Map(ledger.records.map((record) => [record.id, record]));

    const verifyEvidence = (
      status: string,
      evidence: { requestFixture: string; automatedTest: string; liveSmokeLedgerId: string } | undefined,
    ) => {
      if (!evidence) {
        expect(status).not.toBe('supported');
        return;
      }
      expect(fs.existsSync(path.join(ROOT, evidence.requestFixture))).toBe(true);
      expect(fs.existsSync(path.join(ROOT, evidence.automatedTest))).toBe(true);
      const ledgerId = evidence.liveSmokeLedgerId.split('#')[1];
      expect(ledgerById.has(ledgerId)).toBe(true);
      if (status === 'supported') expect(ledgerById.get(ledgerId)?.verificationStatus).toBe('verified');
    };

    for (const entry of PROVIDER_RUNTIME_CAPABILITY_MATRIX) {
      for (const capability of PROVIDER_RUNTIME_CAPABILITIES) {
        const cell = entry.capabilities[capability];
        verifyEvidence(cell.status, cell.evidence);
      }
      for (const overrides of Object.values(entry.capabilityOverrides ?? {})) {
        for (const cell of Object.values(overrides)) {
          if (cell) verifyEvidence(cell.status, cell.evidence);
        }
      }
    }
  });

  it('keeps every evidence fixture synthetic and credential-free', () => {
    for (const fileName of fs.readdirSync(FIXTURE_ROOT)) {
      const content = fs.readFileSync(path.join(FIXTURE_ROOT, fileName), 'utf8');
      expect(content).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
      expect(content).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/i);
      expect(content).not.toMatch(/"(?:apiKey|cookie|password|token)"\s*:\s*"(?!omitted|none|values-not-recorded)/i);
    }
  });

  it.each([
    'native-anthropic-messages.json',
    'native-openai-chat-completions.json',
    'native-openai-compatible-gateway.json',
    'native-ollama-litellm-local.json',
    'native-google-generative-language.json',
  ])('matches native request capability collection for %s', (fileName) => {
    const fixture = readJson<NativeFixture>(path.join(FIXTURE_ROOT, fileName));
    const request = fixture.syntheticRequest;
    const config: ModelConfig = {
      provider: request.provider,
      model: request.model,
      ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
    };
    const options: InferenceOptions = {
      ...(request.toolChoice === 'named'
        ? { toolChoice: { type: 'tool', toolName: 'fixture_tool' } as const }
        : request.toolChoice ? { toolChoice: request.toolChoice } : {}),
      ...(request.requestTimeoutMs !== undefined ? { requestTimeoutMs: request.requestTimeoutMs } : {}),
    };
    const actual = collectNativeRequestCapabilities(
      buildFixtureMessages(request.messages),
      request.toolsPresent,
      config,
      request.streaming,
      request.abortSignal ? new AbortController().signal : undefined,
      options,
    );

    expect(resolveNativeProtocolFamily(config)).toBe(fixture.protocolFamily);
    expect(getProviderRuntimeCapabilityEntry('native', fixture.protocolFamily).adapterBoundary)
      .toBe(fixture.adapterBoundary);
    expect(actual).toEqual(fixture.expectedRequestedCapabilities);
  });

  it('fails closed for unknown and unsupported capabilities before request dispatch', () => {
    expect(() => assertProviderRuntimeCapability('native', 'ollama_litellm_local', 'reasoning_effort'))
      .toThrow(ProviderRuntimeCapabilityError);
    expect(() => assertProviderRuntimeCapability('native', 'openai_responses', 'text_streaming'))
      .toThrow(ProviderRuntimeCapabilityError);
    expect(() => assertExternalRuntimeAttachments('codex_cli', 1, 'Codex CLI P0'))
      .toThrow('Codex CLI P0 engine only supports text prompts.');
  });

  it('keeps external CLI fixtures aligned with exported adapter argument builders', () => {
    const cases: Array<{ runtime: ProviderRuntimeId; fixture: string; args: string[] }> = [
      {
        runtime: 'codex_cli',
        fixture: 'runtime-codex-cli.json',
        args: buildCodexCliArgs({
          model: 'fixture-model',
          sandbox: 'read-only',
          cwd: '<workspace>',
          lastMessagePath: '<last-message-path>',
        }),
      },
      { runtime: 'claude_code', fixture: 'runtime-claude-code.json', args: buildClaudeCodeArgs('read_only', 'fixture-model') },
      { runtime: 'mimo_code', fixture: 'runtime-mimo-code.json', args: buildMimoArgs('<redacted-user-content>', 'fixture-model') },
      { runtime: 'kimi_code', fixture: 'runtime-kimi-code.json', args: buildKimiArgs('<redacted-user-content>', 'fixture-model') },
    ];

    for (const item of cases) {
      const fixture = readJson<{ runtime: ProviderRuntimeId; syntheticRequest: { args: string[] } }>(
        path.join(FIXTURE_ROOT, item.fixture),
      );
      expect(fixture.runtime).toBe(item.runtime);
      expect(item.args).toEqual(fixture.syntheticRequest.args);
    }
  });
});
