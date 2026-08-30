import path from 'node:path';

const LAYER_BY_PREFIX: Record<string, string> = {
  '01': '工具与任务基础',
  '02': '工具与任务基础',
  '03': '对话与多轮',
  '04': '工具与任务基础',
  '05': '代码任务',
  '06': '安全红线',
  '07': '工具与任务基础',
  '08': '产物任务',
  '09': '代码任务',
  '10': '代码任务',
  '11': '联网与视觉',
  '12': '对话与多轮',
  '13': '产物任务',
  '14': '工具与任务基础',
  '15': '对话与多轮',
  '16': '联网与视觉',
  '17': '多智能体与提示词',
  '18': '产物任务',
  '19': '代码任务',
  '20': '多智能体与提示词',
};

const LAYER_BY_DIRECTORY: Record<string, string> = {
  'artifact-runnable': '专项：产物可运行',
  'goal-contract': '专项：目标契约',
  'user-simulator': '专项：用户模拟器',
  drafts: '草稿',
};

/** Resolve the stable product layer shared by CASELIST and compare reports. */
export function resolveCaseLayer(file: string, relativeDir = ''): string {
  const topDirectory = relativeDir.split('/')[0];
  if (topDirectory && LAYER_BY_DIRECTORY[topDirectory]) return LAYER_BY_DIRECTORY[topDirectory];
  return LAYER_BY_PREFIX[path.basename(file).slice(0, 2)] ?? '其他题目';
}
