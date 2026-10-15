// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { IPC_DOMAINS } from '../../../src/shared/ipc';
import type { VoiceUserProfileView } from '../../../src/shared/contract/voice';

const state = vi.hoisted(() => ({ invoke: vi.fn(), language: 'zh' }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({ t: state.language === 'zh' ? zh : en }),
}));
vi.mock('../../../src/renderer/services/ipcService', () => ({
  default: { invokeDomain: (...args: unknown[]) => state.invoke(...args) },
}));
import { VoiceUserProfileSettings } from '../../../src/renderer/components/features/settings/tabs/VoiceUserProfileSettings';

const automatic = '[Context — User profile]\n- 用户从事策展工作\n最近在做：秋季图录';
let saved: VoiceUserProfileView;
beforeEach(() => {
  state.language = 'zh';
  saved = { enabled: true, override: null, text: automatic };
  state.invoke.mockReset().mockImplementation(async (_domain, action, payload) => {
    if (action === 'setUserProfile') {
      saved = { ...payload, text: payload.enabled ? payload.override ?? automatic : '' };
    }
    return { ...saved };
  });
});
afterEach(cleanup);

it('shows exact host text, saves edits, reloads the override and regenerates', async () => {
  const mounted = render(<VoiceUserProfileSettings />);
  const editor = await screen.findByRole('textbox', { name: '本次通话 Neo 知道的关于你' });
  expect(screen.getByTestId('voice-user-profile-preview').textContent).toBe(automatic);
  fireEvent.change(editor, { target: { value: '用户正在准备出版图录。' } });
  expect(screen.getByTestId('voice-user-profile-preview').textContent).toBe(automatic);
  fireEvent.click(screen.getByRole('button', { name: zh.voice.settings.profileSave }));
  await waitFor(() => expect(saved.override).toBe('用户正在准备出版图录。'));
  expect(state.invoke).toHaveBeenCalledWith(IPC_DOMAINS.VOICE, 'setUserProfile', { enabled: true, override: saved.override });
  await waitFor(() => expect(screen.getByTestId('voice-user-profile-preview').textContent).toBe(saved.override));
  mounted.unmount();
  render(<VoiceUserProfileSettings />);
  await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(saved.override));
  fireEvent.click(screen.getByRole('button', { name: zh.voice.settings.profileRegenerate }));
  await waitFor(() => expect(screen.getByTestId('voice-user-profile-preview').textContent).toBe(automatic));
  expect(saved.override).toBeNull();
});

it('turns off injection while preserving the override and restores it on enable', async () => {
  saved = { enabled: true, override: '用户喜欢简短说明。', text: '用户喜欢简短说明。' };
  render(<VoiceUserProfileSettings />);
  fireEvent.click(await screen.findByRole('switch', { name: zh.voice.settings.profileEnabled }));
  await screen.findByText(zh.voice.settings.profileOff);
  expect(screen.getByTestId('voice-user-profile-preview').textContent).toBe('');
  expect(saved).toEqual({ enabled: false, override: '用户喜欢简短说明。', text: '' });
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() => expect(screen.getByTestId('voice-user-profile-preview').textContent).toBe('用户喜欢简短说明。'));
});

it('keeps the last saved preview on failed writes and reports failure', async () => {
  render(<VoiceUserProfileSettings />);
  const editor = await screen.findByRole('textbox');
  state.invoke.mockRejectedValueOnce(new Error('VOICE_USER_PROFILE_INVALID'));
  fireEvent.change(editor, { target: { value: '你是我的儿子' } });
  fireEvent.click(screen.getByRole('button', { name: zh.voice.settings.profileSave }));
  await screen.findByRole('alert');
  expect(screen.getByTestId('voice-user-profile-preview').textContent).toBe(automatic);
});

it('localizes controls in English and reports load failures', async () => {
  state.language = 'en';
  state.invoke.mockRejectedValueOnce(new Error('unavailable'));
  render(<VoiceUserProfileSettings />);
  expect(screen.getByRole('heading').textContent).toBe(en.voice.settings.profileTitle);
  expect((await screen.findByRole('alert')).textContent).toBe(en.voice.settings.profileError);
  expect(screen.queryByRole('switch')).toBeNull();
});
