// ============================================================================
// deliverableDiskCheck — 交付物落盘核对（issue #1998）
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendUndeliveredNote,
  buildDeliverableRepairPrompt,
  checkDeliverablesOnDisk,
  collectDeliverableClaims,
  extractClaimedDeliverablePaths,
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

afterEach(() => {
  if (existsSync(workRoot)) rmSync(workRoot, { recursive: true, force: true });
});

describe('extractClaimedDeliverablePaths', () => {
  it('extracts nothing without a claim verb', () => {
    expect(extractClaimedDeliverablePaths('文件在 output/report.html，自己看。')).toEqual([]);
  });

  it('extracts quoted paths with spaces and Chinese characters', () => {
    const text = '已保存为 `output/周报 最终版.md`，请查收。';
    expect(extractClaimedDeliverablePaths(text)).toEqual(['output/周报 最终版.md']);
  });

  it('extracts bare path tokens with CJK segments', () => {
    const text = '已生成 output/周报.html 和 dist/site/index.html。';
    expect(extractClaimedDeliverablePaths(text)).toEqual(['output/周报.html', 'dist/site/index.html']);
  });

  it('ignores bare filenames without a separator unless quoted', () => {
    expect(extractClaimedDeliverablePaths('已生成 report.html。')).toEqual([]);
    expect(extractClaimedDeliverablePaths('已生成「report.html」。')).toEqual(['report.html']);
  });

  it('excludes references to the input materials directory (资料/)', () => {
    const text = '已读取 资料/周报.md，并把汇总保存到 output/汇总.md。';
    expect(extractClaimedDeliverablePaths(text)).toEqual(['output/汇总.md']);
  });

  it('normalizes NFD claims to NFC', () => {
    const nfd = 'output/周报.md'.normalize('NFD');
    expect(extractClaimedDeliverablePaths(`已生成 ${nfd}`)).toEqual(['output/周报.md'.normalize('NFC')]);
  });

  it('ignores paths inside fenced code blocks', () => {
    const text = '已生成 output/a.html。\n```\nwritten to /tmp/build/log.txt\n```';
    expect(extractClaimedDeliverablePaths(text)).toEqual(['output/a.html']);
  });

  // ai-review #2007 Important 2：URL 不是本地交付物，抽出来核对只会误判 not_on_disk。
  it('ignores URLs and host:port links instead of treating them as local paths', () => {
    expect(extractClaimedDeliverablePaths('已部署到 https://foo.vercel.app/index.html，页面已生成。')).toEqual([]);
    expect(extractClaimedDeliverablePaths('已生成页面，见 localhost:5173/index.html。')).toEqual([]);
    expect(extractClaimedDeliverablePaths('已生成 output/a.html，预览在 https://x.vercel.app/a.html。'))
      .toEqual(['output/a.html']);
  });

  // ai-review #2007 Nit：未闭合围栏不剥——一路吞到结尾会把后面的真声称漏掉。
  it('keeps scanning prose after an unclosed code fence', () => {
    const text = '```\nsome draft\n已生成 output/a.html。';
    expect(extractClaimedDeliverablePaths(text)).toEqual(['output/a.html']);
  });

  // ai-review #2007 Important（复审）：引号形态无路径形状约束 + 全文动词闸，会把
  // console.log / v2.1 / Node.js / 已删除文件抽成交付物声称，诱导模型造垃圾文件或复活已删文件。
  it('does not pick quoted identifiers, versions, runtimes, or deleted files as deliverables', () => {
    expect(extractClaimedDeliverablePaths('已创建 `src/a.ts`，并在里面调用了 `console.log`，依赖升级到 `v2.1`。'))
      .toEqual(['src/a.ts']);
    expect(extractClaimedDeliverablePaths('已生成报告 `report.md`，基于 `Node.js` 与 `Vue.js` 实现。'))
      .toEqual(['report.md']);
    expect(extractClaimedDeliverablePaths('已删除旧的 `old/legacy.ts`，已创建 `new.ts`。'))
      .toEqual(['new.ts']);
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
        toolResults: [{ toolCallId: 'write-x', success: true, metadata: { outputPath: artifact } }] }),
      message({ id: 'final', role: 'assistant', content: '已创建 `x.ts` 并完成接线。', timestamp: 1_700_000_000_100 }),
    ];
    const claims = collectDeliverableClaims({ messages, workingDirectory: workRoot });
    expect(claims).toEqual([{ claimed: 'x.ts', resolved: artifact, source: 'inferred' }]);
    const result = checkDeliverablesOnDisk(claims, workRoot);
    expect(result.missing).toEqual([]);
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

describe('repair prompt and undelivered note', () => {
  const missing = [{
    claim: { claimed: 'output/周报.html', resolved: '/ws/output/周报.html', source: 'inferred' as const },
    kind: 'not_on_disk' as const,
  }];

  it('repair prompt lists the claimed and resolved paths', () => {
    const prompt = buildDeliverableRepairPrompt(missing);
    expect(prompt).toContain('<deliverable-disk-check>');
    expect(prompt).toContain('output/周报.html');
    expect(prompt).toContain('/ws/output/周报.html');
  });

  it('undelivered note is appended to the final reply', () => {
    const note = appendUndeliveredNote('已生成 output/周报.html。', missing);
    expect(note).toContain('已生成 output/周报.html。');
    expect(note).toContain('本轮实际未交付');
    expect(note).toContain('output/周报.html');
  });
});
