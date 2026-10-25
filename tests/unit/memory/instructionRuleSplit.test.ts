// ============================================================================
// instructionRuleSplit 单测（N-EXTHISTORY-IMPORT-K1A-FU1 验收①）
// ============================================================================
//
// 拆条器的硬约束：
//   - 确定性：同输入两次调用输出完全一致（confirm 路径按内容 hash 找回条目）；
//   - 每条 ≤ SEED_INJECTION.PER_ITEM_CHARS（120，与新会话注入的单条上限同源）；
//   - frontmatter / 代码块 / 标题不产规则；列表项与单句各自成条；
//   - 超长条目按句读再拆、末路截断加省略号；空行与重复条目丢弃。

import { describe, expect, it } from 'vitest';
import { SEED_INJECTION } from '../../../src/shared/constants';
import { splitInstructionRules } from '../../../src/host/memory/importers/instructionRuleSplit';

const LIMIT = SEED_INJECTION.PER_ITEM_CHARS;

describe('splitInstructionRules', () => {
  it('无序列表与有序列表项各自成条，剥掉列表标记', () => {
    const rules = splitInstructionRules(`# 家规

- 回复一律用中文
* 代码必须带测试
+ 不要自动推送
1. 先跑门再提交
23) 超过 20 也没问题
`);
    expect(rules).toEqual([
      '回复一律用中文',
      '代码必须带测试',
      '不要自动推送',
      '先跑门再提交',
      '超过 20 也没问题',
    ]);
  });

  it('段落按单句成条：一句话一条，多句段拆成多条', () => {
    const rules = splitInstructionRules(`总是先看日志再下结论。结论要给出行号。`);
    expect(rules).toEqual(['总是先看日志再下结论。', '结论要给出行号。']);
  });

  it('软换行的段落并成一段后再按句拆', () => {
    const rules = splitInstructionRules(`第一句跨了两行
仍然是一句。第二句很短。`);
    expect(rules).toEqual(['第一句跨了两行 仍然是一句。', '第二句很短。']);
  });

  it('标题行只是上下文：不成条也不并入相邻段落', () => {
    const rules = splitInstructionRules(`# 总则

## 禁止事项

不要删除用户数据。

### 附注
`);
    expect(rules).toEqual(['不要删除用户数据。']);
  });

  it('YAML frontmatter 整段剔除，不产规则', () => {
    const rules = splitInstructionRules(`---
name: rules
description: frontmatter 里的句子不该变成规则。
---

正文规则一条。
`);
    expect(rules).toEqual(['正文规则一条。']);
  });

  it('围栏代码块整段剔除（含未闭合栅栏剔到文件尾）', () => {
    const rules = splitInstructionRules(`规则前一句。

\`\`\`bash
rm -rf /
echo "代码块里的句子不该成为规则。"
\`\`\`

规则后一句。

~~~python
print("tilde fence too")
`);
    expect(rules).toEqual(['规则前一句。', '规则后一句。']);
  });

  it('CJK 长句：按分句标点再拆，每条仍不超上限', () => {
    const longSentence = Array.from({ length: 20 }, (_, i) => `第${i}个分句保持二十个字符左右的长度`).join('，') + '。';
    expect(longSentence.length).toBeGreaterThan(300);
    const rules = splitInstructionRules(longSentence);
    expect(rules.length).toBeGreaterThan(1);
    for (const rule of rules) {
      expect(rule.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it('300 字符的无标点英文长句：末路截断加省略号，且不超上限', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    expect(words.length).toBeGreaterThanOrEqual(300);
    const rules = splitInstructionRules(words);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.length).toBeLessThanOrEqual(LIMIT);
    expect(rules[0]?.endsWith('...')).toBe(true);
  });

  it('英文句点只在后随空白处断句（不切 3.14 与 URL）', () => {
    const rules = splitInstructionRules('Use node 24.1.5 and visit https://example.com/a.b often. Reply briefly.');
    expect(rules).toEqual([
      'Use node 24.1.5 and visit https://example.com/a.b often.',
      'Reply briefly.',
    ]);
  });

  it('重复行只保留一条，空行不产规则', () => {
    const rules = splitInstructionRules(`回复一律用中文

回复一律用中文


`);
    expect(rules).toEqual(['回复一律用中文']);
  });

  it('空文件 / 纯标题 / 纯代码块 → 没有可导入的单条规则', () => {
    expect(splitInstructionRules('')).toEqual([]);
    expect(splitInstructionRules('   \n\n')).toEqual([]);
    expect(splitInstructionRules('# 只有标题')).toEqual([]);
    expect(splitInstructionRules('```\nonly code\n```')).toEqual([]);
  });

  it('确定性：同输入两次调用输出完全一致', () => {
    const raw = [
      '---',
      'name: mixed',
      '---',
      '',
      '# 标题',
      '',
      '- 列表规则一条',
      '- 重复规则',
      '重复规则',
      '',
      '一段两句话。第二句。超长句：' + Array.from({ length: 40 }, (_, i) => `分句${i}`).join('，') + '。',
      '',
      '```ts',
      'const a = 1;',
      '```',
      '',
    ].join('\n');
    expect(splitInstructionRules(raw)).toEqual(splitInstructionRules(raw));
  });

  it('所有输出条目都不超过注入单条上限（混合夹具全量断言）', () => {
    const rules = splitInstructionRules([
      '- 这一条正好一百二十个字符以内' + '长'.repeat(90),
      `一条超过上限的列表项，会被继续按分句标点拆开，${'内'.repeat(150)}，然后再截断。`,
      '普通短句。',
    ].join('\n'));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.length).toBeLessThanOrEqual(LIMIT);
    }
  });
});
