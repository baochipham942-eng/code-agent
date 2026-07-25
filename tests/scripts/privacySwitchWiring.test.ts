// ============================================================================
// 隐私开关 → 执行点接线门（2026-07-25 费曼审计 P2-5）
//
// 同一病三次复发（预算硬顶 #699 / 隐私开关 P0-1 / 记忆整理 P1-3）：开关存在、
// 执行点不读它。本门把「遥测通道的 opt-out 出口必须被 privacyGate 接线」钉死：
//
// - 不按名字枚举通道：扫描通道目录里所有 `set*Enabled` 出口（保留清单思路，
//   新增通道带出口而没接线 → 默认拦下报红）。
// - 扫到 0 个出口 → 报红（锚点失效不假绿）。
// - 已知盲区（fail-loud 声明）：一个通道如果连 set*Enabled 出口都没有，本门
//   看不见它——那属于「通道必须有 opt-out 出口」的建模缺口，靠 code review
//   与隐私验收矩阵（关开关抓真实网络请求为零）兜底。
// ============================================================================
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

/** 目录内所有 .ts 文件（非递归；通道模块都是平铺的） */
function listTsFiles(relDir: string): string[] {
  return fs.readdirSync(path.join(repoRoot, relDir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => `${relDir}/${f}`);
}

interface OptOutExit {
  file: string;
  /** 独立导出函数名，如 setPostHogEnabled；类方法为 'setEnabled' */
  name: string;
  /** 类方法出口所在服务的单例访问器（同文件 export function getXxx） */
  accessor?: string;
}

function collectOptOutExits(files: string[]): OptOutExit[] {
  const exits: OptOutExit[] = [];
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/export function (set\w*Enabled)\(/g)) {
      exits.push({ file, name: m[1] });
    }
    // 类方法形态：setEnabled(...) 出现在 class 内，接线方须经同文件单例访问器调用
    if (/^\s+setEnabled\(/m.test(src)) {
      const accessor = /export function (get\w+)\(/.exec(src)?.[1];
      exits.push({ file, name: 'setEnabled', accessor });
    }
  }
  return exits;
}

describe('privacy switch wiring gate', () => {
  it('wires every node-side telemetry opt-out exit into privacyGate', () => {
    const files = [
      ...listTsFiles('src/host/observability').filter((f) => !f.endsWith('privacyGate.ts')),
      'src/host/telemetry/telemetryUploaderService.ts',
      'src/host/services/infra/langfuseService.ts',
    ];
    const exits = collectOptOutExits(files);
    expect(exits.length, 'node 侧扫到 0 个 opt-out 出口——扫描锚点失效，先修门').toBeGreaterThan(0);

    const gate = read('src/host/observability/privacyGate.ts');
    for (const exit of exits) {
      if (exit.accessor) {
        expect(
          gate.includes(`${exit.accessor}().setEnabled`),
          `${exit.file} 的 ${exit.accessor}().setEnabled 未在 privacyGate.applyPrivacyFlags 接线`,
        ).toBe(true);
      } else {
        expect(
          gate.includes(exit.name),
          `${exit.file} 的 ${exit.name} 未在 privacyGate.applyPrivacyFlags 接线`,
        ).toBe(true);
      }
    }
  });

  it('wires every renderer-side telemetry opt-out exit into renderer privacyFlags', () => {
    const files = listTsFiles('src/renderer/observability').filter((f) => !f.endsWith('privacyFlags.ts'));
    const exits = collectOptOutExits(files);
    expect(exits.length, 'renderer 侧扫到 0 个 opt-out 出口——扫描锚点失效，先修门').toBeGreaterThan(0);

    const gate = read('src/renderer/observability/privacyFlags.ts');
    for (const exit of exits) {
      expect(
        gate.includes(exit.name),
        `${exit.file} 的 ${exit.name} 未在 renderer privacyFlags.applyRendererPrivacyFlags 接线`,
      ).toBe(true);
    }
  });

  it('keeps the boot wiring alive: webServer installs the gate, App applies renderer flags', () => {
    expect(
      read('src/web/webServer.ts').includes('installPrivacyGate'),
      'webServer 启动路径没有安装 privacyGate——开关又变成没人读的摆设',
    ).toBe(true);
    expect(
      read('src/renderer/App.tsx').includes('applyRendererPrivacyFlags'),
      'renderer 启动路径没有应用隐私开关',
    ).toBe(true);
  });
});
