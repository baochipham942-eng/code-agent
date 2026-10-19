// ============================================================================
// html_incomplete / button_no_response 真浏览器测试 — N-ORPHAN-WIRE-DASHBOARD-VALIDATOR。
//
// 走公共入口 runArtifactPreviewHealth（生产链路同款），用打死的 webServerBaseUrl
// 强制 self-started Chrome fallback 路由（与 parity 测试的 fallback 用例同构）。
// fixture 全部落在 tmpdir，本地文件 URL，无网络依赖。
// ============================================================================

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runArtifactPreviewHealth,
} from '../../../../../src/host/agent/runtime/browser/artifactPreviewHealth';

const TOKEN = 'interaction-token';
const DEAD_WEB_SERVER = 'http://127.0.0.1:9';
const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 720 }];

let workspaceDir: string;

async function writeFixture(name: string, html: string): Promise<string> {
  const filePath = path.join(workspaceDir, name);
  await writeFile(filePath, html, 'utf8');
  return filePath;
}

async function runHealth(filePath: string) {
  return runArtifactPreviewHealth(filePath, {
    webServerBaseUrl: DEAD_WEB_SERVER,
    webServerToken: TOKEN,
    viewports: VIEWPORTS,
    locale: 'en',
  });
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(tmpdir(), 'preview-interaction-'));
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

describe('html_incomplete static truncation check', () => {
  it('flags a file whose <html>/<body> open tags are never closed', async () => {
    const filePath = await writeFixture('truncated.html', [
      '<html>',
      '<body>',
      '<main data-preview-root><h1>Truncated dashboard</h1><p>output was cut mid-document',
    ].join('\n'));

    const summary = await runHealth(filePath);

    expect(summary.route).toBe('self-started-chrome');
    expect(summary.findings.map((finding) => finding.code)).toContain('html_incomplete');
    expect(summary.failures.join('\n')).toContain('truncated');
  }, 60_000);

  it('does not flag a fragment that has neither <html> nor <body> tags', async () => {
    const filePath = await writeFixture('fragment.html', [
      '<div data-preview-root>',
      '<h1>Fragment page</h1><p>Body-less fragment is a legal partial deliverable.</p>',
      '</div>',
    ].join('\n'));

    const summary = await runHealth(filePath);

    expect(summary.findings.map((finding) => finding.code)).not.toContain('html_incomplete');
  }, 60_000);

  it('does not flag a well-formed document', async () => {
    const filePath = await writeFixture('wellformed.html', [
      '<!doctype html><html lang="en"><head><title>ok</title></head>',
      '<body><main data-preview-root><h1>Fine</h1><p>Complete document.</p></main></body></html>',
    ].join('\n'));

    const summary = await runHealth(filePath);

    expect(summary.findings.map((finding) => finding.code)).not.toContain('html_incomplete');
  }, 60_000);
});

describe('button_no_response click probe', () => {
  it('does not flag a working button that mutates the DOM on click', async () => {
    const filePath = await writeFixture('working-button.html', [
      '<!doctype html><html><head><title>working</title></head><body>',
      '<main data-preview-root>',
      '<h1>Working button</h1>',
      '<button id="go">Go</button>',
      '<p id="out">count:0</p>',
      '</main>',
      '<script>',
      'document.getElementById("go").addEventListener("click", function () {',
      '  var out = document.getElementById("out");',
      '  out.textContent = "count:" + (parseInt(out.textContent.slice(6), 10) + 1);',
      '});',
      '</script>',
      '</body></html>',
    ].join('\n'));

    const summary = await runHealth(filePath);

    expect(summary.diagnostics?.buttonClick?.checked).toBe(true);
    expect(summary.diagnostics?.buttonClick?.responded).toBe(true);
    expect(summary.findings.map((finding) => finding.code)).not.toContain('button_no_response');
  }, 60_000);

  it('flags a dead button whose click handler does nothing observable', async () => {
    const filePath = await writeFixture('dead-button.html', [
      '<!doctype html><html><head><title>dead</title></head><body>',
      '<main data-preview-root">',
      '<h1>Dead button</h1>',
      '<button id="dead">Filter</button>',
      '<p>Nothing is wired.</p>',
      '</main>',
      '<script>',
      'document.getElementById("dead").addEventListener("click", function () {});',
      '</script>',
      '</body></html>',
    ].join('\n'));

    const summary = await runHealth(filePath);

    expect(summary.findings.map((finding) => finding.code)).toContain('button_no_response');
  }, 60_000);

  it('does not flag a tab that only toggles a visibility class (innerText arm)', async () => {
    const filePath = await writeFixture('class-tab.html', [
      '<!doctype html><html><head><title>tab</title><style>',
      '#pa { display: block; } #pa.off { display: none; }',
      '#pb { display: none; } #pb.on { display: block; }',
      '</style></head><body>',
      '<main data-preview-root">',
      '<h1>Tab toggle</h1>',
      '<button id="tab">Show panel B</button>',
      '<section id="pa">Panel A visible text</section>',
      '<section id="pb">Panel B hidden text</section>',
      '</main>',
      '<script>',
      'document.getElementById("tab").addEventListener("click", function () {',
      '  document.getElementById("pa").classList.add("off");',
      '  document.getElementById("pb").classList.add("on");',
      '});',
      '</script>',
      '</body></html>',
    ].join('\n'));

    const summary = await runHealth(filePath);

    expect(summary.diagnostics?.buttonClick?.mutations).toBe(0);
    expect(summary.diagnostics?.buttonClick?.textChanged).toBe(true);
    expect(summary.findings.map((finding) => finding.code)).not.toContain('button_no_response');
  }, 60_000);

  it('does not flag a page with no <button> at all', async () => {
    const filePath = await writeFixture('no-button.html', [
      '<!doctype html><html><head><title>none</title></head><body>',
      '<main data-preview-root">',
      '<h1>Static page</h1>',
      '<p>Display-only dashboard without buttons.</p>',
      '</main>',
      '</body></html>',
    ].join('\n'));

    const summary = await runHealth(filePath);

    expect(summary.diagnostics?.buttonClick).toEqual({ checked: false });
    expect(summary.findings.map((finding) => finding.code)).not.toContain('button_no_response');
  }, 60_000);
});
