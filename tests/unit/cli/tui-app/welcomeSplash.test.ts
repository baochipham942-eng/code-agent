import { describe, expect, it } from 'vitest';
import {
  abbreviateHomePath,
  formatWorkspaceLine,
  NEO_LOGO_COMPACT,
  NEO_LOGO_FULL,
  WELCOME_ACTIONS,
  WELCOME_COMPACT_ROWS,
  WELCOME_HEADLINE,
  WELCOME_SUBHEAD,
  welcomeActionIndexAt,
} from '../../../../src/cli/tui-app/welcomeSplash';

describe('welcomeSplash', () => {
  it('full logo 每行同宽、高度够撑起海报（≥7 行）', () => {
    expect(NEO_LOGO_FULL.length).toBeGreaterThanOrEqual(7);
    const widths = new Set(NEO_LOGO_FULL.map((line) => line.length));
    expect(widths.size).toBe(1);
    expect(NEO_LOGO_FULL.some((line) => line.includes('◈'))).toBe(true);
  });

  it('compact logo 保持 3 行同宽且含 ◈', () => {
    expect(NEO_LOGO_COMPACT).toHaveLength(3);
    expect(new Set(NEO_LOGO_COMPACT.map((line) => line.length)).size).toBe(1);
    expect(NEO_LOGO_COMPACT[1]).toContain('◈');
  });

  it('海报有高亮句、副标题、且动作表带真实快捷键', () => {
    expect(WELCOME_HEADLINE.length).toBeGreaterThan(0);
    expect(WELCOME_SUBHEAD).toContain('/model');
    expect(WELCOME_ACTIONS.map((item) => item.shortcut)).toEqual([
      '/model',
      '/sessions',
      '/help',
      'ctrl+q',
    ]);
    expect(WELCOME_ACTIONS.map((item) => item.id)).toEqual(['model', 'sessions', 'help', 'quit']);
    expect(WELCOME_COMPACT_ROWS).toBeGreaterThan(16);
  });

  it('30x100 全屏钉底帧上，动作表 4 行可被鼠标命中', () => {
    expect(welcomeActionIndexAt(15, 30, 5, false)).toBe(0);
    expect(welcomeActionIndexAt(16, 30, 5, false)).toBe(1);
    expect(welcomeActionIndexAt(17, 30, 5, false)).toBe(2);
    expect(welcomeActionIndexAt(18, 30, 5, false)).toBe(3);
    expect(welcomeActionIndexAt(10, 30, 5, false)).toBeNull();
    expect(welcomeActionIndexAt(25, 30, 5, false)).toBeNull();
  });

  it('带列坐标时只命中动作文案列，logo / 空白不选中', () => {
    expect(welcomeActionIndexAt(15, 30, 5, false, 2, 100)).toBeNull();
    expect(welcomeActionIndexAt(15, 30, 5, false, 70, 100)).toBe(0);
  });

  it('最后一项下一行不是 Quit：鼠标离开动作表即未命中', () => {
    expect(welcomeActionIndexAt(18, 30, 5, false)).toBe(3);
    expect(welcomeActionIndexAt(19, 30, 5, false)).toBeNull();
    expect(welcomeActionIndexAt(18, 30, 8, false)).toBeNull();
  });

  it('abbreviateHomePath 把家目录换成 ~', () => {
    expect(abbreviateHomePath('/Users/linchen/Downloads/ai', '/Users/linchen')).toBe('~/Downloads/ai');
    expect(abbreviateHomePath('/Users/linchen', '/Users/linchen')).toBe('~');
    expect(abbreviateHomePath('/tmp/project', '/Users/linchen')).toBe('/tmp/project');
  });

  it('workspace 行是 Grok 顶左格式：branch  +  path', () => {
    expect(formatWorkspaceLine('/Users/linchen/Downloads/ai', 'main', false, '/Users/linchen'))
      .toBe('main  ~/Downloads/ai');
    expect(formatWorkspaceLine('/Users/linchen/Downloads/ai', 'main', true, '/Users/linchen'))
      .toBe('main*  ~/Downloads/ai');
    expect(formatWorkspaceLine('/tmp/project', '', false, '/Users/linchen')).toBe('/tmp/project');
  });
});
