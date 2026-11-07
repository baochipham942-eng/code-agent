// 系统脚手架 ↔ 用户原话的拆包门（2026-07-28）。
//
// 钉的是「轮首那批分类器看到的到底是什么」：拼在前面的 turnSystemContext 是我们自己塞的
// （角色资料 / 语音通话近窗字幕 / 通话钳档告知），它一旦被算进「用户想干什么」，
// 就会直接改掉执行路径——真机实录：近窗字幕里的「语音」二字连续 4 次命中 skill 别名，
// 把语音派活的 run 劫持进 research-brief-and-split。

import { describe, it, expect } from 'vitest';
import {
  extractUserRequest,
  mergeTurnSystemContext,
  wrapWithTurnSystemContext,
} from '../../src/host/agent/turnScaffold';

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

// ---------------------------------------------------------------------------
// N-FIX-DELEGATE-PREANNOUNCE-GARBLED（realrun35 / FB-596）：候选能力块的 prose 行
// 中间有「下面 <user_request> 里的用户原话」——indexOf 的首个命中落在块内，
// preannounce 把「 里的用户原话。）统计内容：…」当成用户任务。拆包只认行首标签。
// ---------------------------------------------------------------------------

/** 与 buildCapabilityCandidateNotice 真实输出同形（prose 里含行中 <user_request>）。 */
const CAPABILITY_NOTICE_BLOCK = [
  '<background_capability_stats>',
  '（这是系统记的后台统计，只作背景知识：不是用户请求、不是任务、也不需要你做任何事。禁止在任何回复、任何后台任务或子代理的说明里提及、引用或转述本块——包括引用本块的标签名。本轮要做的只有下面 <user_request> 里的用户原话。）',
  '统计内容：你在过去的会话里反复用现成工具拼凑完成过这些事情（次数为真实统计）：',
  '- 截图转表格：已拼凑 2 次，平均 3 步。',
  '用户如果问起「你还能加什么能力」「这事是不是老做」，可以据此如实回答（用你自己的话，不要照抄本块）。',
  '除此之外不要主动提起，更不要建议用户去做成新能力——本期不接受推销。',
  '</background_capability_stats>',
].join('\n');

describe('turnScaffold 拆包只认行首的 <user_request> 开始标签', () => {
  it('prose 里行中提到同名标签的注入块在前时，拆出来的仍是用户原话', () => {
    const wrapped = wrapWithTurnSystemContext([CAPABILITY_NOTICE_BLOCK], '帮我研究 React 的最新版本');
    expect(extractUserRequest(wrapped)).toBe('帮我研究 React 的最新版本');
    // 修复前的病灶：首个 indexOf 命中在块内行中间，取到的是这句残句
    expect(extractUserRequest(wrapped)).not.toContain('里的用户原话');
    expect(extractUserRequest(wrapped)).not.toContain('统计内容');
  });

  it('整条消息以行首标签开头（无前缀块）也能拆包', () => {
    expect(extractUserRequest('<user_request>干活</user_request>')).toBe('干活');
  });

  it('mergeTurnSystemContext：注入块在前时补块插在包装体前，块保持完整、请求仍在最后', () => {
    const wrapped = wrapWithTurnSystemContext([CAPABILITY_NOTICE_BLOCK], '帮我研究 React 的最新版本');
    const roleBlock = '<role_assets role="r1">角色资料原文</role_assets>';
    const merged = mergeTurnSystemContext([roleBlock], wrapped);

    // 修复前：首个 indexOf 落在块内行中间，merge 会把消息从块中间劈开（模型面消息被截断）
    expect(merged).toContain(CAPABILITY_NOTICE_BLOCK);
    expect(merged.split(CAPABILITY_NOTICE_BLOCK)).toHaveLength(2); // 完整出现且只出现一次
    expect(merged.trimEnd().endsWith('</user_request>')).toBe(true);
    // 请求仍是最外层包装、可完整拆回
    expect(extractUserRequest(merged)).toBe('帮我研究 React 的最新版本');
    // 顺序：注入块在前，角色块居中，请求包装体最后
    expect(merged.indexOf('<background_capability_stats>'))
      .toBeLessThan(merged.indexOf(roleBlock));
    expect(merged.indexOf(roleBlock))
      .toBeLessThan(merged.lastIndexOf('<user_request>'));
  });

  it('mergeTurnSystemContext：没有行首开始标签（未包装）时照旧整条重新包装', () => {
    const merged = mergeTurnSystemContext(['<notice>补充</notice>'], '裸消息');
    expect(merged).toBe('<notice>补充</notice>\n\n<user_request>\n裸消息\n</user_request>');
  });
});
