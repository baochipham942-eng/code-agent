import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SkillStatusMessage, isSkillStatusContent } from '../../../src/renderer/components/features/chat/MessageBubble/SkillStatusMessage';

describe('SkillStatusMessage', () => {
  it('returns null when content has no command-message tag', () => {
    const html = renderToStaticMarkup(
      React.createElement(SkillStatusMessage, { content: 'plain text' }),
    );
    expect(html).toBe('');
  });

  it('renders compact gray footnote with skill name', () => {
    const content =
      '<command-message>Loading skill: lark-doc — 飞书云文档</command-message><command-name>lark-doc</command-name>';
    const html = renderToStaticMarkup(
      React.createElement(SkillStatusMessage, { content }),
    );
    expect(html).toContain('Using');
    expect(html).toContain('lark-doc');
    expect(html).toContain('skill');
    // 通过 title 暴露原始消息（含 skill 描述）
    expect(html).toContain('Loading skill: lark-doc');
    // 不再使用大紫色 Sparkles 徽章
    expect(html).not.toContain('text-accent-purple');
    expect(html).not.toContain('bg-gradient-to-r');
  });

  it('falls back to message text when skill name is absent', () => {
    const content = '<command-message>Loading skill: foo</command-message>';
    const html = renderToStaticMarkup(
      React.createElement(SkillStatusMessage, { content }),
    );
    expect(html).toContain('Loading skill: foo');
  });
});

describe('isSkillStatusContent', () => {
  it('detects valid skill content', () => {
    expect(
      isSkillStatusContent(
        '<command-message>x</command-message><command-name>y</command-name>',
      ),
    ).toBe(true);
  });

  it('rejects partial content', () => {
    expect(isSkillStatusContent('<command-message>x</command-message>')).toBe(false);
  });
});
