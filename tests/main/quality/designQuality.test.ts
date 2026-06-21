import { describe, expect, it } from 'vitest';
import {
  detectFrontend,
  isFrontendPath,
  extensionOf,
  listDesignRules,
} from '../../../src/main/quality/detect';
import {
  runDesignQualityReview,
  formatDesignReview,
} from '../../../src/main/quality/designQualityHook';
import type { DesignFinding } from '../../../src/main/quality/types';

const ruleIds = (findings: DesignFinding[]): string[] => findings.map((f) => f.ruleId);

describe('detectFrontend — slop 痕迹', () => {
  it('命中 Tailwind 紫→蓝渐变', () => {
    const src = '<div class="bg-gradient-to-r from-purple-500 to-blue-500"></div>';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.html' }))).toContain(
      'slop-purple-blue-gradient',
    );
  });

  it('命中 CSS 紫→蓝渐变', () => {
    const src = '.hero { background: linear-gradient(135deg, #6d28d9, #2563eb); }';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.css' }))).toContain(
      'slop-purple-blue-gradient',
    );
  });

  it('命中弹跳缓动（cubic-bezier 越界）', () => {
    const src = '.a { transition: transform .3s cubic-bezier(0.68, -0.55, 0.27, 1.55); }';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.css' }))).toContain(
      'slop-bounce-elastic-easing',
    );
  });

  it('命中米色默认背景', () => {
    const src = 'body { background: #f5f0e1; }';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.css' }))).toContain(
      'slop-cream-default-bg',
    );
  });

  it('命中被滥用的字体', () => {
    const src = "body { font-family: 'Inter', sans-serif; }";
    expect(ruleIds(detectFrontend(src, { filePath: 'a.css' }))).toContain(
      'quality-overused-font',
    );
  });

  it('命中 Display 字号上限与魔法 z-index', () => {
    const src = '.t { font-size: 8rem; } .m { z-index: 9999; }';
    const ids = ruleIds(detectFrontend(src, { filePath: 'a.css' }));
    expect(ids).toContain('quality-hero-font-ceiling');
    expect(ids).toContain('quality-arbitrary-z-index');
  });

  it('命中标题层级跳级', () => {
    const src = '<section><h1>标题</h1><h3>子标题</h3></section>';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.html' }))).toContain(
      'quality-skipped-heading-level',
    );
  });

  it('命中缺少 reduced-motion 兜底', () => {
    const src = '@keyframes spin { to { transform: rotate(360deg); } } .s { animation: spin 1s linear infinite; }';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.css' }))).toContain(
      'quality-missing-reduced-motion',
    );
  });

  it('命中灰色图片占位框：占位图床 URL', () => {
    const src = '<img src="https://via.placeholder.com/400x300" alt="x">';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.html' }))).toContain(
      'slop-gray-image-placeholder',
    );
  });

  it('命中灰色图片占位框：dummyimage 图床', () => {
    const src = '<img src="https://dummyimage.com/600x400/ccc/000">';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.html' }))).toContain(
      'slop-gray-image-placeholder',
    );
  });

  it('命中灰色图片占位框：灰底 + 图片纵横比的空框（Tailwind）', () => {
    const src = '<div class="aspect-video bg-gray-200 rounded-lg"></div>';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.html' }))).toContain(
      'slop-gray-image-placeholder',
    );
  });

  it('命中灰色图片占位框：CSS 灰底 + aspect-ratio', () => {
    const src = '.ph { background: #cccccc; aspect-ratio: 16 / 9; }';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.css' }))).toContain(
      'slop-gray-image-placeholder',
    );
  });
});

describe('detectFrontend — 不误报', () => {
  it('干净页面零发现', () => {
    const src = [
      '<!doctype html><html><head><style>',
      "body { background: #ffffff; color: #111111; font-family: 'Georgia', serif; max-width: 60ch; }",
      'h1 { font-size: 3rem; }',
      '</style></head><body><h1>Hello</h1><p>World</p></body></html>',
    ].join('\n');
    expect(detectFrontend(src, { filePath: 'clean.html' })).toEqual([]);
  });

  it('声明了 prefers-reduced-motion 后不报动画缺兜底', () => {
    const src = [
      '.s { animation: spin 1s linear infinite; }',
      '@media (prefers-reduced-motion: reduce) { .s { animation: none; } }',
    ].join('\n');
    expect(ruleIds(detectFrontend(src, { filePath: 'a.css' }))).not.toContain(
      'quality-missing-reduced-motion',
    );
  });

  it('非前端文件不扫描', () => {
    const src = '.hero { background: linear-gradient(135deg, #6d28d9, #2563eb); }';
    expect(detectFrontend(src, { filePath: 'notes.txt' })).toEqual([]);
  });

  it('picsum 真图不误报为灰框', () => {
    const src = '<img class="aspect-video" src="https://picsum.photos/seed/team/800/450" alt="团队">';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.html' }))).not.toContain(
      'slop-gray-image-placeholder',
    );
  });

  it('普通灰色面板（无图片纵横比）不误报为灰框', () => {
    const src = '<div class="bg-gray-200 p-4 rounded">侧边栏</div>';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.html' }))).not.toContain(
      'slop-gray-image-placeholder',
    );
  });
});

describe('detectFrontend — 严格度门控', () => {
  it('relaxed 只报 relaxed 规则', () => {
    const src = [
      '.a { transition: all .3s cubic-bezier(.68,-.55,.27,1.55); }',
      '.b { background: #f5f0e1; }',
    ].join('\n');
    const ids = ruleIds(detectFrontend(src, { filePath: 'a.css', strictness: 'relaxed' }));
    expect(ids).toContain('slop-bounce-elastic-easing'); // relaxed
    expect(ids).not.toContain('slop-cream-default-bg'); // standard
    expect(ids).not.toContain('quality-missing-reduced-motion'); // standard
  });

  it('strict 规则在 standard 下不触发、strict 下触发', () => {
    const src = '<div class="bg-blue-500 text-gray-400">x</div>';
    expect(ruleIds(detectFrontend(src, { filePath: 'a.html', strictness: 'standard' }))).not.toContain(
      'slop-gray-text-on-color',
    );
    expect(ruleIds(detectFrontend(src, { filePath: 'a.html', strictness: 'strict' }))).toContain(
      'slop-gray-text-on-color',
    );
  });
});

describe('detectFrontend — 截断与工具函数', () => {
  it('maxFindings 截断', () => {
    const src = Array.from({ length: 20 }, () => '.x { z-index: 9999; }').join('\n');
    expect(detectFrontend(src, { filePath: 'a.css', maxFindings: 5 }).length).toBe(5);
  });

  it('isFrontendPath / extensionOf', () => {
    expect(isFrontendPath('a.tsx')).toBe(true);
    expect(isFrontendPath('a.html')).toBe(true);
    expect(isFrontendPath('a.txt')).toBe(false);
    expect(isFrontendPath(undefined)).toBe(false);
    expect(extensionOf('foo/bar.HTML')).toBe('html');
    expect(extensionOf('noext')).toBe('');
  });

  it('listDesignRules 暴露全部规则元数据', () => {
    const rules = listDesignRules();
    expect(rules.length).toBe(16);
    expect(rules.every((r) => r.id && r.title && r.minStrictness)).toBe(true);
  });
});

describe('runDesignQualityReview — hook 闸门', () => {
  const slopHtml = '<div class="bg-gradient-to-r from-purple-500 to-blue-500"></div>';

  it('Write 前端文件含痕迹 → 返回 review 文本', () => {
    const review = runDesignQualityReview({ toolName: 'Write', filePath: 'a.html', source: slopHtml });
    expect(review).toBeTruthy();
    expect(review).toContain('紫→蓝');
  });

  it('禁用时返回 null', () => {
    expect(
      runDesignQualityReview({ toolName: 'Write', filePath: 'a.html', source: slopHtml, enabled: false }),
    ).toBeNull();
  });

  it('非写类工具返回 null', () => {
    expect(runDesignQualityReview({ toolName: 'Read', filePath: 'a.html', source: slopHtml })).toBeNull();
  });

  it('非前端文件返回 null', () => {
    expect(runDesignQualityReview({ toolName: 'Write', filePath: 'a.txt', source: slopHtml })).toBeNull();
  });

  it('空源码返回 null', () => {
    expect(runDesignQualityReview({ toolName: 'Write', filePath: 'a.html', source: '' })).toBeNull();
  });

  it('干净前端文件返回 null', () => {
    const clean = '<!doctype html><html><body><h1>Hi</h1></body></html>';
    expect(runDesignQualityReview({ toolName: 'Write', filePath: 'a.html', source: clean })).toBeNull();
  });
});

describe('formatDesignReview', () => {
  it('空发现返回 null', () => {
    expect(formatDesignReview([])).toBeNull();
  });

  it('含发现时带行号与文案', () => {
    const finding: DesignFinding = {
      ruleId: 'slop-purple-blue-gradient',
      category: 'slop',
      severity: 'warning',
      message: '紫→蓝渐变是 AI 痕迹',
      line: 3,
      snippet: '<div class="...">',
    };
    const out = formatDesignReview([finding], 'a.html');
    expect(out).toContain('L3');
    expect(out).toContain('紫→蓝渐变是 AI 痕迹');
    expect(out).toContain('a.html');
  });
});
