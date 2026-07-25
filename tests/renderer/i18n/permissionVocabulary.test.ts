// ============================================================================
// 权限档词汇只有一套
// ============================================================================
// 曾经是两套并存：会话档（底栏）「安全模式 / 只读探索 / 自动编辑 / YOLO 模式」，
// 专家档（安全页 + 装包摘要卡）「严格 / 标准 / 放手」。同一个概念两种叫法。
//
// 现在两边都引用 permissionVocabulary，结构上不可能分叉——这道门防的是
// 有人把某一处改回字面量，以及「YOLO」这类圈内黑话回潮到危险档上。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import {
  permissionVocabularyEn,
  permissionVocabularyZh,
} from '../../../src/renderer/i18n/permissionVocabulary';

const PAIRS = [
  ['default', 'strict', 'ask'],
  ['acceptEdits', 'development', 'autoApprove'],
  ['bypassPermissions', 'ci', 'fullAccess'],
] as const;

describe('权限档词汇', () => {
  it.each(PAIRS)('会话档 %s 与专家档 %s 用同一个词', (sessionTier, rolePreset, vocabKey) => {
    for (const [bundle, vocab] of [[zh, permissionVocabularyZh], [en, permissionVocabularyEn]] as const) {
      const sessionTitle = bundle.settings.general.permissions.permissionModes[sessionTier].title;
      const roleLabel = bundle.expert.roleSecurity.presets[rolePreset].label;
      expect(sessionTitle).toBe(vocab[vocabKey]);
      expect(roleLabel).toBe(vocab[vocabKey]);
    }
  });

  it('危险档不叫 YOLO，也不用其他圈内黑话', () => {
    // 只查档位标题会漏——确认弹窗有自己独立的一套文案，第一版就漏在那里。
    // 整包扫，任何角落回潮都red。
    for (const bundle of [zh, en]) {
      expect(JSON.stringify(bundle.settings).toLowerCase()).not.toContain('yolo');
    }
    // 用玩笑词命名风险最高的一档，比说不清楚更糟
    expect(JSON.stringify(permissionVocabularyZh).toLowerCase()).not.toContain('yolo');
    expect(JSON.stringify(permissionVocabularyEn).toLowerCase()).not.toContain('yolo');
  });

  it('只读档只有会话侧有，专家侧没有这一档——不要为了对称硬造', () => {
    expect(zh.settings.general.permissions.permissionModes.readOnly.title).toBe(permissionVocabularyZh.readOnly);
    expect(Object.keys(zh.expert.roleSecurity.presets)).toEqual(['strict', 'development', 'ci']);
  });
});
