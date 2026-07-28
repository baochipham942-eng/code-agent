// 批 H · Context 注入（方案 §6.5）。
// 两侧各钉一半：renderer 侧「用户在看什么」取得对不对，host 侧拼出来的 Focus 段说的是不是人话。
//
// 这里刻意不去测「当前文件 / 选区 / diff」——Neo 不是 IDE，编辑器文本选区和 diff 视图
// 在这个产品里根本不存在。测不存在的东西只会让它以假实现的形式被补出来。

import { describe, expect, it } from 'vitest';
import { selectVoiceFocusContext } from '../../src/renderer/services/voiceFocusContext';
import { buildFocusBlock, composeVoiceInstructions, focusChanged } from '../../src/host/services/voice/voiceContextAssembler';

type FocusInput = Parameters<typeof selectVoiceFocusContext>[0];

function tab(overrides: Partial<FocusInput['previewTabs'][number]> = {}): FocusInput['previewTabs'][number] {
  return {
    id: 'tab-1',
    path: '/repo/src/a.ts',
    content: 'x',
    savedContent: 'x',
    mode: 'preview',
    lastActivatedAt: 1,
    isLoaded: true,
    ...overrides,
  };
}

function state(overrides: Partial<FocusInput> = {}): FocusInput {
  return {
    previewTabs: [],
    activePreviewTabId: null,
    activeWorkbenchTab: null,
    workbenchCollapsed: false,
    ...overrides,
  };
}

describe('焦点取值（renderer）', () => {
  it('右栏收起时什么都不报（用户其实没在看任何东西）', () => {
    expect(selectVoiceFocusContext(state({
      workbenchCollapsed: true,
      previewTabs: [tab()],
      activePreviewTabId: 'tab-1',
      activeWorkbenchTab: 'preview:/repo/src/a.ts',
    }))).toEqual({});
  });

  it('右栏停在这个文件上才算「当前文件」', () => {
    expect(selectVoiceFocusContext(state({
      previewTabs: [tab()],
      activePreviewTabId: 'tab-1',
      activeWorkbenchTab: 'preview:/repo/src/a.ts',
    }))).toEqual({ view: 'preview:/repo/src/a.ts', filePath: '/repo/src/a.ts' });
  });

  // tab 开着不等于在看：用户切到画布时嘴里的「这个」指的是画布
  it('tab 还开着但右栏在看画布时不报文件', () => {
    expect(selectVoiceFocusContext(state({
      previewTabs: [tab()],
      activePreviewTabId: 'tab-1',
      activeWorkbenchTab: 'design-canvas',
    }))).toEqual({ view: 'design-canvas' });
  });

  it('编辑态且内容与磁盘不一致才报未保存', () => {
    const dirty = selectVoiceFocusContext(state({
      previewTabs: [tab({ mode: 'edit', content: 'y' })],
      activePreviewTabId: 'tab-1',
      activeWorkbenchTab: 'preview:/repo/src/a.ts',
    }));
    expect(dirty.unsaved).toBe(true);

    const clean = selectVoiceFocusContext(state({
      previewTabs: [tab({ mode: 'edit' })],
      activePreviewTabId: 'tab-1',
      activeWorkbenchTab: 'preview:/repo/src/a.ts',
    }));
    expect(clean.unsaved).toBeUndefined();
  });

  it('实时预览报选中的元素，不报文件路径', () => {
    const focus = selectVoiceFocusContext(state({
      previewTabs: [tab({
        kind: 'liveDev',
        path: 'http://localhost:5173',
        selectedElement: {
          file: '/repo/src/App.tsx',
          relativeFile: 'src/App.tsx',
          line: 12,
          column: 3,
          tag: 'BUTTON',
          text: '  立即开始  ',
          rect: { x: 0, y: 0, width: 1, height: 1 },
          componentName: 'PrimaryButton',
        },
      })],
      activePreviewTabId: 'tab-1',
      activeWorkbenchTab: 'preview:http://localhost:5173',
    }));
    expect(focus.filePath).toBeUndefined();
    expect(focus.selectedElement).toContain('PrimaryButton');
    expect(focus.selectedElement).toContain('立即开始');
  });
});

describe('Focus 段组装（host）', () => {
  it('没有焦点就不往 instructions 里塞空段', () => {
    expect(buildFocusBlock(null)).toBe('');
    expect(buildFocusBlock({})).toBe('');
    expect(composeVoiceInstructions('你是牧之', {})).toBe('你是牧之');
  });

  it('有焦点时接在人设后面，且明说「这个/这里」指的是它', () => {
    const out = composeVoiceInstructions('你是牧之', { view: 'preview:/repo/a.ts', filePath: '/repo/a.ts', unsaved: true });
    expect(out.startsWith('你是牧之')).toBe(true);
    expect(out).toContain('/repo/a.ts');
    expect(out).toContain('未保存');
    expect(out).toContain('这个');
  });

  it('视图名翻成人话，不把内部 id 念给用户听', () => {
    expect(buildFocusBlock({ view: 'design-canvas' })).toContain('设计画布');
    expect(buildFocusBlock({ view: 'preview:/repo/a.ts' })).toContain('文件预览');
  });

  it('内容没变就不算变化（省掉一次没必要的 session.update）', () => {
    expect(focusChanged({ filePath: '/a' }, { filePath: '/a' })).toBe(false);
    expect(focusChanged({ filePath: '/a' }, { filePath: '/b' })).toBe(true);
    expect(focusChanged(null, {})).toBe(false);
  });
});
