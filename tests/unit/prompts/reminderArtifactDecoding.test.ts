// ============================================================================
// 触发式 reminder 的默认开场（方案 D 二期）
//
// 一期改常驻层（identity / base/tools），dogfood 却发现开场没变：模型跟的是
// contentGeneration.ts 里 PPT 提醒的「第一步：收集信息（必须）→ 通用主题先 WebSearch」，
// 直接去 WebSearch，没落骨架。
//
// 根因（一期 dogfood-B.log 逐位复现）：reminder 和 few-shot 范本是**拼在同一段注入的**，
// few-shot 就在 reminder 正下方、位置更近，仍然输了——因为 reminder 是「必须」的指令，
// few-shot 只是示例。**指令压过示例，与位置无关。**
// 所以范本写「先落骨架、把假设摆明、你直接改」没用，得把指令本身的默认值翻过来。
//
// 改的是「先调研还是先落骨架」这个默认开场，不是「要不要调研」——
// 依赖时效数据/对方私有材料时仍然先查。数据/Excel 的「先看数据再动手」与范本一致，
// 视频的「先确认再生成」是付费成本安全，都不动。
//
// 纪律：reminder 是字符串、shouldInclude 是纯函数——触发条件与内容全部在这里免费锁死，
// 不拿真模型跑。eval 只用来测行为。
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  createReminderContext,
  selectReminders,
  appendRemindersToMessage,
} from '../../../src/host/prompts/dynamicReminders';
import { getReminderById } from '../../../src/host/prompts/reminders';
import { IDENTITY_PROMPT } from '../../../src/host/prompts/identity';

// registry.ts:74 明写：prompt 导出是 Proxy 包装（为了让 override 运行时生效），
// `typeof IDENTITY_PROMPT === 'object'` 而非 'string'。直接 toContain 会走可迭代
// （逐字符）语义、永远匹配不到子串，且报错长得像「内容缺失」——必须先转原始串。
const IDENTITY = String(IDENTITY_PROMPT);

/** 复现生产注入路径：conversationRuntime 就是拿 userMessage 的增量部分做 reminder 的 */
function inject(userMessage: string, maxTokens?: number): string {
  const ctx = createReminderContext(userMessage);
  const result = selectReminders(ctx, maxTokens ? { maxTokens } : undefined);
  return appendRemindersToMessage(userMessage, result.reminders).substring(userMessage.length).trim();
}

const PPT = '帮我做一份 Q3 营销方案的 PPT';
const DOC = '帮我写一份 Q3 营销季度报告';

describe('产物 reminder：默认开场是先落产物，不是先调研', () => {
  it('PPT 的第一步不再是「收集信息（必须）」', () => {
    const injected = inject(PPT);
    // 只断 not.toContain 会被「整段被删」骗过 —— 正向配对断言：第一步这段仍在，只是换了默认值
    expect(injected).not.toContain('第一步：收集信息（必须）');
    expect(injected).toContain('第一步：先落骨架，不要先调研，也不要先问需求');
  });

  it('「先问一轮」这扇门也必须关上', () => {
    // dogfood 实测：只关「先调研」的门，模型转头就用 AskUserQuestion 先问用途/受众，
    // 照样不落骨架。禁调研而不禁提问 = 换个姿势拖延产物。
    expect(inject(PPT)).toContain('不要用 AskUserQuestion 问');
    expect(inject(DOC)).toContain('不要用 AskUserQuestion 先问');
  });

  it('PPT 的第一步不再点名工程文件', () => {
    const injected = inject(PPT);
    expect(injected).not.toContain('package.json');
    expect(injected).not.toContain('CLAUDE.md');
    // 「读对方给的材料」这个能力必须还在（代码库场景靠 README 兜住）
    expect(injected).toContain('先读他给的材料');
    expect(injected).toContain('README');
  });

  it('PPT 开场三要素：落骨架 / 摆假设 / 缺数据标示例而不编造', () => {
    const injected = inject(PPT);
    expect(injected).toContain('直接给一版大纲骨架');
    expect(injected).toContain('把你的假设摆明');
    expect(injected).toContain('示例数据，待替换');
    expect(injected).toContain('不编造');
  });

  it('文档的第一步是先出初稿，不是先收集素材', () => {
    const injected = inject(DOC);
    expect(injected).not.toContain('第一步：收集素材');
    expect(injected).toContain('第一步：先出初稿，不要先收集，也不要先问需求');
    expect(injected).toContain('直接写一版完整初稿');
  });

  it('调研能力没被删掉，只是降为按需', () => {
    const ppt = inject(PPT);
    // 时效性主题仍然先查 —— 改的是默认值不是能力
    expect(ppt).toContain('WebSearch');
    expect(ppt).toContain('只有内容依赖你不可能知道的事实时才先查');
    expect(inject(DOC)).toContain('WebSearch');
  });
});

describe('reminder 与 few-shot 范本不再互相打架', () => {
  // 这是本单要修的真缺陷：两者同段注入，指令赢，所以指令必须和范本同向。
  it('PPT：指令与范本同时在场，且都主张先落骨架', () => {
    const injected = inject(PPT);
    // 范本确实在场（在场却被无视，正是一期 dogfood 的实况）
    expect(injected).toContain('我先把骨架搭出来给你看');
    // 指令与范本同向：不存在「必须先收集」压着范本的矛盾
    expect(injected).toContain('先落骨架');
    expect(injected).not.toContain('收集信息（必须）');
  });

  it('文档：指令与范本同时在场，且都主张先出初稿', () => {
    const injected = inject(DOC);
    expect(injected).toContain('我先给你一版完整初稿');
    expect(injected).toContain('先出初稿');
  });
});

describe('常驻层 <ask_when_unclear>：产物偏好不算「无法解析的输入」', () => {
  // 二期 dogfood 实测（MiniMax + DeepSeek 两个模型复现）：把 reminder 的「先调研」和
  // 「先提问」两扇门都关上，模型仍然首个调 AskUserQuestion——因为 identity.ts 里这条是
  // 常驻的 MUST…FIRST，而且把「假设」定性成 guessing=坏，比 reminder 硬。
  // 四个例子清一色是工程参数问题（截断 URL / 裸 ID / 多义路径），本意是「无法解析的输入」，
  // 但「做份 PPT 没说受众」被模型读成了同一类。故显式划界。

  it('产物偏好被排除在「必须先问」之外', () => {
    expect(IDENTITY).toContain('It does NOT cover');
    expect(IDENTITY).toContain('deliverable preferences');
    expect(IDENTITY).toContain('state the assumption, produce the draft — do not ask');
  });

  it('反回归：工程侧「参数不可解析就必须先问」原封不动', () => {
    expect(IDENTITY).toContain('you MUST call AskUserQuestion FIRST instead of guessing');
    expect(IDENTITY).toContain('Truncated URL');
    expect(IDENTITY).toContain('Bare ID without context');
    expect(IDENTITY).toContain('Ambiguous file path');
  });
});

describe('反回归：没被改的产物 reminder 一个字都不许动', () => {
  it('数据处理仍要求先读数据再动手（与范本一致，本就不冲突）', () => {
    const injected = inject('帮我把这些销售数据做成 Excel 表，按区域汇总');
    expect(injected).toContain('第一步：读取数据（必须）');
    expect(injected).toContain('不要猜测数据结构，必须先看数据');
  });

  it('视频仍要求先确认再生成（付费产物的成本安全，不适用先落骨架）', () => {
    const injected = inject('帮我做个视频，5 秒的产品宣传');
    expect(injected).toContain('第一步：理解需求');
    expect(injected).toContain('不要在生成完成前就说"已完成"');
  });

  it('PPT 的内容规范与图表控制没被稀释', () => {
    const injected = inject(PPT);
    expect(injected).toContain('禁止编造虚假数据');
    expect(injected).toContain('每页 4-5 个要点');
    expect(injected).toContain('chart_mode: auto');
  });
});

describe('反回归：编程场景不许被产物 reminder 污染', () => {
  it.each([
    '帮我实现一个用户管理功能',
    '分析这个项目的整体架构',
    '重构 excel 导出那段代码',
    '修复 document.getElementById 的报错',
    '实现 image 上传功能',
    '把这个函数的单元测试补上',
  ])('产物开场指令不得进入编程任务: %s', (msg) => {
    const injected = inject(msg);
    expect(injected).not.toContain('先落骨架');
    expect(injected).not.toContain('先出初稿');
    expect(injected).not.toContain('PPT 生成必须遵循的流程');
  });
});

describe('预算：调大 tokens 声明不能把 reminder 自己挤出去', () => {
  // 声明值喂 TokenBudgetManager，报低了预算失真，报高了可能被 priority-1 预算门筛掉。
  it.each([1200, 800])('PPT reminder 在 maxTokens=%i 下仍被选中', (budget) => {
    expect(inject(PPT, budget)).toContain('PPT 生成必须遵循的流程');
  });

  it('声明的 tokens 不低于正文实际体量', () => {
    // 中文约 1.5 字/token；报低会让 reminder 预算长期超支。
    for (const id of ['PPT_FORMAT_SELECTION', 'DOCUMENT_GENERATION_WORKFLOW']) {
      const r = getReminderById(id)!;
      expect(r.tokens).toBeGreaterThanOrEqual(Math.ceil(r.content.length / 1.6));
    }
  });
});
