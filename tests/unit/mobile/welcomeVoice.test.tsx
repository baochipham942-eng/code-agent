// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MobileRoot } from '../../../packages/mobile/src/app/MobileRoot';
import type { PlatformPorts } from '../../../packages/mobile/src/platform/ports';
import { createIdentity } from '../../../src/shared/companion/noiseChannel';
import { toHex } from '../../../src/shared/companion/lanProtocol';
import type { CompanionRead } from '../../../src/shared/contract/companionLibrary';
import { messages } from '../../../packages/mobile/src/i18n';

/**
 * N-MOBILE-WELCOME-VOICE：欢迎页有麦克风；转写不绑会话、不建空会话；模型胶囊可换。
 */
const text = messages('zh');
const HOST = 'aa'.repeat(32);

const harness = vi.hoisted(() => ({
  commands: [] as { action: string; sessionId: string | null }[],
  host: new Map<string, { commandId: string; deviceId: string; sessionId: string | null; action: string; payload: { text?: string; model?: string; provider?: string } }>(),
  transcribeAccepted: true,
  transcribeCode: 'COMPANION_TRANSCRIPTION_FAILED',
  sessionless: true,
  transcription: 'ready' as 'ready' | 'not-installed' | 'no-key' | undefined,
  recorderStart: async () => {},
}));

vi.mock('../../../packages/mobile/src/platform/lanCompanionClient', () => ({
  LanCompanionClient: class {
    async recover() {
      return {
        version: 1 as const, endpoint: 'http://192.168.1.2:8182', hostKey: HOST, deviceId: 'phone-1', scopeEpoch: 1,
        scope: ['project:one'],
        ...(harness.sessionless ? { sessionlessTranscribe: true as const } : {}),
        ...(harness.transcription ? { transcription: harness.transcription } : {}),
      };
    }
    async request(payload: unknown) {
      const action = (payload as { action?: string }).action;
      if (action === 'read') {
        const query = (payload as { query?: CompanionRead }).query;
        if (query?.kind === 'history') return { sessionId: query.sessionId, messages: [], nextOffset: null };
        if (query?.kind === 'artifacts') return { sessionId: query.sessionId, artifacts: [] };
        return {
          nextOffset: null,
          projects: [{ id: 'one', name: 'One', canCreate: true, workspacePath: '/w/one' }],
          sessions: [{ id: 's1', title: '已有会话', projectId: 'one', updatedAt: 9, archived: false, provider: 'deepseek', model: 'deepseek-chat' }],
          models: [
            { provider: 'moonshot', model: 'kimi-k2.6', label: 'Kimi', providerLabel: 'Kimi' },
            { provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek Chat', providerLabel: 'DeepSeek', isDefault: true },
          ],
        };
      }
      const record = (command: { commandId: string; deviceId: string; sessionId: string | null; action: string }, state: string, result: Record<string, unknown>) =>
        ({ commandId: command.commandId, deviceId: command.deviceId, sessionId: command.sessionId, action: command.action, state, createdAt: Date.now(), result });
      if (action === 'command') {
        const command = (payload as { command: { commandId: string; deviceId: string; sessionId?: string | null; action: string; payload: { text?: string; model?: string; provider?: string } } }).command;
        harness.commands.push({ action: command.action, sessionId: command.sessionId ?? null });
        if (command.action === 'session.create') return { kind: 'rejected', reason: 'scope_denied' };
        if (command.action === 'voice.transcribe') {
          harness.host.set(command.commandId, { ...command, sessionId: command.sessionId ?? null });
          return { kind: 'accepted', command: record({ ...command, sessionId: command.sessionId ?? null }, 'reconciling', { code: 'COMMAND_RECONCILING' }) };
        }
        return { kind: 'rejected', reason: 'scope_denied' };
      }
      if (action === 'status') {
        const command = harness.host.get((payload as { commandId: string }).commandId);
        if (!command) return null;
        return harness.transcribeAccepted
          ? record(command, 'accepted', { text: '欢迎页口述' })
          : record(command, 'rejected', { code: harness.transcribeCode });
      }
      return { kind: 'events', epoch: 1, nextSeq: 0, events: [] };
    }
    close() {}
  },
}));

function savedProjectsOnly(): string {
  const identity = createIdentity();
  return JSON.stringify({
    version: 1, publicKey: toHex(identity.publicKey), secretKey: toHex(identity.secretKey),
    binding: {
      version: 1, endpoint: 'http://192.168.1.2:8182', hostKey: HOST, deviceId: 'phone-1', scopeEpoch: 1, scope: ['project:one'],
      sessionlessTranscribe: true, transcription: 'ready',
    },
  });
}

const ports = (recorder = true): PlatformPorts => ({
  preferences: { get: async () => null, set: async () => {} },
  appInfo: { read: async () => ({ version: '0.1.0', build: '51' }) },
  lifecycle: { subscribe: async () => () => {}, leave: async () => {} },
  keyboard: { subscribe: async () => () => {}, subscribeFrame: async () => () => {}, hide: async () => {} },
  companion: { read: async () => savedProjectsOnly(), write: async () => {}, scan: async () => { throw new Error('unused'); }, post: async () => ({}) },
  recorder: recorder ? {
    start: () => harness.recorderStart(),
    stop: async () => ({ audioData: 'YXVkaW8=', mimeType: 'audio/aac', durationMs: 1000 }),
  } : undefined,
});

const textOf = (selector: string) => document.querySelector(selector)?.textContent ?? '';

beforeEach(() => {
  harness.commands = []; harness.host.clear(); harness.transcribeAccepted = true;
  harness.transcribeCode = 'COMPANION_TRANSCRIPTION_FAILED';
  harness.sessionless = true; harness.transcription = 'ready';
  harness.recorderStart = async () => {};
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  Object.defineProperty(window.navigator, 'language', { value: 'zh-CN', configurable: true });
});
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

async function mountWelcome() {
  await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
  await waitFor(() => { expect(document.querySelector('[data-testid="project-pick"]')).toBeTruthy(); });
}

describe('欢迎页麦克风与模型胶囊', () => {
  it('没选会话也有麦克风，录完文字进欢迎页草稿、不自动发送、不建会话', async () => {
    await mountWelcome();
    expect(document.querySelector('.welcome h1')!.textContent).toBe(text.welcome);
    const mic = document.querySelector(`[aria-label="${text.voice}"]`) as HTMLButtonElement;
    expect(mic).toBeTruthy();
    fireEvent.click(mic);
    fireEvent.click(await waitFor(() => {
      const stop = document.querySelector(`[aria-label="${text.stopRecording}"]`) as HTMLElement | null;
      expect(stop).toBeTruthy();
      return stop!;
    }));
    await waitFor(() => {
      expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).value).toContain('欢迎页口述');
    });
    expect(harness.commands.filter(c => c.action === 'session.create')).toEqual([]);
    expect(harness.commands.some(c => c.action === 'voice.transcribe' && c.sessionId === null)).toBe(true);
    expect(harness.commands.some(c => c.action === 'message.send')).toBe(false);
    expect(document.querySelector('.welcome h1')!.textContent).toBe(text.welcome);
  });

  it('旧宿主不声明无会话转写时欢迎页不显示麦克风', async () => {
    harness.sessionless = false;
    await act(async () => { render(<MobileRoot ports={ports()} fixtures={false} />); });
    await waitFor(() => { expect(document.querySelector('[data-testid="project-pick"]')).toBeTruthy(); });
    expect(document.querySelector(`[aria-label="${text.voice}"]`)).toBeNull();
  });

  it('欢迎页输入框显示新任务默认模型，可点开换，发送后用所选模型建会话', async () => {
    await mountWelcome();
    const capsule = document.querySelector('.composer-tools .model') as HTMLElement;
    expect(capsule.textContent).toContain('DeepSeek Chat');
    fireEvent.click(capsule);
    await waitFor(() => { expect(document.querySelector('[data-testid="model-moonshot:kimi-k2.6"]')).toBeTruthy(); });
    fireEvent.click(document.querySelector('[data-testid="model-moonshot:kimi-k2.6"]') as HTMLElement);
    await waitFor(() => { expect(textOf('.composer-tools .model')).toContain('Kimi'); });
  });

  it('转写失败也不建会话', async () => {
    harness.transcribeAccepted = false;
    await mountWelcome();
    fireEvent.click(document.querySelector(`[aria-label="${text.voice}"]`) as HTMLElement);
    fireEvent.click(await waitFor(() => {
      const stop = document.querySelector(`[aria-label="${text.stopRecording}"]`) as HTMLElement | null;
      expect(stop).toBeTruthy();
      return stop!;
    }));
    await waitFor(() => { expect(document.querySelector('[data-testid="status-slot"]')?.textContent).toContain('这段没转成文字'); });
    expect(harness.commands.filter(c => c.action === 'session.create')).toEqual([]);
    expect(document.querySelector('.welcome h1')!.textContent).toBe(text.welcome);
  });

  it('录音取消不产生会话', async () => {
    await mountWelcome();
    fireEvent.click(document.querySelector(`[aria-label="${text.voice}"]`) as HTMLElement);
    fireEvent.click(await waitFor(() => document.querySelector(`[aria-label="${text.cancelRecording}"]`) as HTMLElement));
    expect(harness.commands.filter(c => c.action === 'session.create')).toEqual([]);
    expect(document.querySelector('.welcome h1')!.textContent).toBe(text.welcome);
  });
});

const statusNotice = () => document.querySelector('[data-testid="status-slot"]') as HTMLElement | null;
const micButton = () => document.querySelector(`[aria-label="${text.voice}"]`) as HTMLButtonElement | null;

describe('MobileRoot 把 binding.transcription 传到输入区', () => {
  it('未就绪点麦克风不开录，状态位「电脑上还没开语音转写」', async () => {
    harness.transcription = 'not-installed';
    const start = vi.fn(async () => {});
    harness.recorderStart = start;
    await mountWelcome();
    fireEvent.click(micButton()!);
    await waitFor(() => expect(statusNotice()?.textContent).toContain('电脑上还没开语音转写'));
    expect(start).not.toHaveBeenCalled();
    expect(document.querySelector('.voice-composer')).toBeNull();
    expect(document.querySelector(`[aria-label="${text.stopRecording}"]`)).toBeNull();
  });

  it('stale not-installed → 开好了 → 再点麦克风真的开录', async () => {
    harness.transcription = 'not-installed';
    const start = vi.fn(async () => {});
    harness.recorderStart = start;
    await mountWelcome();
    fireEvent.click(micButton()!);
    await waitFor(() => expect(statusNotice()?.textContent).toContain('电脑上还没开语音转写'));
    fireEvent.click(document.querySelector('[data-testid="status-action"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-testid="voice-setup"]')).toBeTruthy());
    fireEvent.click(document.querySelector('[data-testid="voice-setup-done"]') as HTMLElement);
    await waitFor(() => expect(document.querySelector('[data-testid="voice-setup"]')).toBeNull());
    await waitFor(() => expect(micButton()?.disabled).toBe(false));
    fireEvent.click(micButton()!);
    await waitFor(() => expect(document.querySelector(`[aria-label="${text.stopRecording}"]`)).toBeTruthy());
    expect(start).toHaveBeenCalled();
  });

  it('accepted 后状态位不再拦下一次开录', async () => {
    harness.transcription = 'not-installed';
    const start = vi.fn(async () => {});
    harness.recorderStart = start;
    await mountWelcome();
    fireEvent.click(micButton()!);
    await waitFor(() => expect(statusNotice()?.textContent).toContain('电脑上还没开语音转写'));
    fireEvent.click(document.querySelector('[data-testid="status-action"]') as HTMLElement);
    fireEvent.click(await waitFor(() => document.querySelector('[data-testid="voice-setup-done"]') as HTMLElement));
    await waitFor(() => expect(document.querySelector('[data-testid="voice-setup"]')).toBeNull());
    await waitFor(() => expect(micButton()?.disabled).toBe(false));
    fireEvent.click(micButton()!);
    fireEvent.click(await waitFor(() => {
      const stop = document.querySelector(`[aria-label="${text.stopRecording}"]`) as HTMLElement | null;
      expect(stop).toBeTruthy();
      return stop!;
    }));
    await waitFor(() => {
      expect((document.querySelector('[data-testid="draft"]') as HTMLTextAreaElement).value).toContain('欢迎页口述');
    });
    expect(statusNotice()?.textContent ?? '').not.toContain('电脑上还没开语音转写');
    fireEvent.click(micButton()!);
    await waitFor(() => expect(document.querySelector(`[aria-label="${text.stopRecording}"]`)).toBeTruthy());
    expect(start).toHaveBeenCalledTimes(2);
  });
});

