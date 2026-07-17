// ============================================================================
// Lab 域 i18n 迁移棘轮
// 模式同 chatI18nRatchet.test.ts，但 lab 域比 chat/sidebar 多一类文件：教学实验室会展示
// "AI 训练"过程，代码里内嵌了训练语料/演示数据本身（样例对话、tokenizer 词表、SFT/DPO/RM
// 偏好样本、莎士比亚语料等）——这些中文是功能的一部分，翻译会改变演示行为语义，故意不迁移。
//
// 因此本棘轮分两类：
// - ZERO_TOLERANCE：纯 UI 文案文件，中文字面量必须为 0（未迁移干净会被抓）
// - CONTENT_ALLOWLIST：登记了"训练数据/演示内容"精确命中数的文件（同 settingsToggleConvergence
//   的 ALLOWLIST 模式）——命中数只能等于登记值，多了说明有新 UI 文案没迁，少了说明清单腐烂
//   （内容被删或重新措辞）需要同步更新登记值，都不允许静默通过。
// 覆盖率检查确保 lab/ 目录下任何 .ts/.tsx 文件都逃不出这两张清单（防新文件绕过棘轮）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RENDERER_DIR = path.resolve(__dirname, '../../../src/renderer');
const COMPONENTS_DIR = path.join(RENDERER_DIR, 'components');
const LAB_DIR = path.join(COMPONENTS_DIR, 'features/lab');

/** 纯 UI 文案文件，已完全迁移，中文字面量必须为 0（注释除外）。只增不减。 */
const ZERO_TOLERANCE: string[] = [
  'features/lab/LabPage.tsx',
  'features/lab/alignment/AlignmentLab.tsx',
  'features/lab/alignment/stages/PPOStage.tsx',
  'features/lab/alignment/stages/index.ts',
  'features/lab/gpt1/GPT1Lab.tsx',
  'features/lab/gpt1/RealModePanel.tsx',
  'features/lab/gpt1/index.ts',
  'features/lab/gpt1/stages/ModelArchitecture.tsx',
  'features/lab/gpt1/stages/TrainingLoop.tsx',
  'features/lab/gpt1/stages/index.ts',
  'features/lab/index.ts',
  'features/lab/llamafactory/LLaMAFactoryLab.tsx',
  'features/lab/llamafactory/stages/IntroStage.tsx',
  'features/lab/llamafactory/stages/MethodStage.tsx',
  'features/lab/llamafactory/stages/PracticeStage.tsx',
  'features/lab/nanogpt/NanoGPTLab.tsx',
  'features/lab/nanogpt/RealModePanel.tsx',
  'features/lab/nanogpt/index.ts',
  'features/lab/nanogpt/stages/ModelArchitecture.tsx',
  'features/lab/nanogpt/stages/Pretraining.tsx',
];

/**
 * 训练数据/演示内容文件：登记精确的中文字面量命中数（非注释）。
 * 每一项都是"喂给模型/算法当输入数据"的内容（样例对话、tokenizer 词表、SFT/DPO/RM 偏好样本、
 * 莎士比亚语料等），不是解释给用户看的 UI 文案，故意保留原文。
 */
const CONTENT_ALLOWLIST: Record<string, number> = {
  'features/lab/alignment/stages/AlignmentComparison.tsx': 24, // 三阶段模型输出对比样本（base/sft/rlhf）
  'features/lab/alignment/stages/RewardModelStage.tsx': 18, // RM 偏好对比样本（responseA/B + 标签）
  'features/lab/alignment/stages/SFTStage.tsx': 17, // SFT 指令-回答训练样本 + before/after 对比
  'features/lab/gpt1/stages/DataPreparation.tsx': 8, // 样例对话训练语料（sampleDialogues）
  'features/lab/gpt1/stages/InferenceTest.tsx': 11, // 模拟已训练模型的候选回复查找表
  'features/lab/gpt1/stages/TokenizerStage.tsx': 7, // mockVocab 词表 + 绑定的默认输入文本
  'features/lab/llamafactory/stages/PreferenceStage.tsx': 6, // DPO 偏好样本（chosen/rejected）
  'features/lab/llamafactory/stages/RLHFStage.tsx': 1, // RFT 演示题目（question）
  'features/lab/llamafactory/stages/SFTStage.tsx': 9, // Alpaca/ShareGPT/OpenAI 数据格式 JSON 样本
  'features/lab/nanogpt/stages/DataPreparation.tsx': 15, // 莎士比亚语料预览 + 分词映射样本
  'features/lab/nanogpt/stages/Finetuning.tsx': 8, // 微调前后生成文本对比样本
  'features/lab/nanogpt/stages/Inference.tsx': 31, // 候选 token 概率分布 + 生成文本样例
  'features/lab/nanogpt/stages/Tokenizer.tsx': 10, // 示例文本 + 字符/子词分词映射
};

const HAN_RE = /[一-鿿]/;
// 反逃逸：一-鿿 区间的 unicode 转义写法同样算中文字面量（settings 批7实测 '打开' 绕闸）
const HAN_ESCAPE_RE = /\\u(?:4[e-f]|[5-8][0-9a-f]|9[0-9a-f])[0-9a-f]{2}/i;

/** 去掉行注释、块注释、JSX 注释后再扫描，避免中文注释误报 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'"\\])\/\/[^'"\n]*$/gm, '$1');
}

function findHanLines(rel: string): { no: number; line: string }[] {
  const abs = path.join(COMPONENTS_DIR, rel);
  const source = fs.readFileSync(abs, 'utf-8');
  const code = stripComments(source);
  return code
    .split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter(({ line }) => HAN_RE.test(line) || HAN_ESCAPE_RE.test(line));
}

describe('Lab 域 i18n 棘轮', () => {
  it('ZERO_TOLERANCE / CONTENT_ALLOWLIST 清单内的文件都存在', () => {
    for (const rel of [...ZERO_TOLERANCE, ...Object.keys(CONTENT_ALLOWLIST)]) {
      const abs = path.join(COMPONENTS_DIR, rel);
      expect(fs.existsSync(abs), `${rel} 不存在（改名/删除需同步清单）`).toBe(true);
    }
  });

  for (const rel of ZERO_TOLERANCE) {
    it(`已迁文件无中文字面量: ${rel}`, () => {
      const offending = findHanLines(rel);
      expect(
        offending.map(({ no, line }) => `L${no}: ${line.slice(0, 80)}`),
        `${rel} 还有 ${offending.length} 处中文字面量`,
      ).toEqual([]);
    });
  }

  for (const [rel, expectedCount] of Object.entries(CONTENT_ALLOWLIST)) {
    it(`内容数据文件命中数与登记一致: ${rel}`, () => {
      const offending = findHanLines(rel);
      expect(
        offending.length,
        `${rel} 实际命中 ${offending.length} 处，登记值 ${expectedCount}——` +
          `多了说明有新 UI 文案没迁移，少了说明内容被改动，两种情况都需要人工复核后更新登记值：\n` +
          offending.map(({ no, line }) => `  L${no}: ${line.slice(0, 80)}`).join('\n'),
      ).toBe(expectedCount);
    });
  }

  it('lab/ 目录下所有 .ts/.tsx 文件都被 ZERO_TOLERANCE 或 CONTENT_ALLOWLIST 覆盖（防新文件绕过棘轮）', () => {
    const registered = new Set([...ZERO_TOLERANCE, ...Object.keys(CONTENT_ALLOWLIST)]);
    const uncovered: string[] = [];

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const rel = path.relative(COMPONENTS_DIR, abs).split(path.sep).join('/');
          if (!registered.has(rel)) {
            uncovered.push(rel);
          }
        }
      }
    }
    walk(LAB_DIR);

    expect(uncovered, '新增/未登记的 lab 文件，需要加进 ZERO_TOLERANCE 或 CONTENT_ALLOWLIST').toEqual([]);
  });
});
