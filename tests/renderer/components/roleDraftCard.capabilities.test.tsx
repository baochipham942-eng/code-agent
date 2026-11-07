// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en, zh } from '../../../src/renderer/i18n';

const i18nState = vi.hoisted(() => ({ language: 'zh' as 'zh' | 'en' }));

vi.mock('../../../src/renderer/hooks/useI18n', () => ({
  useI18n: () => ({
    language: i18nState.language,
    t: i18nState.language === 'zh' ? zh : en,
  }),
}));

import { RoleDraftCard } from '../../../src/renderer/components/features/chat/ChatInput/RoleDraftCard';

const RAW_TOOL_NAMES = [
  'tmeetCalendarList',
  'MemoryRead',
  'MemoryWrite',
  'Read',
  'Write',
  'WebFetch',
];

function renderCard(): void {
  render(
    <RoleDraftCard
      drafts={[{
        id: 'draft-1',
        roleId: 'notes-helper',
        description: 'Checks the calendar and reads or writes notes',
        tools: RAW_TOOL_NAMES,
      }]}
      onResolved={() => {}}
      onDismiss={() => {}}
    />,
  );
}

describe('RoleDraftCard capability copy', () => {
  afterEach(() => {
    cleanup();
    i18nState.language = 'zh';
  });

  it.each([
    ['zh', '能力：记住和回想、读取和查找文件、写入和编辑文件、打开网页、其他 1 项能力', '记住和回想、读取和查找文件、写入和编辑文件、打开网页、其他 1 项能力'],
    ['en', 'Capabilities: Remember and recall, Read and find files, Write and edit files, Open web pages, 1 other ability', 'Remember and recall, Read and find files, Write and edit files, Open web pages, 1 other ability'],
  ] as const)('visible text and tooltip use plain phrases in %s', (language, visibleText, tooltip) => {
    i18nState.language = language;
    renderCard();

    const line = screen.getByText(visibleText);
    expect(line.getAttribute('title')).toBe(tooltip);
    const visiblePhrases = line.textContent?.replace(/^(能力：|Capabilities: )/, '').split(/、|, /) ?? [];
    const tooltipPhrases = line.getAttribute('title')?.split(/、|, /) ?? [];
    for (const rawName of RAW_TOOL_NAMES) {
      expect(visiblePhrases).not.toContain(rawName);
      expect(tooltipPhrases).not.toContain(rawName);
    }
  });

  it('keeps the existing fallback when no tools are listed', () => {
    render(
      <RoleDraftCard
        drafts={[{
          id: 'draft-empty',
          roleId: 'helper',
          description: 'No explicit tools',
          tools: [],
        }]}
        onResolved={() => {}}
        onDismiss={() => {}}
      />,
    );

    const line = screen.getByText('能力：默认全集');
    expect(line.getAttribute('title')).toBe('默认全集');
  });
});
