import { describe, expect, it } from 'vitest';
import {
  applyEditMarker,
  extractGenerativeUiFenceBody,
  generativeUiOrdinalAtOffset,
  hasEditMarker,
  hashGenerativeUiBody,
  replaceGenerativeUiFence,
  stripEditMarker,
} from '../../../src/shared/generativeUIEdit';

const MSG = [
  '这是第一段说明。',
  '',
  '```generative_ui',
  '<h1>第一个产物</h1>',
  '```',
  '',
  '中间还有别的话。',
  '',
  '```generative_ui',
  '<h1>第二个产物</h1>',
  '```',
  '',
  '结尾。',
].join('\n');

describe('fence 定位与替换', () => {
  it('按 ordinal 取到对应 fence 的正文', () => {
    expect(extractGenerativeUiFenceBody(MSG, 0)?.trim()).toBe('<h1>第一个产物</h1>');
    expect(extractGenerativeUiFenceBody(MSG, 1)?.trim()).toBe('<h1>第二个产物</h1>');
    expect(extractGenerativeUiFenceBody(MSG, 2)).toBeNull();
  });

  it('只换第 N 个 fence，其余字节一字不动', () => {
    const result = replaceGenerativeUiFence(MSG, 1, '<h1>改过的第二个</h1>');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('<h1>第一个产物</h1>'); // 第 0 个没动
    expect(result.content).toContain('<h1>改过的第二个</h1>');
    expect(result.content).not.toContain('<h1>第二个产物</h1>');
    expect(result.content).toContain('这是第一段说明。');
    expect(result.content).toContain('结尾。');
    // fence 开合语法保住
    expect((result.content.match(/```generative_ui/g) ?? []).length).toBe(2);
  });

  it('ordinal 越界 fail-closed，不乱改', () => {
    const result = replaceGenerativeUiFence(MSG, 5, 'x');
    expect(result).toEqual({ ok: false, reason: 'ordinal_out_of_range' });
  });

  it('换进去的正文能被原样取回（round-trip 一致）', () => {
    const body = '<div>\n  <p>多行\n内容</p>\n</div>';
    const replaced = replaceGenerativeUiFence(MSG, 0, body);
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    // fence 正文以换行结尾（收尾 ``` 前那个 \n），trim 后应当一致
    expect(extractGenerativeUiFenceBody(replaced.content, 0)?.trim()).toBe(body.trim());
  });
});

describe('对账哈希', () => {
  it('同内容同哈希，trim 差异不影响', () => {
    expect(hashGenerativeUiBody('<h1>x</h1>')).toBe(hashGenerativeUiBody('  <h1>x</h1>\n'));
  });
  it('内容变了哈希必变', () => {
    expect(hashGenerativeUiBody('<h1>a</h1>')).not.toBe(hashGenerativeUiBody('<h1>b</h1>'));
  });
});

describe('编辑标记', () => {
  it('贴上后能被检出，且在正文末尾不顶到 doctype', () => {
    const marked = applyEditMarker('<!DOCTYPE html><html><body>x</body></html>', '2026-07-24', ['text', 'color']);
    expect(hasEditMarker(marked)).toBe(true);
    expect(marked).toMatch(/<!-- neo:user-edited 2026-07-24 fields=text,color -->$/);
    // 原文开头没被动，doctype 还在最前
    expect(marked.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('重复贴不堆叠——先清旧的再贴新的', () => {
    const once = applyEditMarker('<p>x</p>', '2026-07-24', ['text']);
    const twice = applyEditMarker(once, '2026-07-25', ['color']);
    expect((twice.match(/neo:user-edited/g) ?? []).length).toBe(1);
    expect(twice).toContain('2026-07-25');
    expect(twice).not.toContain('2026-07-24');
  });

  it('stripEditMarker 清掉任意位置的标记（round-trip 可能挪走它）', () => {
    const body = '<!-- neo:user-edited 2026-07-24 fields=text -->\n<p>x</p>';
    expect(stripEditMarker(body).trim()).toBe('<p>x</p>');
  });

  it('无 fields 时省略 fields 段', () => {
    expect(applyEditMarker('<p>x</p>', '2026-07-24', [])).toMatch(/<!-- neo:user-edited 2026-07-24 -->$/);
  });
});

describe('偏移 → ordinal', () => {
  it('落在第二个 fence 里的偏移算成 ordinal 1', () => {
    const secondFenceOffset = MSG.indexOf('<h1>第二个产物</h1>');
    expect(generativeUiOrdinalAtOffset(MSG, secondFenceOffset)).toBe(1);
  });
  it('第一个 fence 内偏移是 ordinal 0，无偏移兜底 0', () => {
    expect(generativeUiOrdinalAtOffset(MSG, MSG.indexOf('<h1>第一个产物</h1>'))).toBe(0);
    expect(generativeUiOrdinalAtOffset(MSG, undefined)).toBe(0);
  });
});
