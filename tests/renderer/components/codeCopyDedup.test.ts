// ============================================================================
// 代码块紧邻 !copy 去重（工单 N-CODEBLOCK-DUPCOPY）——纯函数单测。
// 「紧邻」判据拍板：段与围栏块之间只隔空白（空行算紧邻）；夹任何其它内容不算；
// 围栏块前后对称处理；只有整段皆为 !copy 链接才去重，句中/混排的行内用法保留。
// ============================================================================
import { describe, expect, it } from 'vitest';
import { dropCodeAdjacentCopyLinks } from '../../../src/renderer/components/features/chat/MessageBubble/codeCopyDedup';

describe('dropCodeAdjacentCopyLinks — 紧邻 ⇒ 去重', () => {
  it('围栏块之后直接相邻的纯 !copy 段被删除', () => {
    expect(dropCodeAdjacentCopyLinks('```bash\nnpm install\n```\n[复制命令](!copy)'))
      .toBe('```bash\nnpm install\n```');
  });

  it('隔一个/多个空行仍算紧邻（空行渲染后不产生可见元素）', () => {
    expect(dropCodeAdjacentCopyLinks('```bash\nnpm i\n```\n\n[复制命令](!copy)'))
      .toBe('```bash\nnpm i\n```');
    const out = dropCodeAdjacentCopyLinks('```bash\nnpm i\n```\n\n\n[复制命令](!copy)\n\n\n');
    expect(out).not.toContain('!copy');
    expect(out.startsWith('```bash\nnpm i\n```')).toBe(true);
  });

  it('围栏块之前的纯 !copy 段同样删除（双按钮问题同形，对称处理）', () => {
    expect(dropCodeAdjacentCopyLinks('[复制命令](!copy)\n```bash\nnpm i\n```'))
      .toBe('```bash\nnpm i\n```');
  });

  it('两个围栏块之间的独立 !copy 段删除，两个块原样保留', () => {
    const out = dropCodeAdjacentCopyLinks('```bash\nls\n```\n\n[复制命令](!copy)\n\n```ts\nconst a = 1;\n```');
    expect(out).not.toContain('!copy');
    expect(out).toContain('```bash\nls\n```');
    expect(out).toContain('```ts\nconst a = 1;\n```');
  });

  it('无语言围栏块、同段多个 !copy 链接同样去重', () => {
    expect(dropCodeAdjacentCopyLinks('```\nls\n-la\n```\n[a](!copy) [b](!copy)')).toBe('```\nls\n-la\n```');
  });

  it('带语言单行围栏去重；波浪线围栏同样参与去重', () => {
    expect(dropCodeAdjacentCopyLinks('```bash\nls\n```\n[c](!copy)')).toBe('```bash\nls\n```');
    expect(dropCodeAdjacentCopyLinks('~~~bash\nnpm i\n~~~\n[复制命令](!copy)')).toBe('~~~bash\nnpm i\n~~~');
  });
});

describe('dropCodeAdjacentCopyLinks — 不紧邻 ⇒ 保留', () => {
  it('正文中间、无围栏块的独立 !copy 段原样保留', () => {
    const text = '前置说明\n\n[sk-abc123](!copy)\n\n后置说明';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('围栏块与 !copy 段之间夹了说明文字段 ⇒ 不算紧邻，保留', () => {
    const text = '```bash\nls\n```\n\n先看这行说明\n\n[复制命令](!copy)';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('同段（无空行）与文字混排的 !copy 是句中行内用法，保留', () => {
    const text = '```bash\nls\n```\n直接 [复制命令](!copy) 即可';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('段里混有非 !copy 链接（!open 等）时不整段删除', () => {
    const text = '```\nls\n```\n[复制](!copy) 和 [打开](!open)';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('紧邻行内 code 不构成紧邻围栏块，保留', () => {
    const text = '```\nls\n```\n`foo`\n[复制命令](!copy)';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('列表项里的 !copy 不是纯复制段，保留', () => {
    const text = '```\nls\n```\n- [复制命令](!copy)';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });
});

describe('dropCodeAdjacentCopyLinks — 代码内容零改动', () => {
  it('围栏块内部的 [x](!copy) 是代码文本，原样保留', () => {
    const text = '```markdown\n[x](!copy)\n```\n\n正文';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('行内 code 里的 [x](!copy) 原样保留', () => {
    const text = '运行 `[x](!copy)` 命令';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('流式未闭合围栏块：块内吞掉的 !copy 文本不动', () => {
    const text = '```bash\nnpm i\n';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('无 !copy 的文本恒等返回', () => {
    const text = '```bash\nls\n```\n\n普通正文段落';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });
});

// ============================================================================
// ai-review PR#1677 三条 Important 的回归钉板：
// 围栏边界识别（四反引号嵌套示例）、渲染分发对齐（无语言单行围栏走 InlineCode）、
// 删空段的换行保留（两围栏不拼接）
// ============================================================================
describe('dropCodeAdjacentCopyLinks — 围栏边界与渲染分发（ai-review 修正）', () => {
  it('四反引号围栏内的三反引号示例与 !copy 字面量是代码内容，整条恒等', () => {
    const text = '````\n```\n[x](!copy)\n```\n````\n\n正文说明';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('无语言单行围栏渲染为行内 code（无块头按钮），相邻 !copy 保留', () => {
    const text = '```\nls\n```\n[复制命令](!copy)';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('两块之间无空行的复制段删除后保留换行，两个围栏不拼接', () => {
    expect(dropCodeAdjacentCopyLinks('```bash\nls\n```\n[复制](!copy)\n```ts\nconst a = 1;\n```'))
      .toBe('```bash\nls\n```\n```ts\nconst a = 1;\n```');
  });

  it('行内 code 里的 !copy 字面量不构成纯复制段', () => {
    const text = '```bash\nls\n-la\n```\n`[x](!copy)`';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('4 空格缩进的 [literal](!copy) 是缩进代码块内容，不是复制段，保留', () => {
    const text = '```bash\nls\n```\n\n    [literal](!copy)';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('neo_ui / spreadsheet / document 围栏无确定块头复制按钮，相邻 !copy 保留', () => {
    expect(dropCodeAdjacentCopyLinks('```neo_ui\n{"a":1}\n```\n[abc](!copy)'))
      .toBe('```neo_ui\n{"a":1}\n```\n[abc](!copy)');
    expect(dropCodeAdjacentCopyLinks('```document\n{"a":1}\n```\n[abc](!copy)'))
      .toBe('```document\n{"a":1}\n```\n[abc](!copy)');
  });

  it('chart 围栏按同源 spec 判定：合法 spec 去重、解析失败（渲染 null）保留', () => {
    expect(dropCodeAdjacentCopyLinks('```chart\n{"type":"bar","data":[{"name":"a","value":1}]}\n```\n[c](!copy)'))
      .toBe('```chart\n{"type":"bar","data":[{"name":"a","value":1}]}\n```');
    expect(dropCodeAdjacentCopyLinks('```chart\nnot-json\n```\n[c](!copy)'))
      .toBe('```chart\nnot-json\n```\n[c](!copy)');
  });

  it('generative_ui 空内容渲染 null，相邻 !copy 保留；非空去重', () => {
    expect(dropCodeAdjacentCopyLinks('```generative_ui\n\n```\n[x](!copy)'))
      .toBe('```generative_ui\n\n```\n[x](!copy)');
    expect(dropCodeAdjacentCopyLinks('```generative_ui\n<button>hi</button>\n```\n[x](!copy)'))
      .toBe('```generative_ui\n<button>hi</button>\n```');
  });

  it('引用（> 前缀）内的围栏与纯复制段同样参与去重', () => {
    expect(dropCodeAdjacentCopyLinks('> ```bash\n> ls\n> ```\n>\n> [复制命令](!copy)'))
      .toBe('> ```bash\n> ls\n> ```');
    // 引用外的独立 !copy（无围栏背景）仍保留
    expect(dropCodeAdjacentCopyLinks('> 引用一句话\n\n[复制命令](!copy)'))
      .toBe('> 引用一句话\n\n[复制命令](!copy)');
  });

  it('顶层围栏内的字面「> ```」行是代码内容不是关栏，[x](!copy) 原样保留', () => {
    const text = '```markdown\n> ```\n[x](!copy)\n```';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('引用内围栏的内容判定剥同容器前缀：空 generative_ui 保留链接、合法 chart 参与去重', () => {
    expect(dropCodeAdjacentCopyLinks('> ```generative_ui\n>\n> ```\n>\n> [复制内容](!copy)'))
      .toBe('> ```generative_ui\n>\n> ```\n>\n> [复制内容](!copy)');
    expect(dropCodeAdjacentCopyLinks('> ```chart\n> {"type":"bar","data":[{"name":"a","value":1}]}\n> ```\n>\n> [c](!copy)'))
      .toBe('> ```chart\n> {"type":"bar","data":[{"name":"a","value":1}]}\n> ```');
  });

  it('引用结束即围栏结束：无前缀行不并入引用内围栏，后续内容回顶层解析', () => {
    // "> ls" 后引用结束，```ts 是新的顶层围栏；中间 !copy 段两块相邻，去重但两块保留
    const out = dropCodeAdjacentCopyLinks('> ```bash\n> ls\n[复制](!copy)\n```ts\nconst a = 1;\n```');
    expect(out).not.toContain('!copy');
    expect(out).toContain('> ```bash\n> ls');
    expect(out).toContain('```ts\nconst a = 1;\n```');
  });

  it('删除跨引用边界的复制段后补空行终止引用，两个引用代码块不被并块', () => {
    expect(dropCodeAdjacentCopyLinks('> ```bash\n> ls\n[复制](!copy)\n> ```ts\n> const a = 1;\n> ```'))
      .toBe('> ```bash\n> ls\n\n> ```ts\n> const a = 1;\n> ```');
  });

  it('引用空行（>）也是段落边界：复制段后接后续说明仍去重，说明保留', () => {
    const out = dropCodeAdjacentCopyLinks('> ```bash\n> ls\n> ```\n>\n> [复制命令](!copy)\n>\n> 后续说明');
    expect(out).not.toContain('!copy');
    expect(out).toContain('> ```bash\n> ls\n> ```');
    expect(out).toContain('后续说明');
  });

  it('引用空行带尾随空格（"> "）同样是段落边界，去重不遗漏', () => {
    const out = dropCodeAdjacentCopyLinks('> ```bash\n> ls\n> ```\n> \n> [复制命令](!copy)\n> \n> 后续说明');
    expect(out).not.toContain('!copy');
    expect(out).toContain('后续说明');
  });

  it('列表项内围栏中的字面 [literal](!copy) 是代码内容，整条恒等（类级保守边界）', () => {
    const text = '- ````markdown\n  ```bash\n  ls\n  ```\n  [literal](!copy)\n  ````';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });

  it('顶层带缩进（1-3 空格）的 !copy 段一律保守保留，不参与去重', () => {
    const text = '```bash\nls\n```\n  [复制命令](!copy)';
    expect(dropCodeAdjacentCopyLinks(text)).toBe(text);
  });
});
