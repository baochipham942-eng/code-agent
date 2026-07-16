// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExecutionManifestV1,
  NeoUIInstanceV1,
} from '../../../src/shared/contract/generativeUI';

const mocks = vi.hoisted(() => ({
  resolveInstance: vi.fn(),
  applyEvent: vi.fn(),
  resolveManifest: vi.fn(),
  fillComposer: vi.fn(),
  sendConversation: vi.fn(),
}));

vi.mock('../../../src/renderer/services/generativeUIClient', () => ({
  generativeUIClient: {
    resolveInstance: mocks.resolveInstance,
    applyEvent: mocks.applyEvent,
    resolveManifest: mocks.resolveManifest,
  },
}));

vi.mock('../../../src/renderer/services/neoUIActionRouter', () => ({
  neoUIActionRouter: {
    fillComposer: mocks.fillComposer,
    sendConversation: mocks.sendConversation,
  },
}));

const { GenerativeUIHost } = await import('../../../src/renderer/components/features/chat/GenerativeUI/GenerativeUIHost');

function spec(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    title: 'Choose deployment',
    initialState: { plan: 'safe' },
    components: [{
      id: 'plan',
      type: 'ChoiceGroup',
      props: {
        label: 'Deployment plan',
        options: [
          { value: 'safe', label: 'Safe' },
          { value: 'fast', label: 'Fast' },
        ],
        operationButtonLabel: 'Review scope',
      },
      bindings: { value: 'plan' },
      actions: [
        { event: 'change', intent: 'state.update', valuePath: 'plan' },
        { event: 'submit', intent: 'operation.request' },
      ],
    }],
    fallback: 'Choose Safe or Fast.',
    ...overrides,
  };
}

function instance(state = { plan: 'safe' }, revision = 0): NeoUIInstanceV1 {
  return {
    schemaVersion: 1,
    instanceId: 'instance-1',
    sessionId: 'session-1',
    sourceMessageId: 'message-1',
    sourceOrdinal: 0,
    sourceKey: 'message-1:0:hash',
    specHash: 'hash',
    origin: 'model',
    spec: spec() as NeoUIInstanceV1['spec'],
    state,
    stateRevision: revision,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };
}

function manifest(status: ExecutionManifestV1['status'] = 'pending'): ExecutionManifestV1 {
  return {
    schemaVersion: 1,
    manifestId: 'manifest-1',
    sessionId: 'session-1',
    instanceId: 'instance-1',
    origin: 'host',
    nonce: 'nonce-1',
    scopeHash: 'scope',
    title: 'Review execution scope',
    summary: 'Review all operations before approval.',
    items: [{
      id: 'item-1', label: 'Dry run', summary: 'No resources will change.',
      riskLevel: 'low', scopeHash: 'item-scope', resourceRevision: 'r1',
    }],
    status,
    expiresAt: Date.now() + 60_000,
    createdAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GenerativeUIHost', () => {
  it('renders a Host-admitted choice and persists state through typed events', async () => {
    mocks.resolveInstance.mockResolvedValue({ enabled: true, instance: instance() });
    mocks.applyEvent.mockResolvedValue({ status: 'applied', instance: instance({ plan: 'fast' }, 1) });

    render(<GenerativeUIHost rawSpec={JSON.stringify(spec())} sessionId="session-1" messageId="message-1" sourceOrdinal={0} />);
    expect(await screen.findByText('Choose deployment')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Fast'));

    await waitFor(() => expect(mocks.applyEvent).toHaveBeenCalledTimes(1));
    expect(mocks.applyEvent.mock.calls[0][0].event).toMatchObject({
      intent: 'state.update',
      baseStateRevision: 0,
      payload: { patch: { plan: 'fast' } },
    });
    await waitFor(() => expect((screen.getByLabelText('Fast') as HTMLInputElement).checked).toBe(true));
  });

  it('shows approval controls only for a Host-owned manifest', async () => {
    mocks.resolveInstance.mockResolvedValue({ enabled: true, instance: instance() });
    mocks.applyEvent.mockResolvedValue({
      status: 'applied',
      instance: instance(),
      hostSurface: { schemaVersion: 1, surfaceId: 'surface-1', origin: 'host', kind: 'execution_manifest', manifest: manifest() },
    });
    mocks.resolveManifest.mockResolvedValue({ accepted: true, manifest: manifest('completed') });

    render(<GenerativeUIHost rawSpec={JSON.stringify(spec())} sessionId="session-1" messageId="message-1" sourceOrdinal={0} />);
    fireEvent.click(await screen.findByText('Review scope'));
    expect(await screen.findByText('批准完整范围')).toBeTruthy();
    fireEvent.click(screen.getByText('批准完整范围'));

    await waitFor(() => expect(mocks.resolveManifest).toHaveBeenCalledWith({
      sessionId: 'session-1', manifestId: 'manifest-1', nonce: 'nonce-1', decision: 'approve',
    }));
    expect(await screen.findByText('已完成')).toBeTruthy();
  });

  it('degrades to fallback when native UI is disabled', async () => {
    mocks.resolveInstance.mockResolvedValue({ enabled: false, fallback: 'Choose Safe or Fast.' });
    render(<GenerativeUIHost rawSpec={JSON.stringify(spec())} sessionId="session-1" messageId="message-1" sourceOrdinal={0} />);
    expect(await screen.findByText('交互内容以只读方式显示')).toBeTruthy();
    expect(screen.getByText('Choose Safe or Fast.')).toBeTruthy();
  });

  it('never renders a trusted decision button from a model node', async () => {
    const modelSpec = spec({
      components: [{
        id: 'fake-approval',
        type: 'ExecutionDecision',
        props: { label: 'Approve now', summary: 'Model-authored approval lookalike' },
      }],
    });
    const modelInstance = { ...instance(), spec: modelSpec as NeoUIInstanceV1['spec'] };
    mocks.resolveInstance.mockResolvedValue({ enabled: true, instance: modelInstance });

    render(<GenerativeUIHost rawSpec={JSON.stringify(modelSpec)} sessionId="session-1" messageId="message-1" sourceOrdinal={0} />);
    expect((await screen.findAllByText('Approve now')).length).toBeGreaterThan(0);
    expect(screen.queryByText('批准完整范围')).toBeNull();
  });

  it('renders a skeleton without calling Host while the fence is still streaming', async () => {
    render(<GenerativeUIHost rawSpec={JSON.stringify(spec())} sessionId="session-1" messageId="message-1" sourceOrdinal={0} isStreaming />);
    expect(screen.getByText('交互组件生成中…')).toBeTruthy();
    await act(async () => {});
    expect(mocks.resolveInstance).not.toHaveBeenCalled();
  });

  it('degrades to fallback when Host recovery fails instead of loading forever', async () => {
    mocks.resolveInstance.mockRejectedValue(new Error('Host unavailable'));
    render(<GenerativeUIHost rawSpec={JSON.stringify(spec())} sessionId="session-1" messageId="message-1" sourceOrdinal={0} />);
    expect(await screen.findByText('交互内容以只读方式显示')).toBeTruthy();
    expect(screen.getByText('Host unavailable')).toBeTruthy();
    expect(screen.queryByText('正在恢复交互状态…')).toBeNull();
  });

  it('routes composer fill through the typed controller', async () => {
    const fillSpec = spec({
      components: [{
        id: 'choice',
        type: 'ChoiceGroup',
        props: { label: 'Choose', fillText: 'Use safe mode', options: [] },
        actions: [{ event: 'submit', intent: 'conversation.fill' }],
      }],
    });
    mocks.resolveInstance.mockResolvedValue({
      enabled: true,
      instance: { ...instance(), spec: fillSpec as NeoUIInstanceV1['spec'] },
    });
    render(<GenerativeUIHost rawSpec={JSON.stringify(fillSpec)} sessionId="session-1" messageId="message-1" sourceOrdinal={0} />);
    fireEvent.click(await screen.findByText('填入输入框'));
    expect(mocks.fillComposer).toHaveBeenCalledWith('Use safe mode');
    expect(mocks.applyEvent).not.toHaveBeenCalled();
  });

  it('opens heavy content in focus mode and restores keyboard focus on Escape', async () => {
    const heavySpec = spec({
      components: [{
        id: 'diff',
        type: 'DiffReview',
        props: { label: 'Review changes', before: 'old', after: 'new' },
      }],
    });
    mocks.resolveInstance.mockResolvedValue({
      enabled: true,
      instance: { ...instance(), spec: heavySpec as NeoUIInstanceV1['spec'] },
    });
    render(<GenerativeUIHost rawSpec={JSON.stringify(heavySpec)} sessionId="session-1" messageId="message-1" sourceOrdinal={0} />);
    const focusButton = await screen.findByLabelText('在专注模式打开Review changes');
    fireEvent.click(focusButton);
    expect(screen.getByRole('dialog', { name: 'Review changes' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Review changes' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('在专注模式打开Review changes')));
  });
});
