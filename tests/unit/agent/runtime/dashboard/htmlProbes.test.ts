// ============================================================================
// HTML declarative probe unit tests — PR-C.
//
// 直接构造 declarative probe 的 evaluate 路径（通过 GeneralDashboardChecker），
// 覆盖 html_complete / no_lorem_ipsum 各自 pass + fail case。
//
// 用 tmpdir + writeFile 当 fixture，afterEach 清理。
// ============================================================================

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  HTML_COMPLETE_PROBE,
  NO_LOREM_IPSUM_PROBE,
  HTML_PROBES,
} from '../../../../../src/main/agent/runtime/dashboard/general/htmlProbes';
import { GeneralDashboardChecker } from '../../../../../src/main/agent/runtime/dashboard/general/GeneralDashboardChecker';

const checker = new GeneralDashboardChecker();

async function runProbeAgainstHtml(html: string, workspaceDir: string, probeId: string) {
  const filePath = join(workspaceDir, 'fixture.html');
  await writeFile(filePath, html, 'utf-8');
  const result = await checker.validate({ filePath });
  const probe = result.probes.find((p) => p.probe === probeId);
  if (!probe) throw new Error(`Probe ${probeId} not found in result; got: ${result.probes.map((p) => p.probe).join(', ')}`);
  return probe;
}

describe('HTML_PROBES set', () => {
  it('exports html_complete + no_lorem_ipsum in order', () => {
    expect(HTML_PROBES.map((p) => p.id)).toEqual(['html_complete', 'no_lorem_ipsum']);
  });

  it('all probes are declarative', () => {
    expect(HTML_PROBES.every((p) => p.kind === 'declarative')).toBe(true);
  });

  it('individual exports match the set members', () => {
    expect(HTML_PROBES[0]).toBe(HTML_COMPLETE_PROBE);
    expect(HTML_PROBES[1]).toBe(NO_LOREM_IPSUM_PROBE);
  });
});

describe('html_complete probe', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'html-probes-test-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('passes for a well-formed HTML document', async () => {
    const html = `<!DOCTYPE html><html><head><title>X</title></head><body><p>hi</p></body></html>`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'html_complete');
    expect(probe.passed).toBe(true);
    expect(probe.failure).toBeUndefined();
  });

  it('passes when html lacks DOCTYPE (browsers still render)', async () => {
    const html = `<html><body><p>no doctype but still valid</p></body></html>`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'html_complete');
    expect(probe.passed).toBe(true);
  });

  it('fails when </html> is missing (truncated output)', async () => {
    const html = `<html><body><p>truncated`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'html_complete');
    expect(probe.passed).toBe(false);
    expect(probe.failure).toMatch(/HTML 文档结构不完整/);
  });

  it('fails when <body> is missing', async () => {
    const html = `<html><head><title>headless</title></head></html>`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'html_complete');
    expect(probe.passed).toBe(false);
  });

  it('fails when entirely empty', async () => {
    const probe = await runProbeAgainstHtml('', workspaceDir, 'html_complete');
    expect(probe.passed).toBe(false);
  });
});

describe('no_lorem_ipsum probe', () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'html-probes-test-'));
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('passes for content without placeholder text', async () => {
    const html = `<html><body><h1>Real Title</h1><p>Real content body.</p></body></html>`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'no_lorem_ipsum');
    expect(probe.passed).toBe(true);
    expect(probe.failure).toBeUndefined();
  });

  it('fails on lorem ipsum text', async () => {
    const html = `<html><body><p>Lorem ipsum dolor sit amet.</p></body></html>`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'no_lorem_ipsum');
    expect(probe.passed).toBe(false);
    expect(probe.failure).toMatch(/占位文本/);
  });

  it('fails on the literal "TODO" word boundary (uppercase)', async () => {
    const html = `<html><body><p>TODO: replace me</p></body></html>`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'no_lorem_ipsum');
    expect(probe.passed).toBe(false);
  });

  it('fails on Chinese 占位 marker', async () => {
    const html = `<html><body><p>这里是占位</p></body></html>`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'no_lorem_ipsum');
    expect(probe.passed).toBe(false);
  });

  it('fails on "Coming soon" marker (case-insensitive)', async () => {
    const html = `<html><body><p>coming Soon: revenue dashboard</p></body></html>`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'no_lorem_ipsum');
    expect(probe.passed).toBe(false);
  });

  it('does not fail on "todo" inside another word (e.g. "todomvc")', async () => {
    // \bTODO\b 用 word boundary，避免 "todomvc" / "todoist" 误伤。case-insensitive
    // flag 让小写也走 word boundary 检查。
    const html = `<html><body><p>Built with TodoMVC.</p></body></html>`;
    const probe = await runProbeAgainstHtml(html, workspaceDir, 'no_lorem_ipsum');
    expect(probe.passed).toBe(true);
  });
});

describe('GeneralDashboardChecker handles missing file', () => {
  it('marks all declarative probes as failed when file does not exist', async () => {
    const result = await checker.validate({ filePath: '/tmp/nonexistent-dashboard-fixture-xyz.html' });
    expect(result.passed).toBe(false);
    expect(result.probes.every((p) => !p.passed)).toBe(true);
    expect(result.failures.every((f) => /无法读取 dashboard artifact/.test(f))).toBe(true);
  });
});
