// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeicPreviewView, LegacyOfficePreviewView, TextPreviewView } from '../../../src/renderer/components/previewFormatViews';

vi.mock('../../../src/renderer/components/features/chat/MessageBubble/ShikiCodeBlock', () => ({
  default: ({ code, language }: { code: string; language: string }) => (
    <pre data-testid="shiki-preview" data-language={language}>{code}</pre>
  ),
}));

afterEach(() => {
  cleanup();
});

describe('preview format views', () => {
  it('shows sniffed text in a read-only block and a truncation notice', () => {
    const content = JSON.stringify({ kind: 'text-preview', text: 'print(1)\n', truncated: true });
    render(<TextPreviewView content={content} shikiLanguage="python" onOpenDefault={() => undefined} />);
    expect(screen.getByTestId('text-preview')).not.toBeNull();
    expect(screen.getByTestId('shiki-preview').getAttribute('data-language')).toBe('python');
    expect(screen.getByTestId('shiki-preview').textContent).toBe('print(1)\n');
    expect(screen.getByTestId('text-preview-truncated').textContent).toContain('512');
  });

  it('renders raw virtual text that is not the text-preview envelope', () => {
    render(<TextPreviewView content="plain note" shikiLanguage={null} onOpenDefault={() => undefined} />);
    expect(screen.getByTestId('shiki-preview').textContent).toBe('plain note');
    expect(screen.getByTestId('shiki-preview').getAttribute('data-language')).toBe('');
  });

  it('uses one card and a working default-app button for a binary sniff', () => {
    const onOpenDefault = vi.fn();
    const content = JSON.stringify({
      kind: 'text-preview', text: '', truncated: false, fallback: { code: 'binary' },
    });
    render(<TextPreviewView content={content} shikiLanguage={null} onOpenDefault={onOpenDefault} />);
    expect(screen.getByTestId('preview-fallback-sentence').textContent?.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('preview-fallback-open'));
    expect(onOpenDefault).toHaveBeenCalledOnce();
    expect(screen.getByTestId('preview-fallback-open').tagName).toBe('BUTTON');
  });

  it('shows the LibreOffice-missing card for doc and key payloads', () => {
    const doc = JSON.stringify({ filePath: '/tmp/legacy.doc', state: 'libreoffice-missing' });
    const { unmount } = render(<LegacyOfficePreviewView content={doc} onOpenDefault={() => undefined} />);
    expect(screen.getByTestId('preview-fallback-sentence').textContent).toContain('LibreOffice');
    unmount();
    const key = JSON.stringify({ filePath: '/tmp/deck.key', state: 'libreoffice-missing' });
    render(<LegacyOfficePreviewView content={key} onOpenDefault={() => undefined} />);
    expect(screen.getByTestId('preview-fallback-open').textContent).toContain('默认程序');
  });

  it('renders a converted HEIC jpeg', () => {
    const content = JSON.stringify({ filePath: '/tmp/pic.heic', state: 'ready', imagePath: '/tmp/pic.jpg' });
    render(<HeicPreviewView content={content} onOpenDefault={() => undefined} />);
    expect(screen.getByTestId('heic-preview').getAttribute('src')).toContain('pic.jpg');
  });
});
