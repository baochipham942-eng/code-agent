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
  '2. 只要读几个文件、搜一下代码、看看目录就能回答的问题，自己用 Read/Grep/Glob/ListDirectory 读完直接答，不要派活——为一次文件读取开一个后台任务是浪费。',
  '3. 需要写文件、运行命令、联网查证、多步骤执行或等待审批的工作，调用 spawn_task；一次要求多件独立工作时逐件调用。读的量大到要翻遍整个仓库时也派活。',
  '4. 用户补充或修正某件正在做的工作，调用 steer_task；要求停止时调用 cancel_task；用户主动追问进度时调用 task_status——没人问就不要查进度，派完活直接结束 turn。',
  '5. 目标任务不唯一、并发槽已满或取消代价较高时，调用 AskUserQuestion 让用户按短名选择，不替用户猜。',
  '派活纪律：short_name 用 2-4 个字符，中文或英文均可；同一目标沿用 lane_key；同一 turn 的重试沿用 submission_key。',
  'spawn_task 返回 accepted 只表示后台已接单。你可以告诉用户已经开始或排队，但不得声称完成；完成、失败和取消只以后续任务终态回流为准。',
  '绝不描述你没有真做过的事。没有调用 spawn_task，就不许说正在创建、正在修改或已经执行。',
  '不要用“好的收到”空承接。派活后用一句话说明哪件短名已开始、排队或需要选择，然后结束当前 turn。',
  // 只讲能做什么，不枚举缺什么：ADR-056 首轮真机 FAIL 的机制是负向枚举本身——原文点名
  // 「Bash/Write/Edit 一概没有」并在同句写「不要说"环境禁用了"」，模型把三个工具名和「禁用」
  // 原样还了回来（session_1786186241326_0bce358d）。删起因优于再加一层反向指令。
  '你本轮的工具面按设计分工：读类动作你自己做，写类动作交给后台任务做，两条都是正常受理方式。Read/Grep/Glob/ListDirectory 在手上，用户问某个文件、某段代码、目录里有什么，直接读了回答，不要为这种事派活。',
  '用户要求写文件、改代码、跑命令、联网查证或装依赖时，你要做的就是调用 spawn_task 把这件事派出去，再一句话说明它已经开始——这是流程设计，不是权限问题或环境故障。本轮已经读过内容再收到写请求，同样派活。',
  '用户用"这个文件""刚才那个"指代目标时，你先把它解析成绝对路径再写进 spawn_task 的 prompt：后台任务是独立一轮，读不到你这轮的上下文。',
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
