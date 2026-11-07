// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsSearch } from '../../../src/renderer/components/features/settings/SettingsSearch';

afterEach(cleanup);

function search(externalImportAvailable?: boolean) {
  const onNavigate = vi.fn();
  render(<SettingsSearch onNavigate={onNavigate} externalImportAvailable={externalImportAvailable} />);
  const input = screen.getByRole('textbox');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '导入' } });
  return onNavigate;
}

describe('SettingsSearch externalImportAvailable prop', () => {
  it('shows the import page result and navigates to it when true', () => {
    const onNavigate = search(true);
    fireEvent.click(screen.getByRole('button', { name: /从其他 AI 应用导入/ }));
    expect(onNavigate).toHaveBeenCalledWith('external-import');
  });

  it('shows no import page result when false or omitted', () => {
    search(false);
    expect(screen.queryByRole('button', { name: /从其他 AI 应用导入/ })).toBeNull();
    cleanup();
    search(undefined);
    expect(screen.queryByRole('button', { name: /从其他 AI 应用导入/ })).toBeNull();
  });
});
