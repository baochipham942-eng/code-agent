import type { AppServiceRunOptions } from '../../shared/contract/appService';
import { SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS } from '../../shared/constants/sessionCommandCenter';
import { getTextForegroundToolNames } from '../tools/protocolRegistry';
import { detectTaskFeatures } from '../prompts/systemReminders';
import { getNativeConnectorToolNamesForIntent } from '../connectors/nativeConnectorIntent';

// 不导出：web/桌面两条装配路都经 getSessionCommandCenterBrainContextForPrompt 取块，
// 导出常量只会引回「第二条装配路直接拼常量」的旧形态（rework r1）。
const SESSION_COMMAND_CENTER_BRAIN_CONTEXT = [
  '<session_command_center>',
  '你是这条文字会话的前台 brain。前台要保持快速流式回复，耗时执行一律交给后台任务槽。',
  '分诊规则：',
  '1. 闲聊、解释、基于现有上下文即可回答的问题，直接回答，不调用工具。',
  '2. 只要读几个文件、搜一下代码、看看目录就能回答的问题，自己用 Read/Grep/Glob/ListDirectory 读完直接答，不要派活——为一次文件读取开一个后台任务是浪费。',
  '3. 短小的本地文件修改，先 Read 再用 Edit 或 Write 直接完成；写报告/文档/表格时若本轮工具表已有对应生成工具（docx_generate、excel_generate），直接调用它把文件交付掉；运行命令、联网查证、多步骤执行、等待审批，以及做网页等其他生成级长任务，调用 delegate_task。读的量大到要翻遍整个仓库时也派活。',
  '3a. 本轮工具表里已有邮件、日历、提醒事项工具时，发邮件、建日程、设提醒这类请求直接调用对应工具完成，不派 delegate_task；发送或创建前聊天里会出现确认卡片，按用户在卡片上的选择如实回复，只在工具返回成功后才说已发送或已创建。',
  '4. 用户点名要某个角色去做（"让溯真去调研 X""这件事交给明镜"），调用 spawn_agent 把活交给那个角色本人，不要用 delegate_task 把角色名写进 prompt 让通用任务扮演——扮演出来的产出不会进那个角色的记忆和履历，下次它回来还是一张白纸。没点名角色时照常用 delegate_task。',
  '5. 用户补充或修正某件正在做的工作，调用 steer_task；要求停止时调用 cancel_task；用户主动追问进度时调用 task_status——没人问就不要查进度，派完活直接结束 turn。',
  '6. 目标任务不唯一、并发槽已满或取消代价较高时，调用 AskUserQuestion 让用户按短名选择，不替用户猜。',
  '派活纪律：short_name 用 2-4 个字符，中文或英文均可；同一目标沿用 lane_key；同一 turn 的重试沿用 submission_key。',
  'delegate_task 返回 accepted 只表示后台已接单。你可以告诉用户已经开始或排队，但不得声称完成；完成、失败和取消只以后续任务终态回流为准。',
  '绝不描述你没有真做过的事。只有对应工具返回成功后，才可以说已经读取、修改或执行。',
  '不要用“好的收到”空承接。派活后用一句话说明哪件短名已开始、排队或需要选择，然后结束当前 turn。',
  // 只讲能做什么，不枚举缺什么：ADR-056 首轮真机 FAIL 的机制是负向枚举本身——原文点名
  // 「Bash/Write/Edit 一概没有」并在同句写「不要说"环境禁用了"」，模型把三个工具名和「禁用」
  // 原样还了回来（session_1786186241326_0bce358d）。删起因优于再加一层反向指令。
  '你本轮可以直接读取并修改本地文件。用户要改标题、改几行文字或写一个短小文件时，先确认目标和现有内容，再用 Edit 或 Write 完成并如实回复结果；folder-trust、权限档和审批链路照常生效。',
  '用户要求跑命令、联网查证、装依赖、等待审批或完成生成级长任务时，调用 delegate_task 派到后台，再一句话说明它已经开始。这是流程设计，不是权限问题或环境故障。用户要一份 Word/Excel 文件且本轮工具表已有 docx_generate/excel_generate 时除外——直接调用生成工具交付，不派后台。',
  '用户用"这个文件""刚才那个"指代目标时，先从当前会话上下文解析成绝对路径。直接修改时把该路径传给文件工具；派后台时把它写进 delegate_task 的 prompt，因为后台任务读不到你这轮的上下文。',
  '</session_command_center>',
].join('\n');

/**
 * 文字前台工具面（ADR-059）+ 单轮文件交付扩展。
 *
 * 点名 .docx/.xlsx 交付物的轮次把原生生成工具直接放进前台面：docx_generate /
 * excel_generate 是本地产物工具（免确认桶），前台一轮即可交付文件。不扩的话模型
 * 只剩「写脚本 + delegate_task 派后台」一条路，后台 terminal_write 撞审批卡死，
 * 整轮以「运行失败」收场（N-HOME-STARTER-CARDS-FILES r2 实测）。DocEdit 只随
 * Excel 交付进面——多工作表（原始数据 + 汇总）靠它 add_sheet/set_range 追加。
 * 命中时这几个名字进 allowedToolNames，deferred 预载层会照白名单把 schema 送上轮。
 */
// 与 systemReminders 的 OFFICE_*_DELIVERABLE_RE 保持同一判据。种类看扩展名本身，
// 不看 isDocumentTask / isExcelTask：后者会被正文里的代码语境词一票否决
// （中文周报卡示例素材含「供应商接口」，isDocumentTask 为 false），提醒已经点名
// docx_generate，模型可见工具表里却没有它（r2b 真机）。
const OFFICE_DOC_DELIVERABLE_RE = /\.docx\b|\bword\s*文档|\bword\s+(?:document|file|report)\b/i;
const OFFICE_SHEET_DELIVERABLE_RE = /\.xlsx\b|\bexcel\s*(?:工作簿|表格|文件)|\bexcel\s+(?:workbook|spreadsheet|file)\b/i;

// 句首才算存草稿指令。晨报正文或句子中间出现这几个字不能把 mail_draft 送上轮。
// 允许的前缀只是客气话（请 / 麻烦 / 帮我 / 你好 / please），不是任意前文。
const SAVE_DRAFT_POLITE_RE = '(?:请帮我|麻烦你|请你|劳驾|拜托|您好|你好|please|kindly|请|麻烦|帮我)';
const SAVE_DRAFT_REPLY_RE = new RegExp(
  `^\\s*(?:${SAVE_DRAFT_POLITE_RE}[\\s,，。.!！]*)*(?:(?:存|保存)草稿\\s*(?:第|#|＃)?\\s*[0-9０-９]+|save\\s+draft\\s*(?:#|＃)?\\s*[0-9０-９]+)`,
  'iu',
);

/**
 * 用户在角色线程里回「存草稿 N」时追加。起草仍发生在无人值守的晨报里，
 * 这一轮只负责把点名的那一封原样存进邮箱草稿箱。
 */
const MORNING_BRIEF_SAVE_DRAFT_CONTEXT = [
  '<morning_brief_save_draft>',
  '用户这句是在要求把晨报里的一封草稿存进邮箱。按下面做，不要发挥。',
  '1. 只看本对话里最近一条晨间分诊结果（定时任务「晨间分诊」的结论）。草稿块从「草稿 N（未发送）」那一行开始，N 从 1 起：第二行是收件人邮箱，第三行是主题，从第四行起到下一块之前是正文。取出用户点名的那一封。',
  '2. 收件人、主题、正文原样抄进 mail_draft 的 to、subject、content。to 里只放邮箱地址，不要改写，不要新增收件人，不要加显示名或尖括号。',
  '3. 如果本轮工具表里有 mail_draft，且这封在本对话里还没有成功的 mail_draft 结果，你才调用它，不要先去找别的工具，不要调用 delegate_task，也不要调用 mail_send；如果没有工具，直接按第 7 条说明这位角色没有开邮件权限。',
  '4. N 超出范围，或这条晨报里没有草稿块时，直接说明一共有几封草稿，什么工具都不要调用。',
  '5. 同一封的 mail_draft 在本对话里已经成功过，就说这封已经存过，不要再次调用。',
  '6. 调用成功后告诉用户：草稿在邮箱的草稿箱里，没有发送。',
  '7. mail_draft 不在本轮工具里时，不要调用任何工具，直接回复“这位角色没有开邮件权限，草稿没有存进邮箱”。被拒绝或调用失败时，也不要再调用任何工具，必须直接回复用户这封草稿没有存进邮箱及原因，不要输出空回复，不要假装已经存好。',
  '</morning_brief_save_draft>',
].join('\n');

export function isMorningBriefSaveDraftReply(prompt: string): boolean {
  return SAVE_DRAFT_REPLY_RE.test(prompt);
}

/**
 * 本轮指挥台 brain 的系统上下文块（含回合级附加规则），桌面与 web 两条装配路的单一真源：
 * 桌面经 withSessionCommandCenterBrain 拼进 turnSystemContext，web 主链
 * （routes/agent.ts 的 config.systemPrompt）直接展开同一份块——见
 * shared/constants/sessionCommandCenter.ts 的警告：装配形状各异，判据与内容必须只有一份。
 */
export function getSessionCommandCenterBrainContextForPrompt(prompt: string): string[] {
  const blocks = [SESSION_COMMAND_CENTER_BRAIN_CONTEXT];
  if (isMorningBriefSaveDraftReply(prompt)) blocks.push(MORNING_BRIEF_SAVE_DRAFT_CONTEXT);
  return blocks;
}

/**
 * 连接器工具的 per-turn 进面（ADR-059 修订，N-FG-CONNECTOR-TOOLS）：
 * 「发邮件 / 建日程 / 设提醒」这类一句话外部写入不再绕 delegate_task 派后台——
 * 命中意图 × 设置启用 × registry 就绪（unchecked 仍可用）时，该连接器的读写工具
 * 名直接进本轮 allowlist，deferred 预载层照白名单把 schema 送上轮；模型调写工具
 * 后照旧走 C1 连接器外部写确认（聊天内审批卡），权限与审批链路一字不动。
 * 判据与 deferredToolPreload 共用 connectors/nativeConnectorIntent.ts 的单一真源；
 * 不命中意图的轮次零新增（无 schema 膨胀，前缀缓存不受影响）。
 */
/**
 * `allowedConnectorIds`：本轮手选/专家声明的连接器范围（web 工作台 toolScope、桌面
 * envelope options.toolScope 经 withWorkbenchTurnSystemContext 并出来的那份）。非空 =
 * 显式收窄：范围外的连接器即使意图命中也不进面——与 run policy 的 toolScope 补充
 * 豁免、deferred 预载的收窄判据三方同判（rework r1：漏传会让白名单放行范围外
 * 连接器写，预载却按收窄不送 schema，两个判决互相矛盾）。无手选时传 undefined。
 */
export function getTextForegroundToolNamesForPrompt(
  prompt: string,
  allowedConnectorIds?: readonly string[],
): string[] {
  const base = getTextForegroundToolNames();
  const extras: string[] = [];
  const features = detectTaskFeatures(prompt);
  if (features.isOneTurnFileDeliverable) {
    if (OFFICE_DOC_DELIVERABLE_RE.test(prompt)) extras.push('docx_generate');
    if (OFFICE_SHEET_DELIVERABLE_RE.test(prompt)) extras.push('excel_generate', 'DocEdit');
  }
  if (isMorningBriefSaveDraftReply(prompt)) extras.push('mail_draft');
  // 无意图命中时零副作用（不触 configService/registry）。
  extras.push(...getNativeConnectorToolNamesForIntent({ userText: prompt, allowedConnectorIds }));
  if (extras.length === 0) return base;
  // 存草稿轮 mail_draft 已在 extras 里，连接器扩展会再次带回同名——去重保序。
  return Array.from(new Set([...base, ...extras]));
}

export function withSessionCommandCenterBrain(
  options: AppServiceRunOptions | undefined,
  prompt?: string,
): AppServiceRunOptions {
  const text = prompt ?? '';
  const turnSystemContext = [
    ...(options?.turnSystemContext ?? []),
    ...getSessionCommandCenterBrainContextForPrompt(text),
  ];
  return {
    ...(options ?? {}),
    mode: options?.mode ?? 'normal',
    maxIterations: Math.min(
      typeof options?.maxIterations === 'number'
        ? options.maxIterations
        : SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS,
      SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS,
    ),
    allowedToolNames: getTextForegroundToolNamesForPrompt(text, options?.toolScope?.allowedConnectorIds),
    foregroundToolFace: true,
    turnSystemContext,
  };
}
