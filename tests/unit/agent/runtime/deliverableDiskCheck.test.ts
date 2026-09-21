// ============================================================================
// deliverableDiskCheck — 交付物落盘核对（issue #1998）
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkDeliverablesOnDisk,
  collectDeliverableClaims,
  runDeliverableDiskCheckGate,
} from '../../../../src/host/agent/runtime/deliverableDiskCheck';
import type { Message } from '../../../../src/shared/contract';

const workRoot = path.join(os.tmpdir(), `deliverable-disk-check-${process.pid}-${Date.now()}`);

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    role: 'user',
    content: '做一份周报',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

/** 本 run 有产出类工具活动（推断声称只在这种 run 里核对）。 */
function producingActivity(id = 'write-1', filePath?: string): Message {
  return {
    id: 'tool-activity',
    role: 'assistant',
    content: '',
    timestamp: 1_700_000_000_050,
    toolCalls: [{ id, name: 'Write', arguments: { file_path: filePath ?? 'out.txt' } }],
    toolResults: [{ toolCallId: id, success: true, output: 'ok', metadata: filePath ? { outputPath: filePath } : undefined }],
  };
}

/** 抽取走生产消费方入口（knip production 口径：只测真有人 import 的导出）。
 * 推断声称只在本 run 有产出类工具活动时核对（纯问答的讲解性文件名不算声称），
 * 夹具因此固定带一条成功的 bash 调用。 */
function extract(text: string): string[] {
  const messages = [message(), producingActivity()];
  return collectDeliverableClaims({ messages, workingDirectory: '/wd', finalText: text })
    .map((claim) => claim.claimed);
}

afterEach(() => {
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
});

describe('extractClaimedDeliverablePaths (via collectDeliverableClaims)', () => {
  it('extracts nothing without a claim verb', () => {
    expect(extract('文件在 output/report.html，自己看。')).toEqual([]);
  });

  it('extracts quoted paths with spaces and Chinese characters', () => {
    const text = '已保存为 `output/周报 最终版.md`，请查收。';
    expect(extract(text)).toEqual(['output/周报 最终版.md']);
  });

  it('extracts bare path tokens with CJK segments', () => {
    const text = '已生成 output/周报.html 和 dist/site/index.html。';
    expect(extract(text)).toEqual(['output/周报.html', 'dist/site/index.html']);
  });

  it('ignores bare filenames without a separator unless quoted', () => {
    expect(extract('已生成 report.html。')).toEqual([]);
    expect(extract('已生成「report.html」。')).toEqual(['report.html']);
  });

  it('excludes references to the input materials directory (资料/)', () => {
    const text = '已读取 资料/周报.md，并把汇总保存到 output/汇总.md。';
    expect(extract(text)).toEqual(['output/汇总.md']);
  });

  it('normalizes NFD claims to NFC on the resolved path', () => {
    const nfd = 'output/周报.md'.normalize('NFD');
    const claims = collectDeliverableClaims({ messages: [message(), producingActivity()], workingDirectory: '/wd', finalText: `已生成 ${nfd}` });
    expect(claims.map((claim) => claim.resolved)).toEqual([path.join('/wd', 'output/周报.md'.normalize('NFC'))]);
  });

  it('ignores paths inside fenced code blocks', () => {
    const text = '已生成 output/a.html。\n```\nwritten to /tmp/build/log.txt\n```';
    expect(extract(text)).toEqual(['output/a.html']);
  });

  // ai-review #2007 Important 2：URL 不是本地交付物，抽出来核对只会误判 not_on_disk。
  it('ignores URLs and host:port links instead of treating them as local paths', () => {
    expect(extract('已部署到 https://foo.vercel.app/index.html，页面已生成。')).toEqual([]);
    expect(extract('已生成页面，见 localhost:5173/index.html。')).toEqual([]);
    expect(extract('已生成 output/a.html，预览在 https://x.vercel.app/a.html。'))
      .toEqual(['output/a.html']);
  });

  // ai-review #2007 Nit：未闭合围栏不剥——一路吞到结尾会把后面的真声称漏掉。
  it('keeps scanning prose after an unclosed code fence', () => {
    const text = '```\nsome draft\n已生成 output/a.html。';
    expect(extract(text)).toEqual(['output/a.html']);
  });

  // ai-review #2007 Important（复审）：引号形态无路径形状约束 + 全文动词闸，会把
  // console.log / v2.1 / Node.js / 已删除文件抽成交付物声称，诱导模型造垃圾文件或复活已删文件。
  it('does not pick quoted identifiers, versions, runtimes, or deleted files as deliverables', () => {
    expect(extract('已创建 `src/a.ts`，并在里面调用了 `console.log`，依赖升级到 `v2.1`。'))
      .toEqual(['src/a.ts']);
    expect(extract('已生成报告 `report.md`，基于 `Node.js` 与 `Vue.js` 实现。'))
      .toEqual(['report.md']);
    expect(extract('已删除旧的 `old/legacy.ts`，已创建 `new.ts`。'))
      .toEqual(['new.ts']);
  });

  // ai-review #2007 第六轮 Nit：Windows 盘符绝对路径不能丢盘符。
  it('keeps Windows drive-letter paths intact', () => {
    expect(extract('已生成 C:\\output\\report.html。')).toEqual(['C:\\output\\report.html']);
  });

  // ai-review #2007 第六轮 Nit：产物生成工具（非写入族）靠 outputPath 元数据算产出活动。
  it('treats a successful tool result with outputPath as producing activity', () => {
    const messages = [
      message(),
      message({ id: 'gen', role: 'assistant', content: '',
        toolCalls: [{ id: 'gen-1', name: 'text_to_speech', arguments: {} }],
        toolResults: [{ toolCallId: 'gen-1', success: true, metadata: { outputPath: 'out/audio.mp3' } }] }),
    ];
    const claims = collectDeliverableClaims({ messages, workingDirectory: '/wd', finalText: '已生成 out/audio.mp3。' });
    expect(claims.map((claim) => claim.claimed)).toEqual(['out/audio.mp3']);
  });
});

describe('collectDeliverableClaims', () => {
  it('includes declared deliverables only when declared in this run', () => {
    mkdirSync(workRoot, { recursive: true });
    const messages = [message()];
    const thisRun = collectDeliverableClaims({
      messages,
      workingDirectory: workRoot,
      declaredDeliverables: { finalArtifacts: ['out/final.html'], declaredAtMs: 1_700_000_000_500 },
    });
    expect(thisRun.map((claim) => claim.claimed)).toEqual(['out/final.html']);

    const olderRun = collectDeliverableClaims({
      messages,
      workingDirectory: workRoot,
      declaredDeliverables: { finalArtifacts: ['out/final.html'], declaredAtMs: 1_699_999_999_000 },
    });
    expect(olderRun).toEqual([]);
  });

  it('resolves inferred claims from the final reply against the working directory', () => {
    mkdirSync(workRoot, { recursive: true });
    const messages = [
      message(),
      producingActivity(),
      message({ id: 'a1', role: 'assistant', content: '已生成 output/周报.html。', timestamp: 1_700_000_000_100 }),
    ];
    const claims = collectDeliverableClaims({ messages, workingDirectory: workRoot });
    expect(claims).toEqual([{
      claimed: 'output/周报.html',
      resolved: path.join(workRoot, 'output/周报.html'),
      source: 'inferred',
    }]);
  });

  // ai-review #2007 Important 1：~ 开头不展开会 resolve 成 <wd>/~/...，真实写到家目录的文件被误判缺失。
  it('expands ~ before resolving so home-directory deliverables check out', () => {
    mkdirSync(workRoot, { recursive: true });
    const homeFile = path.join(os.homedir(), `deliverable-disk-check-home-${process.pid}.md`);
    writeFileSync(homeFile, 'home artifact');
    try {
      const messages = [
        message(),
        producingActivity(),
        message({ id: 'a1', role: 'assistant', content: `已保存到 \`~/${path.basename(homeFile)}\`。`, timestamp: 1_700_000_000_100 }),
      ];
      const claims = collectDeliverableClaims({ messages, workingDirectory: workRoot });
      expect(claims).toHaveLength(1);
      expect(claims[0].resolved).toBe(homeFile);
      const result = checkDeliverablesOnDisk(claims, workRoot);
      expect(result.missing).toEqual([]);
      expect(result.evidenceRefs).toHaveLength(1);
    } finally {
      rmSync(homeFile, { force: true });
    }
  });

  // ai-review #2007 第四轮 Important：裸文件名只查工作目录根会误判子目录产物——
  // 先按 basename 对到本 run 真写出的文件。
  it('maps a quoted bare filename to the same-named file this run wrote in a subdirectory', () => {
    mkdirSync(path.join(workRoot, 'src/sub'), { recursive: true });
    const artifact = path.join(workRoot, 'src/sub/x.ts');
    writeFileSync(artifact, 'export const x = 1;');
    const messages = [
      message(),
      message({ id: 'wrote-x', role: 'assistant', content: '',
        toolCalls: [{ id: 'write-x', name: 'Write', arguments: { file_path: artifact } }],
        toolResults: [{ toolCallId: 'write-x', success: true, metadata: { outputPath: artifact } }] }),
      message({ id: 'final', role: 'assistant', content: '已创建 `x.ts` 并完成接线。', timestamp: 1_700_000_000_100 }),
    ];
    const claims = collectDeliverableClaims({ messages, workingDirectory: workRoot });
    expect(claims).toEqual([{ claimed: 'x.ts', resolved: artifact, source: 'inferred' }]);
    const result = checkDeliverablesOnDisk(claims, workRoot);
    expect(result.missing).toEqual([]);
  });

  // ai-review #2007 第五轮 Important：纯问答 run 的讲解性文件名（「会保存到 `out.csv`」）
  // 是假设/讲解不是声称——没有产出类工具活动就不核对推断声称，避免诱导模型造未请求的文件。
  it('does not extract inferred claims in a run without producing tool activity', () => {
    const messages = [
      message(),
      message({ id: 'a1', role: 'assistant', content: '运行 `python a.py` 后会把结果保存到 `out.csv`。', timestamp: 1_700_000_000_100 }),
    ];
    expect(collectDeliverableClaims({ messages, workingDirectory: workRoot })).toEqual([]);
  });

  // ai-review #2007 第六轮 Important：win32 反斜杠路径 basename 用 split('/') 取不到，
  // 裸文件名声称永远对不上本 run 真写出的子目录文件。
  it('maps a bare filename to a run-touched file even with win32 backslash paths', () => {
    const winPath = 'C:\\ws\\src\\sub\\x.ts';
    const messages = [
      message(),
      message({ id: 'wrote-x', role: 'assistant', content: '',
        toolCalls: [{ id: 'write-x', name: 'Write', arguments: { file_path: winPath } }],
        toolResults: [{ toolCallId: 'write-x', success: true, metadata: { outputPath: winPath } }] }),
      message({ id: 'final', role: 'assistant', content: '已创建 `x.ts` 并完成接线。', timestamp: 1_700_000_000_100 }),
    ];
    const claims = collectDeliverableClaims({ messages, workingDirectory: workRoot });
    expect(claims).toHaveLength(1);
    expect(claims[0].claimed).toBe('x.ts');
    expect(claims[0].resolved.endsWith('x.ts')).toBe(true);
    expect(claims[0].resolved).not.toBe(path.join(workRoot, 'x.ts'));
  });
});

describe('checkDeliverablesOnDisk', () => {
  // ai-review #2007 第三轮 Important：核对 IO 必须有界——数量上限外的声称不处理，
  // 回读字节预算耗尽后降级 stat 存在性检查（candidate 证据），收尾不阻塞事件循环。
  it('caps the number of processed claims and degrades readback to stat-only beyond the byte budget', () => {
    mkdirSync(workRoot, { recursive: true });
    const overCount = Array.from({ length: 60 }, (_, index) => {
      const file = path.join(workRoot, `f${index}.md`);
      writeFileSync(file, 'x');
      return { claimed: `f${index}.md`, resolved: file, source: 'inferred' as const };
    });
    const capped = checkDeliverablesOnDisk(overCount, workRoot);
    expect(capped.claims).toHaveLength(50);

    const claims = Array.from({ length: 40 }, (_, index) => {
      const file = path.join(workRoot, `big-${index}.bin`);
      writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 1));
      return { claimed: `big-${index}.bin`, resolved: file, source: 'inferred' as const };
    });
    const degraded = checkDeliverablesOnDisk(claims, workRoot);
    expect(degraded.missing).toEqual([]);
    expect(degraded.evidenceRefs.every((ref) => ref.freshness.state === 'candidate')).toBe(false);
    expect(degraded.evidenceRefs.some((ref) => ref.freshness.state === 'candidate')).toBe(true);
  });

  it('passes an existing non-empty file and returns a read evidence ref', () => {
    mkdirSync(workRoot, { recursive: true });
    const artifact = path.join(workRoot, 'report.md');
    writeFileSync(artifact, '# 周报');
    const result = checkDeliverablesOnDisk(
      [{ claimed: 'report.md', resolved: artifact, source: 'inferred' }],
      workRoot,
    );
    expect(result.missing).toEqual([]);
    expect(result.evidenceRefs).toHaveLength(1);
    expect(result.evidenceRefs[0].freshness.state).toBe('read');
  });

  it('flags a missing file as not_on_disk', () => {
    mkdirSync(workRoot, { recursive: true });
    const result = checkDeliverablesOnDisk(
      [{ claimed: 'ghost.md', resolved: path.join(workRoot, 'ghost.md'), source: 'inferred' }],
      workRoot,
    );
    expect(result.evidenceRefs).toEqual([]);
    expect(result.missing).toEqual([{ claim: { claimed: 'ghost.md', resolved: path.join(workRoot, 'ghost.md'), source: 'inferred' }, kind: 'not_on_disk' }]);
  });

  it('flags a zero-byte file as empty', () => {
    mkdirSync(workRoot, { recursive: true });
    const artifact = path.join(workRoot, 'empty.html');
    writeFileSync(artifact, '');
    const result = checkDeliverablesOnDisk(
      [{ claimed: 'empty.html', resolved: artifact, source: 'declared' }],
      workRoot,
    );
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].kind).toBe('empty');
  });
});

describe('repair prompt and undelivered note (via runDeliverableDiskCheckGate)', () => {
  function gate(finalText: string, repairsUsed: number) {
    return runDeliverableDiskCheckGate({
      workingDirectory: workRoot,
      messages: [message(), producingActivity()],
      finalText,
      repairsUsed,
    });
  }

  it('repair prompt lists the claimed and resolved paths', () => {
    mkdirSync(workRoot, { recursive: true });
    const result = gate('已生成 output/周报.html。', 0);
    if (result.action !== 'repair') throw new Error('expected repair action');
    expect(result.prompt).toContain('<deliverable-disk-check>');
    expect(result.prompt).toContain('output/周报.html');
    expect(result.prompt).toContain(path.join(workRoot, 'output/周报.html'));
  });

  it('undelivered note is appended to the final reply when the repair budget is exhausted', () => {
    mkdirSync(workRoot, { recursive: true });
    const result = gate('已生成 output/周报.html。', 1);
    if (result.action !== 'pass') throw new Error('expected pass action');
    expect(result.content).toContain('已生成 output/周报.html。');
    expect(result.content).toContain('本轮实际未交付');
    expect(result.content).toContain('output/周报.html');
  });
});
