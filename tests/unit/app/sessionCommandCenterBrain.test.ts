// ============================================================================
// T3b: 会话指挥台前台 brain 的设计声明 + allowlist 组装
//
// 依据 2026-08-07-T3-工具坍缩排查报告 §7.4-2：SESSION_COMMAND_CENTER_BRAIN_CONTEXT
// 缺一句"这是流程设计，不是权限问题或环境故障"的说明，模型只能对用户编"环境受限"。
// 对称应用 skillBoundaryScope.ts 的 buildStrictToolsetNotice 同款声明。
//
// 桌面（agentAppService.ts）与 web（web/routes/agent.ts）两条装配路共用同一份
// brain 上下文清单：getSessionCommandCenterBrainContextForPrompt（桌面经
// withSessionCommandCenterBrain 拼进 turnSystemContext，web 展开进 config.systemPrompt），
// 改这一处即两路生效。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  getSessionCommandCenterBrainContextForPrompt,
  getTextForegroundToolNamesForPrompt,
  withSessionCommandCenterBrain,
} from '../../../src/host/app/sessionCommandCenterBrain';
// 常量已不导出（防止装配路绕过单一真源直接拼常量），这里从共用函数取基块：
// 空白轮次不命中任何回合级规则，返回值唯一成员就是 brain 基块。
const SESSION_COMMAND_CENTER_BRAIN_CONTEXT = getSessionCommandCenterBrainContextForPrompt('')[0];
import {
  isSessionCommandCenterTurn,
  SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS,
} from '../../../src/shared/constants/sessionCommandCenter';
import {
  getProtocolRegistry,
  getTextForegroundToolNames,
} from '../../../src/host/tools/protocolRegistry';
import { chatTranscriptEn, chatTranscriptZh } from '../../../src/renderer/i18n/chatTranscript';
import { getSystemReminders } from '../../../src/host/prompts/systemReminders';

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
    for (const name of ['Bash', 'WebSearch', 'ToolSearch']) {
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).not.toContain(name);
    }
    for (const word of ['禁用', '受限', '不能动']) {
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).not.toContain(word);
    }
  });

  it('names every tool it actually has, so the model knows the boundary up front', () => {
    for (const name of getTextForegroundToolNames()) {
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain(name);
    }
  });

  // ADR-056：提示词必须和工具表一致。这条门存在的原因是原文逐字写着
  //「你本轮只看得到这 5 个工具，Read/Bash/Grep/ToolSearch 等其他工具都不在这里」——
  // 放开只读工具后不改它，模型会被自己的系统提示词说服自己没有 Read。
  it('does not tell the model it lacks the read tools it now has', () => {
    for (const name of ['Read', 'Grep', 'Glob', 'ListDirectory']) {
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).not.toMatch(
        new RegExp(`${name}[^\\n]*(都不在这里|没有|不可用)`),
      );
    }
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).not.toContain('只看得到这 5 个工具');
  });

  it('still routes commands, network, approvals and long generation to delegate_task', () => {
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('delegate_task');
    for (const intent of ['跑命令', '联网查证', '等待审批', '生成级长任务']) {
      expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain(intent);
    }
  });

  it('covers direct foreground writes and contextual file references', () => {
    expect(SESSION_COMMAND_CENTER_BRAIN_CONTEXT).toContain('直接读取并修改本地文件');
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

describe('ADR-059 声明式文字前台边界', () => {
  it('带上只读工具（用户问文件内容不该被逼着派活）', () => {
    const names = getTextForegroundToolNames();
    for (const name of ['Read', 'Grep', 'Glob', 'ListDirectory']) {
      expect(names).toContain(name);
    }
  });

  // ADR-056 回归（2026-08-09）：ADR 明确允许前台**发起委派**，四元组却只登记了通用后台任务
  // 这一种入口，漏了角色委派 ⇒ 用户说「让溯真去调研 X」时模型手上只有 delegate_task，
  // 只能把角色名写进 prompt 让通用任务扮演，那个角色从未被真正调起（RoleWriteBack 零日志）。
  it('带上角色委派入口（否则前台永远调不起持久化角色）', () => {
    expect(getTextForegroundToolNames()).toContain('spawn_agent');
  });

  it('短小文件写工具由 schema 声明进入前台', () => {
    expect(getTextForegroundToolNames()).toEqual(expect.arrayContaining(['Write', 'Edit']));
  });

  it('生成、命令、联网和缺少同等级安全门的写工具仍留在后台', () => {
    for (const name of ['Append', 'notebook_edit', 'Bash', 'WebSearch', 'ToolSearch']) {
      expect(getTextForegroundToolNames()).not.toContain(name);
    }
  });

  it('前台可见性不降低写工具的权限与路径 authority', () => {
    const schemas = getProtocolRegistry().getSchemas();
    for (const name of ['Write', 'Edit']) {
      const schema = schemas.find((candidate) => candidate.name === name);
      expect(schema).toMatchObject({
        allowInTextForeground: true,
        permissionLevel: 'write',
        pathAuthority: [{ kind: 'path', pathParameter: 'file_path' }],
      });
      expect(schema?.requiresPermission).not.toBe(false);
    }
  });
});

describe('withSessionCommandCenterBrain', () => {
  it('sets the brain allowlist and appends the brain context (which carries the design notice)', () => {
    const options = withSessionCommandCenterBrain(undefined);

    expect(options.allowedToolNames).toEqual(getTextForegroundToolNames());
    // 这份名单只是前台 brain 自己的面，子代理不继承（N-SUBAGENT-WEBSEARCH-INHERIT）
    expect(options.foregroundToolFace).toBe(true);
    expect(options.allowedToolNames).not.toContain('wake_noop');
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

describe('晨报回复「存草稿 N」才打开 mail_draft', () => {
  const matches = [
    '存草稿 1',
    '存草稿1',
    '保存草稿 2',
    '存草稿第3',
    '存草稿 #4',
    '存草稿 ５',
    'save draft 6',
    'Save draft #7',
    '请存草稿 1',
    '麻烦帮我存草稿 8',
    'please save draft 2',
    '  存草稿 1',
    '您好，保存草稿第１',
  ];
  const misses = [
    '存草稿箱里有什么',
    '晨报末尾写着可以存草稿 1',
    '今天有什么安排',
    '存草稿',
    '保存一下草稿 1',
    '帮我看看草稿 1',
  ];

  it.each(matches)('命中「%s」：白名单多 mail_draft，并只在这时追加回合规则', (prompt) => {
    const names = getTextForegroundToolNamesForPrompt(prompt);
    expect(names).toContain('mail_draft');
    expect(names.filter((name) => name === 'mail_draft')).toHaveLength(1);
    const options = withSessionCommandCenterBrain(undefined, prompt);
    expect(options.allowedToolNames).toContain('mail_draft');
    const extra = (options.turnSystemContext ?? []).filter((block) => block !== SESSION_COMMAND_CENTER_BRAIN_CONTEXT);
    expect(extra).toHaveLength(1);
  });

  it.each(misses)('不命中「%s」：不加 mail_draft，也不追加回合规则', (prompt) => {
    expect(getTextForegroundToolNamesForPrompt(prompt)).not.toContain('mail_draft');
    const options = withSessionCommandCenterBrain({
      turnSystemContext: ['<existing_context>keep me</existing_context>'],
    }, prompt);
    expect(options.allowedToolNames).not.toContain('mail_draft');
    expect(options.turnSystemContext).toEqual([
      '<existing_context>keep me</existing_context>',
      SESSION_COMMAND_CENTER_BRAIN_CONTEXT,
    ]);
  });

  it('命中时保留已有上下文，规则块写明重复保存和没有邮件权限', () => {
    const options = withSessionCommandCenterBrain({
      turnSystemContext: ['<existing_context>keep me</existing_context>'],
    }, '存草稿 1');
    expect(options.turnSystemContext?.[0]).toBe('<existing_context>keep me</existing_context>');
    expect(options.turnSystemContext?.[1]).toBe(SESSION_COMMAND_CENTER_BRAIN_CONTEXT);
    const block = options.turnSystemContext?.[2] ?? '';
    expect(block).toContain('已经存过');
    expect(block).toContain('没有开邮件权限');
    expect(block).toContain('如果本轮工具表里有 mail_draft');
    // rework r1：条件钉成「还没有成功的 mail_draft 结果」——只有成功才挡重复调用，
    // 被拒/失败后用户再回「存草稿 N」仍允许重试（与第 5 条的「已经成功过」同一口径）。
    expect(block).toContain('且这封在本对话里还没有成功的 mail_draft 结果，你才调用它');
    expect(block).toContain('mail_draft');
    expect(block).toContain('delegate_task');
    expect(block).toContain('一共有几封草稿');
    expect(block).toContain('没有发送');
  });

  // rework r1：回合规则块的单一真源。桌面（withSessionCommandCenterBrain）和 web 主链
  // （routes/agent.ts systemPrompt）两条装配路都消费这一个函数——判据或内容改出第二份，
  // 就是「修了桌面漏了 web」的复发。
  it('getSessionCommandCenterBrainContextForPrompt 是两条装配路共用的块清单', () => {
    expect(getSessionCommandCenterBrainContextForPrompt('今天有什么安排'))
      .toEqual([SESSION_COMMAND_CENTER_BRAIN_CONTEXT]);
    const blocks = getSessionCommandCenterBrainContextForPrompt('存草稿 2');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(SESSION_COMMAND_CENTER_BRAIN_CONTEXT);
    expect(blocks[1]).toContain('<morning_brief_save_draft>');
    // 与桌面装配路的产物同形：withSessionCommandCenterBrain 的尾部即这份清单
    const options = withSessionCommandCenterBrain(undefined, '存草稿 2');
    expect(options.turnSystemContext?.slice(-2)).toEqual(blocks);
  });
});

// ============================================================================
// 单轮 Office 文件交付的前台面扩展（N-HOME-STARTER-CARDS-FILES r2）
// 首屏卡点击的周报/表格轮必须把原生生成工具送进模型可见面，同时委派入口出局——
// 否则前台没有 Bash，模型只剩「写脚本 + delegate_task 派后台」，后台 terminal_write
// 撞审批卡死，整轮「运行失败」（r1 真机实录）。
// ============================================================================

describe('getTextForegroundToolNamesForPrompt — 文件交付扩展', () => {
  // 用首屏卡的完整正文，而不是截短样本。中文周报卡的示例素材含「供应商接口」，
  // isDocumentTask 会被代码语境否决；工具面必须仍按 .docx 把 docx_generate 送上轮。
  const weeklyZh = chatTranscriptZh.chat.suggestions.weeklyReport.prompt;
  const weeklyEn = chatTranscriptEn.chat.suggestions.weeklyReport.prompt;
  const sheetZh = chatTranscriptZh.chat.suggestions.sheetAnalysis.prompt;
  const sheetEn = chatTranscriptEn.chat.suggestions.sheetAnalysis.prompt;

  it.each([
    ['zh 周报卡', weeklyZh, ['docx_generate']],
    ['en 周报卡', weeklyEn, ['docx_generate']],
    ['zh 表格卡', sheetZh, ['excel_generate', 'DocEdit']],
    ['en 表格卡', sheetEn, ['excel_generate', 'DocEdit']],
  ])('%s：前台面按需纳入生成工具', (_label, prompt, expected) => {
    const names = getTextForegroundToolNamesForPrompt(prompt);
    for (const name of expected) {
      expect(names).toContain(name);
    }
    // 基础面前成员原样保留
    for (const name of ['Read', 'Write', 'Edit', 'AskUserQuestion']) {
      expect(names).toContain(name);
    }
  });

  it('非交付轮的前台面保持基础面不变', () => {
    expect(getTextForegroundToolNamesForPrompt('你好，帮我看看今天有什么安排'))
      .toEqual(getTextForegroundToolNames());
    expect(getTextForegroundToolNamesForPrompt('打开 report.docx 看看结论'))
      .toEqual(getTextForegroundToolNames());
    // PR review 2026-10-15（rework r2）：对已有文件的转换/另存不是「从内容生成交付物」，
    // 生成器进面只会把模型引去重新生成一份 Word；这类轮保持基础面（委派后台可执行
    // 真实转换）。
    expect(getTextForegroundToolNamesForPrompt('把已有 report.docx 转成 PDF 发我'))
      .toEqual(getTextForegroundToolNames());
    expect(getTextForegroundToolNamesForPrompt('帮我把 report.docx 另存到桌面'))
      .toEqual(getTextForegroundToolNames());
    expect(getTextForegroundToolNamesForPrompt('convert report.docx to PDF and send it over'))
      .toEqual(getTextForegroundToolNames());
  });

  it('withSessionCommandCenterBrain 带 prompt 时把生成工具写进 allowlist', () => {
    const options = withSessionCommandCenterBrain(undefined, weeklyZh);
    expect(options.allowedToolNames).toContain('docx_generate');
    const base = withSessionCommandCenterBrain(undefined);
    expect(base.allowedToolNames).toEqual(getTextForegroundToolNames());
  });
});

describe('文件交付轮的模型可见工具面（组装末端形状）', () => {
  it('周报卡：docx_generate 可见，delegate_task / spawn_agent 不可见', async () => {
    const { getCoreToolDefinitions, getLoadedDeferredToolDefinitions } = await import('../../../src/host/tools/dispatch/toolDefinitions');
    const { getToolSearchService } = await import('../../../src/host/services/toolSearch');
    const { filterToolsByRunPolicy } = await import('../../../src/host/agent/runtime/toolRunPolicy');

    const prompt = weeklyPromptForSurface();
    const allowed = getTextForegroundToolNamesForPrompt(prompt);
    // 与 deferredToolPreload 的白名单预载同语义：非 core 的白名单成员送上轮
    const service = getToolSearchService();
    for (const name of allowed) service.preloadTools([name], 'surface-test');
    const tools = [...getCoreToolDefinitions({}), ...getLoadedDeferredToolDefinitions()];
    const surface = filterToolsByRunPolicy(tools, {
      allowedToolNames: allowed,
      messages: [{ role: 'user', content: prompt }],
    } as any).map((definition) => definition.name);

    expect(surface).toContain('docx_generate');
    expect(surface).toContain('Write');
    expect(surface).not.toContain('delegate_task');
    expect(surface).not.toContain('spawn_agent');
    expect(surface).not.toContain('Bash');
    const reminders = getSystemReminders(prompt);
    expect(reminders.some((item) => item.includes('docx_generate'))).toBe(true);
    for (const absent of ['委派提醒', '并行派发提醒', '数据处理任务', '文档生成任务']) {
      expect(reminders.some((item) => item.includes(absent))).toBe(false);
    }
  });

  it('表格卡：excel_generate 与 DocEdit 可见，delegate_task 不可见', async () => {
    const { getCoreToolDefinitions, getLoadedDeferredToolDefinitions } = await import('../../../src/host/tools/dispatch/toolDefinitions');
    const { getToolSearchService } = await import('../../../src/host/services/toolSearch');
    const { filterToolsByRunPolicy } = await import('../../../src/host/agent/runtime/toolRunPolicy');

    const prompt = sheetPromptForSurface();
    const allowed = getTextForegroundToolNamesForPrompt(prompt);
    const service = getToolSearchService();
    for (const name of allowed) service.preloadTools([name], 'surface-test');
    const tools = [...getCoreToolDefinitions({}), ...getLoadedDeferredToolDefinitions()];
    const surface = filterToolsByRunPolicy(tools, {
      allowedToolNames: allowed,
      messages: [{ role: 'user', content: prompt }],
    } as any).map((definition) => definition.name);

    expect(surface).toContain('excel_generate');
    expect(surface).toContain('DocEdit');
    expect(surface).not.toContain('delegate_task');
    expect(surface).not.toContain('spawn_agent');
    expect(surface).not.toContain('Bash');
    const reminders = getSystemReminders(prompt);
    expect(reminders.some((item) => item.includes('excel_generate'))).toBe(true);
    for (const absent of ['委派提醒', '并行派发提醒', '数据处理任务']) {
      expect(reminders.some((item) => item.includes(absent))).toBe(false);
    }
  });
});

function weeklyPromptForSurface(): string {
  return chatTranscriptZh.chat.suggestions.weeklyReport.prompt;
}

function sheetPromptForSurface(): string {
  return chatTranscriptZh.chat.suggestions.sheetAnalysis.prompt;
}
