// 前置缺失必须**出声**（2026-08-14 真机腿教训）：
// 首轮真机跑完，声纹链路一条日志都没有——打包态没有 onnxruntime-node（按需下载资产，
// 全新数据目录从没下过），createSpeakerEmbedder 静默返回 null，通话照常跑，
// 用户以为声纹在工作而日志里查不到任何痕迹。
// fail-open 说的是「行为不改变」，不是「失败不留痕」。这条钉住后者。
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));
// 运行时装载：默认造成「缺失」，个别用例再改成可用
const loadOrt = vi.hoisted(() => vi.fn<() => unknown>(() => null));
vi.mock('../../src/host/services/desktop/audioVadRuntime', () => ({
  loadOrtRuntimeForModule: () => loadOrt(),
}));
vi.mock('../../src/host/runtime/runtimeAssetResolver', () => ({
  resolveExistingResource: () => null,
}));

import { createSpeakerEmbedder, getVoiceprintRuntimeStatus } from '../../src/host/services/voice/speakerEmbedding';
import { VOICEPRINT_MODEL_DIR, VOICEPRINT_MODEL_FILE } from '../../src/shared/constants/voice';

describe('speakerEmbedding 前置缺失的可观测性', () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    loadOrt.mockReturnValue(null);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceprint-embed-'));
    prev = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dir;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function installModel(): void {
    const modelDir = path.join(dir, VOICEPRINT_MODEL_DIR);
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, VOICEPRINT_MODEL_FILE), 'fake-onnx');
  }

  it('模型缺失 → 返回 null 且 warn 出「模型未下载」，不是静默', async () => {
    expect(await createSpeakerEmbedder()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, detail] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('prerequisite missing');
    expect(detail.modelReady).toBe(false);
    expect(String(detail.hint)).toContain('下载声纹组件');
  });

  it('模型在但 ONNX 运行时缺失 → 返回 null 且 warn 指明是运行时（真机首轮的形态）', async () => {
    installModel();
    expect(await createSpeakerEmbedder()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const [, detail] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(detail.modelReady).toBe(true);
    expect(detail.runtimeReady).toBe(false);
    expect(String(detail.hint)).toContain('运行时');
  });

  it('两样齐备 → 不再报缺失（正例，证明上面的 warn 不是恒发）', async () => {
    installModel();
    loadOrt.mockReturnValue({
      InferenceSession: { create: () => Promise.resolve({ run: () => Promise.resolve({}) }) },
      Tensor: function Tensor() { /* stub */ },
    });
    await createSpeakerEmbedder();
    const prerequisiteWarns = warn.mock.calls.filter(([m]) => String(m).includes('prerequisite missing'));
    expect(prerequisiteWarns).toHaveLength(0);
  });

  it('状态查询如实分别报告两个前置（设置页据此决定显示下载还是不可用）', () => {
    expect(getVoiceprintRuntimeStatus()).toEqual({ modelReady: false, runtimeReady: false });
    installModel();
    expect(getVoiceprintRuntimeStatus()).toEqual({ modelReady: true, runtimeReady: false });
  });
});
