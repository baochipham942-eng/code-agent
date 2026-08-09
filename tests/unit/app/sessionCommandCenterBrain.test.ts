// ============================================================================
// T3b: 会话指挥台前台 brain 的设计声明 + allowlist 组装
//
// 依据 2026-08-07-T3-工具坍缩排查报告 §7.4-2：SESSION_COMMAND_CENTER_BRAIN_CONTEXT
// 缺一句"这是流程设计，不是权限问题或环境故障"的说明，模型只能对用户编"环境受限"。
// 对称应用 skillBoundaryScope.ts 的 buildStrictToolsetNotice 同款声明。
//
// 桌面（agentAppService.ts）与 web（web/routes/agent.ts）两条判定通路共用同一份
// SESSION_COMMAND_CENTER_BRAIN_CONTEXT 常量（web 直接 import 常量，桌面经
// withSessionCommandCenterBrain 拼进 turnSystemContext），改这一处即两路生效。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  SESSION_COMMAND_CENTER_BRAIN_CONTEXT,
  withSessionCommandCenterBrain,
} from '../../../src/host/app/sessionCommandCenterBrain';
import {
  isSessionCommandCenterTurn,
  SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES,
  SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS,
  SESSION_COMMAND_CENTER_READ_TOOL_NAMES,
} from '../../../src/shared/constants/sessionCommandCenter';

describe('SESSION_COMMAND_CENTER_BRAIN_CONTEXT design notice', () => {
  it('tells the model the tool narrowing is by design, not an environment fault', () => {
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('流程设计');
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('不是权限问题或环境故障');
  });

  // ADR-056 首轮真机 FAIL 的机制：原文点名「Bash/Write/Edit/WebSearch/ToolSearch 一概没有」，
  // 并在同一句写「不要向用户说"环境禁用了"」。模型的拒绝原话把三个工具名和「禁用」一起还了
  // 回来（session_1786186241326_0bce358d：「Write、Edit、Bash 工具均被禁用」）。
  // 「不要说 X」和 X 写在同一句是经典失效形态——这道门钉住「只讲能做什么」，
  // 防止有人再把负向枚举加回来。
  it('does not hand the model the refusal vocabulary it echoed back', () => {
    for (const name of ['Bash', 'Write', 'Edit', 'WebSearch', 'ToolSearch']) {
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).not.toContain(name);
    }
    for (const word of ['禁用', '受限', '不能动']) {
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).not.toContain(word);
    }
  });

  it('names every tool it actually has, so the model knows the boundary up front', () => {
    for (const name of SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES) {
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain(name);
    }
  });

  // ADR-056：提示词必须和工具表一致。这条门存在的原因是原文逐字写着
  //「你本轮只看得到这 5 个工具，Read/Bash/Grep/ToolSearch 等其他工具都不在这里」——
  // 放开只读工具后不改它，模型会被自己的系统提示词说服自己没有 Read。
  it('does not tell the model it lacks the read tools it now has', () => {
    for (const name of SESSION_COMMAND_CENTER_READ_TOOL_NAMES) {
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).not.toMatch(
        new RegExp(`${name}[^\\n]*(都不在这里|没有|不可用)`),
      );
    }
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).not.toContain('只看得到这 5 个工具');
  });

  it('still routes side-effecting work to delegate_task', () => {
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('delegate_task');
    // 写/跑命令/联网这三类必须仍被点名为「派活」——正向说法，不点名缺哪个工具
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toMatch(/写文件[、，].*跑命令[、，].*delegate_task/);
  });

  // B 组（先读一轮再写）的 FAIL 与 A 组（新会话直接写）的 PASS 差了两个变量：读过 + 指代。
  // 提示词按「与读没读过无关」的形式写死这两条，修法就不依赖对照结论。
  it('covers the two variables that separated the FAIL run from the PASS run', () => {
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('已经读过内容再收到写请求');
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('解析成绝对路径');
  });
});

describe('isSessionCommandCenterTurn', () => {
  it('斜杠命令不走指挥台', () => {
    expect(isSessionCommandCenterTurn({ prompt: '/commit', hasGoal: false })).toBe(false);
    // 前导空白不该让斜杠命令逃逸（两处实现都用 trimStart，这里钉住）
    expect(isSessionCommandCenterTurn({ prompt: '   /commit', hasGoal: false })).toBe(false);
  });

  it('带 goal 不走指挥台', () => {
    expect(isSessionCommandCenterTurn({ prompt: '随便说点什么', hasGoal: true })).toBe(false);
  });

  it('自然语言走指挥台', () => {
    expect(isSessionCommandCenterTurn({ prompt: '读一下 package.json', hasGoal: false })).toBe(true);
  });
});

// ADR-056：前台能看不能动。这两条是判据本身，不是文案。
describe('前台 allowlist 的副作用边界', () => {
  it('带上只读工具（用户问文件内容不该被逼着派活）', () => {
    for (const name of SESSION_COMMAND_CENTER_READ_TOOL_NAMES) {
      expect(SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES).toContain(name);
    }
  });

  it('绝不带上有副作用的工具', () => {
    for (const name of ['Bash', 'Write', 'Edit', 'Append', 'WebSearch', 'ToolSearch']) {
      expect(SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES).not.toContain(name);
    }
  });
});

describe('withSessionCommandCenterBrain', () => {
  it('sets the brain allowlist and appends the brain context (which carries the design notice)', () => {
    const options = withSessionCommandCenterBrain(undefined);

    expect(options.allowedToolNames).toEqual([...SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES]);
    expect(options.maxIterations).toBe(SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS);
    expect(options.turnSystemContext).toContain(SESSION_COMMAND_CENTER_BRAIN_CONTEXT);
  });

  it('preserves any existing turnSystemContext instead of replacing it', () => {
    const options = withSessionCommandCenterBrain({
      turnSystemContext: ['<existing_context>keep me</existing_context>'],
    });

    expect(options.turnSystemContext).toEqual([
      '<existing_context>keep me</existing_context>',
      SESSION_COMMAND_CENTER_BRAIN_CONTEXT,
    ]);
  });
});
