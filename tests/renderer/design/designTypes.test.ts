import { describe, expect, it } from 'vitest';
import {
  formatDesignContextLines,
  buildPrototypePrompt,
  buildImagePrompt,
  buildContinueEditPrompt,
  designDeviceWidth,
  versionFileName,
  parseVersionTs,
  prototypeExportName,
  DESIGN_TONE_OPTIONS,
} from '../../../src/renderer/components/design/designTypes';
import { DESIGN_DEVICE_PRESETS } from '../../../src/shared/constants/designWorkspace';

describe('formatDesignContextLines', () => {
  it('空上下文返回空数组', () => {
    expect(formatDesignContextLines(undefined)).toEqual([]);
    expect(formatDesignContextLines({})).toEqual([]);
  });

  it('含品牌色时给出锚点并禁 AI 默认渐变', () => {
    const out = formatDesignContextLines({ brandColor: '#0066ff' }).join('\n');
    expect(out).toContain('#0066ff');
    expect(out).toContain('紫→蓝');
  });

  it('含 surface 与语气', () => {
    const out = formatDesignContextLines({ surface: 'brand', tone: ['极简', '科技感'] }).join('\n');
    expect(out).toContain('Brand-led');
    expect(out).toContain('极简、科技感');
  });
});

describe('buildPrototypePrompt', () => {
  const base = { requirement: '一个登录页', reservedPath: '.neo-design/proto-1.html' };

  it('包含预留路径与增量写/单文件硬约束', () => {
    const p = buildPrototypePrompt(base);
    expect(p).toContain('.neo-design/proto-1.html');
    expect(p).toContain('骨架');
    expect(p).toContain('Edit');
    expect(p).toContain('</html>');
    expect(p).toContain('一个登录页');
  });

  it('注入设计上下文', () => {
    const p = buildPrototypePrompt({ ...base, designContext: { brandColor: '#0066ff' } });
    expect(p).toContain('#0066ff');
  });

  it('硬约束防 raw-HTML 残影：禁转义实体 + 元素成对写完', () => {
    const p = buildPrototypePrompt(base);
    expect(p).toContain('转义实体');
    expect(p).toContain('成对');
  });
});

describe('buildImagePrompt', () => {
  it('设计稿=干净图像描述含需求与类型，不含 agent 话术', () => {
    const p = buildImagePrompt({ requirement: '电商首页', outputType: 'mockup' });
    expect(p).toContain('电商首页');
    expect(p).toContain('UI 设计稿');
    expect(p).not.toContain('image_generate'); // 直连图像模型，非工具调用指令
  });

  it('信息图标签正确', () => {
    expect(buildImagePrompt({ requirement: 'x', outputType: 'infographic' })).toContain('信息图');
  });

  it('品牌色/语气进入图像描述', () => {
    const p = buildImagePrompt({
      requirement: '海报',
      outputType: 'mockup',
      designContext: { brandColor: '#0066ff', tone: ['极简', '科技感'] },
    });
    expect(p).toContain('#0066ff');
    expect(p).toContain('极简');
  });
});

describe('buildContinueEditPrompt', () => {
  const base = { reservedPath: '.neo-design/run-1/prototype.html', instruction: '把主按钮换成绿色' };

  it('要求局部改、用 Edit、不重写整页、保留收尾', () => {
    const p = buildContinueEditPrompt(base);
    expect(p).toContain('.neo-design/run-1/prototype.html');
    expect(p).toContain('Edit');
    expect(p).toContain('局部');
    expect(p).toContain('</html>');
    expect(p).toContain('把主按钮换成绿色');
  });

  it('带选中元素上下文时注入目标定位', () => {
    const p = buildContinueEditPrompt({
      ...base,
      selection: { tag: 'button', text: '立即购买', selector: '.hero > button.cta' },
    });
    expect(p).toContain('button');
    expect(p).toContain('立即购买');
    expect(p).toContain('.hero > button.cta');
  });

  it('无选中元素时不出现目标定位段', () => {
    expect(buildContinueEditPrompt(base)).not.toContain('目标元素');
  });
});

describe('version file naming', () => {
  it('编码后能解析回时间戳', () => {
    expect(versionFileName(1700000000000)).toBe('v-1700000000000.html');
    expect(parseVersionTs('v-1700000000000.html')).toBe(1700000000000);
  });

  it('非版本文件名返回 null', () => {
    expect(parseVersionTs('prototype.html')).toBeNull();
    expect(parseVersionTs('v-abc.html')).toBeNull();
  });
});

describe('prototypeExportName', () => {
  it('带时间戳的 html 文件名', () => {
    expect(prototypeExportName(1700000000000)).toBe('neo-prototype-1700000000000.html');
  });
});

describe('DESIGN_DEVICE_PRESETS', () => {
  it('按桌面/平板/手机顺序提供预设', () => {
    expect(DESIGN_DEVICE_PRESETS.map((d) => d.id)).toEqual(['desktop', 'tablet', 'mobile']);
  });

  it('平板/手机给出断点宽度，桌面自适应', () => {
    const byId = Object.fromEntries(DESIGN_DEVICE_PRESETS.map((d) => [d.id, d.width]));
    expect(byId.desktop).toBeNull();
    expect(byId.tablet).toBe(768);
    expect(byId.mobile).toBe(375);
  });
});

describe('designDeviceWidth', () => {
  it('桌面满宽，平板/手机按断点像素', () => {
    expect(designDeviceWidth('desktop')).toBe('100%');
    expect(designDeviceWidth('tablet')).toBe('768px');
    expect(designDeviceWidth('mobile')).toBe('375px');
  });
});

describe('DESIGN_TONE_OPTIONS', () => {
  it('提供语气候选', () => {
    expect(DESIGN_TONE_OPTIONS).toContain('极简');
    expect(DESIGN_TONE_OPTIONS.length).toBeGreaterThan(4);
  });
});
