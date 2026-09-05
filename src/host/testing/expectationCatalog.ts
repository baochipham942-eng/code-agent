import type { ExpectationType } from './types';

const EXPECTATION_SUMMARIES = {
  file_exists: '文件存在',
  file_not_exists: '文件不存在',
  content_contains: '文件内容包含指定文本',
  content_not_contains: '文件内容不含指定文本',
  code_compiles: '代码可以编译',
  test_passes: '测试命令通过',
  output_matches: '输出符合表达式',
  command_succeeds: '命令成功退出',
  response_contains: '回复包含指定文本',
  response_not_contains: '回复不含指定文本',
  tool_called: '调用了指定工具',
  tool_output_contains: '工具输出包含指定文本',
  no_crash: '执行过程没有崩溃',
  error_handled: '错误得到处理',
  max_turns: '轮次数不超过上限',
  min_tool_calls: '工具调用达到下限',
  max_tool_calls: '工具调用不超过上限',
  custom_script: '自定义脚本通过',
  html_renders: 'HTML 可以渲染',
  game_smoke: '游戏冒烟检查通过',
  pptx_opens: '演示文稿可以打开',
  sim_stop_respected: '拒绝后停止执行',
  sim_no_write_before_rule: '确认前没有写入',
  no_forbidden_tool_call: '没有发出题目禁止的工具调用、命令或工具输入',
  approval_requested: '弹出了审批请求（先确认再执行）',
  approval_not_requested: '没有弹出多余的审批请求',
  goal_status: '目标达到预期终态',
  goal_evidence_gate: '目标证据闸符合预期',
  no_stall_before_artifact: '产物动作前没有拖延',
  memory_recalled: '该被想起来的记忆真的被注进了这一轮',
  memory_written: '跑完之后记忆目录里躺着该躺的内容',
} as const satisfies Record<ExpectationType, string>;

type MissingExpectationType = Exclude<ExpectationType, keyof typeof EXPECTATION_SUMMARIES>;
type UnknownExpectationType = Exclude<keyof typeof EXPECTATION_SUMMARIES, ExpectationType>;
const _catalogHasEveryType: MissingExpectationType extends never ? true : never = true;
const _catalogHasOnlyKnownTypes: UnknownExpectationType extends never ? true : never = true;
void _catalogHasEveryType;
void _catalogHasOnlyKnownTypes;

export const EXPECTATION_TYPE_CATALOG: ReadonlyArray<{ type: ExpectationType; summary: string }> =
  Object.keys(EXPECTATION_SUMMARIES).map((type) => ({
    type: type as ExpectationType,
    summary: EXPECTATION_SUMMARIES[type as ExpectationType],
  }));
