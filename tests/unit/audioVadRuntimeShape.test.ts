// ONNX 运行时的形状判据必须认 class 形态的 InferenceSession。
//
// 🔴 2026-08-14 真机腿抓到的存量 bug：判据用 `isRecord`（只认 typeof 'object'），
// 而 onnxruntime-node 真实导出的 `InferenceSession` 是 **class**（typeof 'function'），
// 于是 require 成功的模块被判成「不是 ORT 运行时」，返回 null。
// 影响面不止声纹——桌面 VAD 走同一条装载链。
//
// 这里用**真实模块形状**（class + 静态 create + Tensor 构造器）当夹具，
// 不用手搓的 plain object：假 mock 正是当初没抓住这个 bug 的原因。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrtRuntimeForModule } from '../../src/host/services/desktop/audioVadRuntime';

/** 造一个与 onnxruntime-node 同形的 CJS 包：InferenceSession 是 class。 */
function writeFakeOrtPackage(root: string, shape: 'class' | 'plain-object'): void {
  const pkgDir = path.join(root, 'node_modules', 'onnxruntime-node');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: 'onnxruntime-node', version: '0.0.0-test', main: 'index.js',
  }));
  const body = shape === 'class'
    ? `class InferenceSession { static async create() { return { run: async () => ({}) }; } }
       function Tensor() {}
       module.exports = { InferenceSession, Tensor };`
    : `module.exports = { InferenceSession: { create: async () => ({}) }, Tensor: function () {} };`;
  fs.writeFileSync(path.join(pkgDir, 'index.js'), body);
}

describe('loadOrtRuntimeForModule 的运行时形状判据', () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ort-shape-'));
    prevCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('InferenceSession 是 class（onnxruntime-node 的真实形态）→ 认得出来', () => {
    writeFakeOrtPackage(dir, 'class');
    const { ort, attempts } = loadOrtRuntimeForModule(path.join(dir, 'a', 'b'), dir);
    expect(ort, `未认出 class 形态；attempts=${JSON.stringify(attempts)}`).not.toBeNull();
    expect(typeof ort?.InferenceSession.create).toBe('function');
  });

  it('InferenceSession 是普通对象 → 同样认得出来（不为修 class 而破坏原形态）', () => {
    writeFakeOrtPackage(dir, 'plain-object');
    expect(loadOrtRuntimeForModule(path.join(dir, 'a', 'b'), dir).ort).not.toBeNull();
  });

  // 不在这里验「全部候选失败时的 attempts 留痕」：本仓 node_modules 里真有
  // onnxruntime-node，解析链第一个候选就命中，attempts 恒为空——这个前提在
  // repo 环境不可能成立，为它造隔离 mock 就是拿假形状换一条假绿。
  // 留痕能力在 voiceSpeakerEmbedding.test.ts 里验（warn 带出 attempts）。
});
