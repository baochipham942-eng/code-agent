// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PublishVersionButton } from '../../../src/renderer/components/PublishVersionButton';
import { zh } from '../../../src/renderer/i18n';
const mocks = vi.hoisted(() => ({ invokeDomain: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/renderer/services/ipcService', () => ({ default: { invokeDomain: mocks.invokeDomain } }));
vi.mock('../../../src/renderer/hooks/useI18n', () => ({ useI18n: () => ({ t: zh }) }));
vi.mock('../../../src/renderer/hooks/useToast', () => ({ toast: mocks }));
const info = { publishState: { kind: 'draft' as const }, publishedVersions: [] };
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
it('opening and cancelling confirmation do not publish', () => {
  render(<PublishVersionButton filePath="/tmp/report.md" title="report.md" info={info} onPublished={vi.fn()} />);
  expect(mocks.invokeDomain).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '发布这一版' }));
  expect(screen.getByRole('dialog', { name: '发布这一版' })).toBeTruthy();
  expect(mocks.invokeDomain).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(mocks.invokeDomain).not.toHaveBeenCalled();
});
it('only confirmation invokes the existing host contract with the chosen file', async () => {
  const result = { ...info, publishedVersion: { version: 1 } };
  mocks.invokeDomain.mockResolvedValue(result);
  const onPublished = vi.fn();
  render(<PublishVersionButton filePath="/tmp/report.md" title="report.md" info={info} onPublished={onPublished} />);
  fireEvent.click(screen.getByRole('button', { name: '发布这一版' }));
  fireEvent.click(screen.getByRole('button', { name: zh.deliverable.publish }));
  await waitFor(() => expect(onPublished).toHaveBeenCalledWith(result));
  expect(mocks.invokeDomain).toHaveBeenCalledExactlyOnceWith('domain:workspace', 'publishVersion', { filePath: '/tmp/report.md', note: '' });
});
it('a failed host request keeps confirmation open and does not report publication', async () => {
  mocks.invokeDomain.mockRejectedValue(new Error('denied'));
  const onPublished = vi.fn();
  render(<PublishVersionButton filePath="/tmp/report.md" title="report.md" info={info} onPublished={onPublished} />);
  fireEvent.click(screen.getByRole('button', { name: '发布这一版' }));
  fireEvent.click(screen.getByRole('button', { name: zh.deliverable.publish }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(onPublished).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: '发布这一版' })).toBeTruthy();
});
