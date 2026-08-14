// 通话录音（N-L7-REC）：WAV 收尾正确性 + 三重上限**逐条**变异验证。
// 三条上限必须分别验——只验一条就说「上限生效」是工单 §6 判据 3 明确禁止的。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVoiceCallRecorder, isVoiceCallRecordingEnabled } from '../../src/host/services/voice/voiceCallRecorder';
import {
  listVoiceRecordings,
  readVoiceRecordingCleanupLedger,
  runVoiceRecordingRetention,
} from '../../src/host/services/voice/voiceRecordingRetention';

const DAY_MS = 24 * 60 * 60 * 1000;
const WAV_HEADER_BYTES = 44;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-rec-'));
}

/** 造一通「已存在」的录音：目录 + 指定字节数 + 指定 mtime（写完文件再设 mtime，否则被写入刷新）。 */
function makeExistingCall(root: string, name: string, bytes: number, mtimeMs: number): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'upstream.wav'), Buffer.alloc(bytes));
  fs.utimesSync(dir, new Date(mtimeMs), new Date(mtimeMs));
}

// 判据 1 的结构面：默认态绝不录音。真机负例（跑一通 → 目录零音频文件）在验收报告里。
describe('isVoiceCallRecordingEnabled — 默认关', () => {
  it('只有字面 true 才开；undefined / 缺配置 / 非 true 一律关', () => {
    expect(isVoiceCallRecordingEnabled(undefined)).toBe(false);
    expect(isVoiceCallRecordingEnabled({})).toBe(false);
    expect(isVoiceCallRecordingEnabled({ recordCalls: false })).toBe(false);
    // 旁边的声纹开关是 `!== false`（默认开），形状相反；照抄一次就会变成默认给所有人录音。
    expect(isVoiceCallRecordingEnabled({ recordCalls: undefined })).toBe(false);
    expect(isVoiceCallRecordingEnabled({ recordCalls: true })).toBe(true);
  });
});

describe('voiceCallRecorder', () => {
  it('两路 WAV 都能收尾成合法头，长度字段与实际数据一致', async () => {
    const root = tmpRoot();
    const recorder = createVoiceCallRecorder('voice-1', { root, now: Date.parse('2026-08-14T10:00:00.000Z') });
    expect(recorder).not.toBeNull();

    const upstreamFrame = Buffer.alloc(320); // 10ms @16k PCM16
    const downstreamFrame = Buffer.alloc(480); // 10ms @24k PCM16
    for (let i = 0; i < 5; i += 1) {
      recorder!.feedUpstream(upstreamFrame);
      recorder!.feedDownstream(downstreamFrame);
    }
    const meta = await recorder!.close(Date.parse('2026-08-14T10:00:03.000Z'));

    expect(meta).not.toBeNull();
    expect(meta!.upstreamBytes).toBe(320 * 5);
    expect(meta!.downstreamBytes).toBe(480 * 5);
    expect(meta!.durationMs).toBe(3000);

    const upstream = fs.readFileSync(path.join(recorder!.dir, 'upstream.wav'));
    expect(upstream.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(upstream.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(upstream.readUInt32LE(24)).toBe(16_000); // 上行采样率
    expect(upstream.readUInt32LE(40)).toBe(320 * 5); // data chunk size 已回填
    expect(upstream.readUInt32LE(4)).toBe(36 + 320 * 5); // RIFF size 已回填
    expect(upstream.length).toBe(WAV_HEADER_BYTES + 320 * 5);

    const downstream = fs.readFileSync(path.join(recorder!.dir, 'downstream.wav'));
    expect(downstream.readUInt32LE(24)).toBe(24_000); // 下行采样率
    expect(downstream.readUInt32LE(40)).toBe(480 * 5);

    // meta.json 与文件实际长度对得上，事后判「录到没有」不用去解 WAV。
    const persisted = JSON.parse(fs.readFileSync(path.join(recorder!.dir, 'meta.json'), 'utf8')) as {
      upstreamBytes: number;
    };
    expect(persisted.upstreamBytes).toBe(320 * 5);
  });

  it('close 之后再喂帧是 no-op，不会把已回填的长度写坏', async () => {
    const root = tmpRoot();
    const recorder = createVoiceCallRecorder('voice-2', { root })!;
    recorder.feedUpstream(Buffer.alloc(100));
    await recorder.close();
    const sizeAfterClose = fs.statSync(path.join(recorder.dir, 'upstream.wav')).size;

    recorder.feedUpstream(Buffer.alloc(100));
    expect(await recorder.close()).toBeNull(); // 重复 close 也是 no-op
    expect(fs.statSync(path.join(recorder.dir, 'upstream.wav')).size).toBe(sizeAfterClose);
  });
});

describe('runVoiceRecordingRetention — 三条上限分别变异验证', () => {
  const now = Date.parse('2026-08-14T12:00:00.000Z');
  /** 三通录音，各 1MB，分别是 30 天前 / 2 天前 / 刚刚。 */
  function seed(root: string): void {
    makeExistingCall(root, '20260715-120000-a', 1024 * 1024, now - 30 * DAY_MS);
    makeExistingCall(root, '20260812-120000-b', 1024 * 1024, now - 2 * DAY_MS);
    makeExistingCall(root, '20260814-120000-c', 1024 * 1024, now - 60_000);
  }

  it('全部在限内时什么都不删，也不写台账（不制造噪音）', async () => {
    const root = tmpRoot();
    seed(root);
    const result = await runVoiceRecordingRetention({
      root, now, retentionDays: 365, maxBytes: 1024 ** 3, maxCalls: 100,
    });
    expect(result).toBeNull();
    expect((await listVoiceRecordings(root)).length).toBe(3);
    expect(await readVoiceRecordingCleanupLedger(root)).toEqual([]);
  });

  it('① 只压保留期 → 只有 age 触发', async () => {
    const root = tmpRoot();
    seed(root);
    const result = await runVoiceRecordingRetention({
      root, now, retentionDays: 7, maxBytes: 1024 ** 3, maxCalls: 100,
    });
    expect(result).not.toBeNull();
    expect(result!.byRule).toEqual({ age: 1, count: 0, bytes: 0 });
    const names = (await listVoiceRecordings(root)).map((item) => item.name);
    expect(names).toEqual(['20260812-120000-b', '20260814-120000-c']);
  });

  it('② 只压条数 → 只有 count 触发', async () => {
    const root = tmpRoot();
    seed(root);
    const result = await runVoiceRecordingRetention({
      root, now, retentionDays: 365, maxBytes: 1024 ** 3, maxCalls: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.byRule).toEqual({ age: 0, count: 1, bytes: 0 });
    expect((await listVoiceRecordings(root)).length).toBe(2);
  });

  it('③ 只压体积 → 只有 bytes 触发', async () => {
    const root = tmpRoot();
    seed(root);
    const result = await runVoiceRecordingRetention({
      root, now, retentionDays: 365, maxBytes: 1024 * 1024 * 2, maxCalls: 100,
    });
    expect(result).not.toBeNull();
    expect(result!.byRule).toEqual({ age: 0, count: 0, bytes: 1 });
    expect(result!.freedBytes).toBe(1024 * 1024);
    expect((await listVoiceRecordings(root)).length).toBe(2);
  });

  it('清理写台账，删了几个/释放多少/哪条上限触发都能查到（判据 5 可见性）', async () => {
    const root = tmpRoot();
    seed(root);
    await runVoiceRecordingRetention({ root, now, retentionDays: 7, maxBytes: 1024 ** 3, maxCalls: 100 });
    const ledger = await readVoiceRecordingCleanupLedger(root);
    expect(ledger.length).toBe(1);
    expect(ledger[0]).toMatchObject({ at: now, deleted: 1, freedBytes: 1024 * 1024 });
    expect(ledger[0].byRule.age).toBe(1);
  });

  it('三条同时压到极小也不会删掉最新那通（它可能正在录）', async () => {
    const root = tmpRoot();
    seed(root);
    const result = await runVoiceRecordingRetention({
      root, now, retentionDays: 0, maxBytes: 0, maxCalls: 0,
    });
    expect(result!.deleted).toBe(2);
    const survivors = await listVoiceRecordings(root);
    expect(survivors.map((item) => item.name)).toEqual(['20260814-120000-c']);
  });
});
