import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NeoBrandMark } from '../../../packages/mobile/src/features/brand/NeoBrandMark';
import { CompanionConversation } from '../../../packages/mobile/src/features/sessions/CompanionConversation';
import { messages } from '../../../packages/mobile/src/i18n';

const N_PATH = 'M15 33.5 V14.5 L33 33.5 V14.5';
const SPARK_PATH = 'M37 6.5 L38.1 10 L41.6 11.1 L38.1 12.2 L37 15.7 L35.9 12.2 L32.4 11.1 L35.9 10 Z';
const text = messages('zh');

describe('NeoBrandMark 对齐 design.html 线稿 / 砖块两套', () => {
  it('mark 是 currentColor 描边 N+spark，没有底板也没有轨道环', () => {
    const html = renderToStaticMarkup(createElement(NeoBrandMark, { variant: 'mark', size: 47 }));
    expect(html).toContain('data-variant="mark"');
    expect(html).toContain('class="brand-mark neo-mark"');
    expect(html).toContain('width="47"');
    expect(html).toContain(`d="${N_PATH}"`);
    expect(html).toContain(`d="${SPARK_PATH}"`);
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain('<rect');
    expect(html).not.toContain('<circle');
    expect(html).not.toContain('linearGradient');
  });

  it('默认 app 变体仍是深空砖+轨道环，给关于页当图标用', () => {
    const html = renderToStaticMarkup(createElement(NeoBrandMark, { size: 56 }));
    expect(html).toContain('data-variant="app"');
    expect(html).toContain('width="56"');
    expect(html).toContain('<rect');
    expect(html).toContain('<circle');
    expect(html).toContain('linearGradient');
    expect(html).not.toContain('data-variant="mark"');
  });
});

describe('会话页接线：欢迎区线稿、助手行 24px teal、关于页砖块', () => {
  it('欢迎区一步用 47px 线稿', () => {
    const root = readFileSync('packages/mobile/src/app/MobileRoot.tsx', 'utf8');
    expect(root).toMatch(/className="welcome"[^>]*>\s*<NeoBrandMark variant="mark" size=\{47\} \/>/);
  });

  it('关于页不改成线稿', () => {
    const settings = readFileSync('packages/mobile/src/features/settings/SettingsPage.tsx', 'utf8');
    expect(settings).toMatch(/<NeoBrandMark size=\{56\} \/>/);
    expect(settings).not.toMatch(/variant="mark"/);
  });

  it('助手消息带 24px 线稿标签，用户气泡没有', () => {
    const html = renderToStaticMarkup(createElement(CompanionConversation, {
      history: {
        sessionId: 's1',
        messages: [
          { id: 'u1', role: 'user', content: '你好', timestamp: 1 },
          { id: 'a1', role: 'assistant', content: '在', timestamp: 2 },
        ],
        nextOffset: null,
      },
      loadMore() {},
      events: [],
      artifacts: [],
      sessionId: 's1',
      text,
      disabled: false,
      respond: async () => {},
      respondQuestion: async () => {},
      respondPlan: async () => {},
      openArtifact() {},
    }));
    expect(html).toContain('class="assistant-label"');
    expect(html).toContain('data-variant="mark"');
    expect(html).toContain('width="24"');
    expect(html).toContain(`>${text.neo}<`);
    expect(html).toContain('class="lan-message from-user"');
    const userBlock = html.slice(html.indexOf('from-user'), html.indexOf('assistant-label'));
    expect(userBlock).not.toContain('neo-mark');
  });
});

describe('线稿颜色跟设计稿 teal', () => {
  const css = readFileSync('packages/mobile/src/styles.css', 'utf8');
  it('welcome 和 assistant-label 的 neo-mark 走 accent', () => {
    expect(css).toMatch(/\.welcome\s+\.neo-mark\s*\{[^}]*color:\s*var\(--accent\)/);
    expect(css).toMatch(/\.assistant-label\s+\.neo-mark\s*\{[^}]*color:\s*var\(--accent\)/);
    expect(css).toMatch(/\.assistant-label\s*\{[^}]*display:\s*flex/);
  });
});
