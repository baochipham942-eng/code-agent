// 系统脚手架 ↔ 用户原话的拆包门（2026-07-28）。
//
// 钉的是「轮首那批分类器看到的到底是什么」：拼在前面的 turnSystemContext 是我们自己塞的
// （角色资料 / 语音通话近窗字幕 / 通话钳档告知），它一旦被算进「用户想干什么」，
// 就会直接改掉执行路径——真机实录：近窗字幕里的「语音」二字连续 4 次命中 skill 别名，
// 把语音派活的 run 劫持进 research-brief-and-split。

import { describe, it, expect } from 'vitest';
import { extractUserRequest, wrapWithTurnSystemContext } from '../../src/host/agent/turnScaffold';

/** 真机那份近窗字幕块的形状（含会撞 skill 别名的「语音」二字）。 */
const VOICE_BLOCK = [
  '[Voice — 通话近窗字幕原文]',
  '这件活来自一通实时语音通话。任务描述是语音层改写出来的，可能丢信息，也可能被语音识别写错。',
  '用户：从一数到二十。',
].join('\n');

describe('turnScaffold', () => {
  it('包起来再拆回来，拿到的是用户原话本身', () => {
    const wrapped = wrapWithTurnSystemContext([VOICE_BLOCK], '从1数到20');
    expect(extractUserRequest(wrapped)).toBe('从1数到20');
  });

  it('拆出来的原话不含系统块的任何内容——这正是 skill 别名被劫持的根因', () => {
    const wrapped = wrapWithTurnSystemContext([VOICE_BLOCK], '从1数到20');
    // 劫持发生在「分类器看到了块里的字」这一步；块里的关键词不许出现在分类器的输入里
    expect(wrapped).toContain('语音');
    expect(extractUserRequest(wrapped)).not.toContain('语音');
    expect(extractUserRequest(wrapped)).not.toContain('近窗');
  });

  it('没有系统上下文时原样返回，不加任何包装', () => {
    expect(wrapWithTurnSystemContext([], '从1数到20')).toBe('从1数到20');
    expect(extractUserRequest('从1数到20')).toBe('从1数到20');
  });

  it('多个系统块按顺序拼在原话前面', () => {
    const wrapped = wrapWithTurnSystemContext(['<role>甲</role>', '<notice>乙</notice>'], '干活');
    expect(wrapped.indexOf('甲')).toBeLessThan(wrapped.indexOf('乙'));
    expect(wrapped.indexOf('乙')).toBeLessThan(wrapped.indexOf('干活'));
    expect(extractUserRequest(wrapped)).toBe('干活');
  });

  it('用户原话里自己带了同名标签时，取最外层包住的那份', () => {
    const wrapped = wrapWithTurnSystemContext([VOICE_BLOCK], '帮我解释 <user_request> 这个标签');
    expect(extractUserRequest(wrapped)).toBe('帮我解释 <user_request> 这个标签');
  });
});
