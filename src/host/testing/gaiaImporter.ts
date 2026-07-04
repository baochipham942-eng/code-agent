// ============================================================================
// GAIA importer — validation metadata 行 → TestRunner suite（含附件题）
// ============================================================================
// 一期这段逻辑住在 scripts/gaia-import.ts（tsconfig 不含 scripts/，tsc 抓不到
// 运行时错），二期上移到 src 进 typecheck 范围；scripts 侧只留 CLI 薄壳。
//
// 附件题（38/165）：case 带 files 字段声明本地附件（gated 数据不进公开 git，
// 落 ~/.code-agent/gaia/files/），testRunner 跑前注入沙箱工作目录；prompt 额外
// 告知模型附件文件名与位置——附件缺失由 testRunner fail loud，不静默硬答。

import path from 'path';

// GAIA 官方论文的作答约定：判分是 quasi-exact match，模型必须按此格式收尾，
// 否则答案对了也提不出来。嵌在每题 prompt 前部（不动 system prompt）。
const GAIA_ANSWER_CONVENTION = [
  'You are a general AI assistant. I will ask you a question. Report your thoughts, and finish your answer with the following template: FINAL ANSWER: [YOUR FINAL ANSWER].',
  'YOUR FINAL ANSWER should be a number OR as few words as possible OR a comma separated list of numbers and/or strings.',
  "If you are asked for a number, don't use comma to write your number neither use units such as $ or percent sign unless specified otherwise.",
  "If you are asked for a string, don't use articles, neither abbreviations (e.g. for cities), and write the digits in plain text unless specified otherwise.",
  'If you are asked for a comma separated list, apply the above rules depending of whether the element to be put in the list is a number or a string.',
].join(' ');

/** 单题超时：GAIA 多为联网多步任务，比本地 case 宽松得多 */
const GAIA_CASE_TIMEOUT_MS = 600_000;

export interface GaiaRow {
  task_id: string;
  Question: string;
  Level: number | string;
  'Final answer': string;
  file_name?: string;
}

export interface GaiaSuiteOptions {
  /** 附件所在本地目录（file_name 拼在其下） */
  filesDir: string;
  /** 只转换指定 Level（字符串比对，'1'/'2'/'3'） */
  level?: string;
  /** 截断前 N 题 */
  limit?: number;
}

interface GaiaCase {
  id: string;
  type: 'task';
  description: string;
  prompt: string;
  timeout: number;
  tags: string[];
  expect: { final_answer: string };
  files?: Array<{ source: string; dest?: string }>;
}

export interface GaiaSuite {
  name: string;
  description: string;
  cases: GaiaCase[];
}

export function buildGaiaSuite(rows: GaiaRow[], options: GaiaSuiteOptions): GaiaSuite {
  const { filesDir, level, limit } = options;

  let selected = rows;
  if (level) selected = selected.filter((r) => String(r.Level) === level);
  if (limit) selected = selected.slice(0, limit);

  const cases = selected.map((row): GaiaCase => {
    const attachmentNote = row.file_name
      ? `\n\nThe question references a file. It has been placed in your current working directory as: ${row.file_name}`
      : '';
    return {
      id: `gaia-l${row.Level}-${row.task_id.slice(0, 8)}`,
      type: 'task',
      description: `GAIA validation L${row.Level} ${row.task_id}`,
      prompt: `${GAIA_ANSWER_CONVENTION}${attachmentNote}\n\nQuestion: ${row.Question}`,
      timeout: GAIA_CASE_TIMEOUT_MS,
      tags: ['gaia', `gaia-l${row.Level}`, 'external-benchmark'],
      expect: {
        final_answer: row['Final answer'],
      },
      ...(row.file_name ? { files: [{ source: path.join(filesDir, row.file_name) }] } : {}),
    };
  });

  return {
    name: `gaia-validation${level ? `-l${level}` : ''}`,
    description: 'GAIA validation（本地数据，不进公开 git）— 外部锚点主基准',
    cases,
  };
}
