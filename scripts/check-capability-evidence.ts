#!/usr/bin/env npx tsx
// =============================================================================
// check-capability-evidence.ts — 能力"运行证据硬门"
//
// 背景（docs/audits/2026-06-12-*-codex-sessions-adversarial-audit.md）：
//   验收只看"测试绿 + typecheck 过"时，出现过三类"完成未兑现"：
//     1) 零交付   —— Distill 自称完成，仓库无任何文件/commit 痕迹
//     2) 模板冒充 —— Checkpoint 规格要求 LLM 子代理写 11 段，实际是本地模板填充
//     3) 无证据   —— 自称跑过，但没有可复跑的验收/集成入口
//
// 本门把这三类失败码化为机械可查的不变量：声称"做扎实"的能力，必须
//   (a) 交付物存在且行数达标（防零交付/stub）
//   (b) 交付物含"真实现"标记（防模板/占位冒充实现）
//   (c) 存在可复跑的运行证据入口（acceptance/live/integration 测试）
//
// 任一不满足即 FAIL 非零退出，可挂 CI / 发版前只读门。
// 新增能力时往 CAPABILITIES 加一条；规格回退（文件被掏空/marker 消失/证据被删）
// 会立刻被本门拦下，而不是等下一次审计才发现。
// =============================================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface DeliverableSpec {
  /** 仓库相对路径 */
  path: string;
  /** 最少行数：低于此视为零交付 / stub */
  minLines: number;
  /** 交付物中必须出现的"真实现"标记（全部命中才算真实现，防模板冒充） */
  markers?: string[];
}

export interface CapabilityEvidence {
  name: string;
  /** 核心交付物 */
  deliverables: DeliverableSpec[];
  /** 可复跑的运行证据入口（测试/冒烟脚本路径） */
  evidence: string[];
}

// 审计点名的四个能力 —— 当前均已落地，本门锁住它们不被悄悄回退。
export const CAPABILITIES: CapabilityEvidence[] = [
  {
    name: 'checkpoint-writer',
    deliverables: [
      {
        path: 'src/host/agent/checkpointWriterAgent.ts',
        minLines: 120,
        // 规格要求真 LLM 子代理写入，而非本地模板填充：必须真的发起推理
        markers: ['ModelRouter', '.inference('],
      },
    ],
    evidence: [
      'tests/unit/agent/checkpointWriterAgent.test.ts',
      'tests/manual/checkpointWriterLive.ts',
    ],
  },
  {
    name: 'max-mode',
    deliverables: [{ path: 'src/host/agent/runtime/maxMode.ts', minLines: 120 }],
    evidence: ['tests/unit/agent/runtime/maxMode.test.ts'],
  },
  {
    name: 'distill',
    deliverables: [{ path: 'src/host/agent/runtime/learningPipeline.ts', minLines: 80 }],
    evidence: ['tests/integration/distillRealRun.test.ts'],
  },
  {
    name: 'dream',
    deliverables: [
      {
        path: 'src/host/services/memory/dreamMemoryService.ts',
        minLines: 200,
        // 防幻觉门的核心信号：置信度阈值 + 同源 sessionId 约束
        markers: ['confidence', 'sessionId'],
      },
    ],
    evidence: ['tests/unit/services/memory/dreamMemoryService.test.ts'],
  },
];

/** 文件读取抽象：便于测试注入。返回 null 表示文件不存在。 */
export type FileProbe = (relPath: string) => { lineCount: number; content: string } | null;

/**
 * 纯逻辑：对照 manifest 评估证据，返回失败原因列表（空数组 = 全部通过）。
 * 与 fs / process 解耦，可单测。
 */
export function evaluateCapabilityEvidence(
  capabilities: CapabilityEvidence[],
  probe: FileProbe,
): string[] {
  const failures: string[] = [];

  for (const cap of capabilities) {
    for (const d of cap.deliverables) {
      const file = probe(d.path);
      if (!file) {
        failures.push(`[${cap.name}] 零交付：交付物缺失 ${d.path}`);
        continue;
      }
      if (file.lineCount < d.minLines) {
        failures.push(
          `[${cap.name}] 疑似 stub：${d.path} 仅 ${file.lineCount} 行 < 要求 ${d.minLines} 行`,
        );
      }
      for (const marker of d.markers ?? []) {
        if (!file.content.includes(marker)) {
          failures.push(
            `[${cap.name}] 疑似模板冒充：${d.path} 缺少真实现标记 "${marker}"`,
          );
        }
      }
    }
    for (const ev of cap.evidence) {
      if (!probe(ev)) {
        failures.push(`[${cap.name}] 无运行证据：缺少可复跑入口 ${ev}`);
      }
    }
  }

  return failures;
}

function makeRealProbe(repoRoot: string): FileProbe {
  return (relPath: string) => {
    const abs = path.join(repoRoot, relPath);
    if (!fs.existsSync(abs)) return null;
    const content = fs.readFileSync(abs, 'utf8');
    return { lineCount: content.split('\n').length, content };
  };
}

function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const failures = evaluateCapabilityEvidence(CAPABILITIES, makeRealProbe(repoRoot));

  if (failures.length === 0) {
    console.log(`✓ 能力证据门通过：${CAPABILITIES.length} 个能力的交付物/标记/运行证据齐备`);
    return;
  }

  console.error('✗ 能力证据门 FAIL — 以下能力未兑现"做扎实"：\n');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    `\n共 ${failures.length} 处。修复后重跑；新增能力请在 CAPABILITIES 登记交付物与运行证据。`,
  );
  process.exit(1);
}

// 仅在直接执行时跑 main（被测试 import 时不触发）
if (process.argv[1] && process.argv[1].includes('check-capability-evidence')) {
  main();
}
