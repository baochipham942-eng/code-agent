// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AttachmentSheet } from '../../../packages/mobile/src/features/sessions/AttachmentSheet';
import { messages } from '../../../packages/mobile/src/i18n';
import { createMobileStore } from '../../../packages/mobile/src/stores/mobileStore';
import { pickAttachment } from '../../../packages/mobile/src/platform/cameraPick';

const zh = messages('zh');
const en = messages('en');

afterEach(cleanup);

describe('添加材料三选一 sheet 渲染与路由', () => {
  it('renders photo, camera and file in the design order and routes each kind', () => {
    const onPick = vi.fn();
    render(<AttachmentSheet mode="attachment" text={zh} onPick={onPick} onOpenSettings={() => {}} />);
    const labels = [...document.querySelectorAll('.attach-row')].map(row => row.textContent);
    expect(labels[0]).toContain(zh.attachPhoto);
    expect(labels[0]).toContain(zh.attachPhotoHint);
    expect(labels[1]).toContain(zh.attachCamera);
    expect(labels[2]).toContain(zh.attachFile);
    fireEvent.click(screen.getByTestId('attach-photo'));
    fireEvent.click(screen.getByTestId('attach-camera'));
    fireEvent.click(screen.getByTestId('attach-file'));
    expect(onPick.mock.calls.map(call => call[0])).toEqual(['image', 'camera', 'file']);
  });

  it('cameraDenied explains the block, offers settings and photos, and never looks like an upload failure', () => {
    const onPick = vi.fn();
    const onOpenSettings = vi.fn();
    render(<AttachmentSheet mode="cameraDenied" text={zh} onPick={onPick} onOpenSettings={onOpenSettings} />);
    expect(screen.getByTestId('camera-denied').textContent).toContain(zh.cameraDeniedBody);
    expect(screen.queryByText(zh.attachFailed)).toBeNull();
    expect(screen.queryByText(zh.uploadTooLarge)).toBeNull();
    fireEvent.click(screen.getByTestId('camera-open-settings'));
    fireEvent.click(screen.getByTestId('camera-pick-photo'));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledWith('image');
  });

  it('keeps English copy for the same three actions and denied body', () => {
    render(<AttachmentSheet mode="attachment" text={en} onPick={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByTestId('attach-camera').textContent).toContain(en.attachCamera);
    cleanup();
    render(<AttachmentSheet mode="cameraDenied" text={en} onPick={() => {}} onOpenSettings={() => {}} />);
    expect(screen.getByTestId('camera-denied').textContent).toContain(en.cameraDeniedBody);
  });

  it('denial from pickAttachment pushes cameraDenied on the existing attachment sheet', async () => {
    const disk = { get: async () => null, set: async () => {} };
    const store = createMobileStore(disk);
    await store.getState().hydrate();
    store.getState().openSheet('attachment');
    const outcome = await pickAttachment(async () => { throw new Error('CAMERA_DENIED'); }, 'camera', async () => {});
    expect(outcome).toBe('denied');
    if (store.getState().sheet) store.getState().pushSheet('cameraDenied');
    expect(store.getState().sheet?.pages).toEqual(['attachment', 'cameraDenied']);
  });
});
