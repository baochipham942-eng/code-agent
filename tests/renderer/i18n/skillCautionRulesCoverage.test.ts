// ============================================================================
// skill caution 规则白话句覆盖棘轮
// ============================================================================
// 安装披露弹窗的正文是一句一句的风险描述（zh/enSkillCautionRules）。规则 id 的真源在
// host：commandSafety.ts / windowsRules.ts 的 flag 字面量 + validateCommand 里 push 进
// securityFlags 的字面量。这里直接读那两份源码文本收集 id，任何 id 缺 zh 或 en 句子即红
// ——新增规则忘了配白话句，弹窗就会对该规则露出兜底串（等于没做本单要的翻译）。
// 不从 host 模块 import 规则表：那会逼着 host 为测试新开导出面（无消费方的 dead export）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { zhSkillCautionRules } from '../../../src/renderer/i18n/zhSkillCautionRules';
import { enSkillCautionRules } from '../../../src/renderer/i18n/enSkillCautionRules';

const ROOT = path.resolve(__dirname, '../../..');
const HOST_RULE_SOURCES = [
  'src/host/security/commandSafety.ts',
  'src/host/security/shellRules/windowsRules.ts',
];

/** 规则 id 一律 snake_case 小写（'private-host' 这类比较词不是 id，借此排除） */
const RULE_ID_RE = /^[a-z0-9_]+$/;

function collectRuleIds(source: string): Set<string> {
  const ids = new Set<string>();
  // 1) 规则表字面量：BLOCKED_PATTERNS / DANGEROUS_PATTERNS / BLOCK_RULES / DANGER_RULES
  for (const match of source.matchAll(/flag:\s*'([^']+)'/g)) {
    if (RULE_ID_RE.test(match[1])) ids.add(match[1]);
  }
  // 2) validateCommand 内直接 push 的字面量（env_access、egress_private_host、
  //    egress_unresolvable_target）。push 参数里的 'private-host' 是比较词，被 RULE_ID_RE 排除。
  for (const push of source.matchAll(/securityFlags\.push\(([\s\S]*?)\)/g)) {
    for (const literal of push[1].matchAll(/'([^']+)'/g)) {
      if (RULE_ID_RE.test(literal[1])) ids.add(literal[1]);
    }
  }
  return ids;
}

const hostRuleIds = new Set<string>(
  HOST_RULE_SOURCES.flatMap((rel) => {
    const source = readFileSync(path.join(ROOT, rel), 'utf8');
    return [...collectRuleIds(source)];
  }),
);

describe('skill caution 规则白话句覆盖（zh/en 逐规则钉死）', () => {
  it('host 规则源里收集到了规则 id（收集器失效时本测试会假绿，先钉住非空）', () => {
    // 已知存量：posix 侧 31 个 flag + windows 侧 21 个 flag，往下只许增不许断崖
    expect(hostRuleIds.size).toBeGreaterThanOrEqual(50);
    expect(hostRuleIds).toContain('recursive_delete_targeted');
    expect(hostRuleIds).toContain('env_access');
    expect(hostRuleIds).toContain('egress_private_host');
    expect(hostRuleIds).toContain('win_recursive_delete');
  });

  it('每个规则 id 在 zh 与 en 都有一句非空描述', () => {
    const missing = [...hostRuleIds]
      .filter((id) => typeof zhSkillCautionRules.rules[id] !== 'string' || zhSkillCautionRules.rules[id].trim() === '')
      .map((id) => `zh:${id}`)
      .concat(
        [...hostRuleIds]
          .filter((id) => typeof enSkillCautionRules.rules[id] !== 'string' || enSkillCautionRules.rules[id].trim() === '')
          .map((id) => `en:${id}`),
      );
    expect(missing, `缺白话句的规则：${missing.join(', ')}`).toEqual([]);
  });

  it('zh 与 en 的规则键集一致（satisfies 锁不住 Record 键集，在这里锁）', () => {
    expect(Object.keys(enSkillCautionRules.rules).sort()).toEqual(
      Object.keys(zhSkillCautionRules.rules).sort(),
    );
  });

  it('嵌入密钥前缀句与未知规则兜底句齐备，兜底句保留 {rule} 占位', () => {
    expect(zhSkillCautionRules.embeddedSecret.trim()).not.toBe('');
    expect(enSkillCautionRules.embeddedSecret.trim()).not.toBe('');
    expect(zhSkillCautionRules.fallback).toContain('{rule}');
    expect(enSkillCautionRules.fallback).toContain('{rule}');
  });
});
