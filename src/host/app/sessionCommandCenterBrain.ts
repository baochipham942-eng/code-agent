import type { AppServiceRunOptions } from '../../shared/contract/appService';
import {
  SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS,
  SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES,
} from '../../shared/constants/sessionCommandCenter';

export const SESSION_COMMAND_CENTER_BRAIN_CONTEXT = [
  '<session_command_center>',
  '你是这条文字会话的前台 brain。前台要保持快速流式回复，耗时执行一律交给后台任务槽。',
  '分诊规则：',
  '1. 闲聊、解释、基于现有上下文即可回答的问题，直接回答，不调用工具。',
  '2. 需要读写文件、运行命令、联网查证、多步骤执行或等待审批的工作，调用 spawn_task；一次要求多件独立工作时逐件调用。',
  '3. 用户补充或修正某件正在做的工作，调用 steer_task；要求停止时调用 cancel_task；追问进度时先调用 task_status。',
  '4. 目标任务不唯一、并发槽已满或取消代价较高时，调用 AskUserQuestion 让用户按短名选择，不替用户猜。',
  '派活纪律：short_name 用 2-4 个字符，中文或英文均可；同一目标沿用 lane_key；同一 turn 的重试沿用 submission_key。',
  'spawn_task 返回 accepted 只表示后台已接单。你可以告诉用户已经开始或排队，但不得声称完成；完成、失败和取消只以后续任务终态回流为准。',
  '绝不描述你没有真做过的事。没有调用 spawn_task，就不许说正在创建、正在修改或已经执行。',
  '不要用“好的收到”空承接。派活后用一句话说明哪件短名已开始、排队或需要选择，然后结束当前 turn。',
  '</session_command_center>',
].join('\n');

export function withSessionCommandCenterBrain(
  options: AppServiceRunOptions | undefined,
): AppServiceRunOptions {
  return {
    ...(options ?? {}),
    mode: options?.mode ?? 'normal',
    maxIterations: Math.min(
      typeof options?.maxIterations === 'number'
        ? options.maxIterations
        : SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS,
      SESSION_COMMAND_CENTER_BRAIN_MAX_ITERATIONS,
    ),
    allowedToolNames: [...SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES],
    turnSystemContext: [
      ...(options?.turnSystemContext ?? []),
      SESSION_COMMAND_CENTER_BRAIN_CONTEXT,
    ],
  };
}
