// ============================================================================
// IACT `[label](!send)` chip 裸发文案修复：发送内容必须套用户表态模板，不能
// 原样带出 label 当独立指令。2026-08-01 真机事故：建议项「你来手动打开浏览器
// 看」被点击后原样发回，模型把它当新指令重跑一次网页抓取。
// ============================================================================

import { describe, expect, it } from 'vitest';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { buildIactChipSendText } from '../../../src/renderer/components/features/chat/ChatInput/iactChipConfirmation';

describe('buildIactChipSendText', () => {
  it('把 chip label 包进模板，不是裸发原文', () => {
    const label = '你来手动打开浏览器看';
    const result = buildIactChipSendText(zh, label);

    expect(result).not.toBe(label);
    expect(result).toContain(label);
    expect(result).toContain('我选择了建议项');
    expect(result).toContain('由我自行处理');
  });

  it('label 变化时输出跟着变（不是写死的固定串）', () => {
    const a = buildIactChipSendText(zh, '修复空指针检查');
    const b = buildIactChipSendText(zh, '重构整个函数');

    expect(a).toContain('修复空指针检查');
    expect(b).toContain('重构整个函数');
    expect(a).not.toBe(b);
  });

  it('英文语言包同样套模板且含原 label', () => {
    const label = 'open the browser yourself';
    const result = buildIactChipSendText(en, label);

    expect(result).not.toBe(label);
    expect(result).toContain(label);
    expect(result).toContain('I selected the suggested option');
  });

  it('zh/en 模板均含 {label} 占位符（双语键存在性契约）', () => {
    expect(zh.chatInput.iactChipConfirmation).toContain('{label}');
    expect(en.chatInput.iactChipConfirmation).toContain('{label}');
  });
});
