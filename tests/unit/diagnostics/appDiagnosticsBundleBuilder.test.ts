import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildAppDiagnosticsBundle } from '../../../src/host/diagnostics/appDiagnosticsBundleBuilder';

const DAY_MS = 24 * 60 * 60 * 1000;

function writeFileWithMtime(filePath: string, content: string, mtime: Date): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  fs.utimesSync(filePath, mtime, mtime);
}

describe('buildAppDiagnosticsBundle', () => {
  function makeDirs(root: string) {
    return {
      logDir: path.join(root, 'logs'),
      shellLogDir: path.join(root, 'shell-logs'),
      auditDir: path.join(root, 'audit'),
      configPath: path.join(root, 'config.json'),
      rendererCacheDir: path.join(root, 'renderer-cache'),
    };
  }

  it('includes recent host logs but excludes files older than the retention window', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    const now = Date.parse('2026-08-07T12:00:00.000Z');
    writeFileWithMtime(path.join(dirs.logDir, 'code-agent-2026-08-07.log'), 'recent log line', new Date(now - DAY_MS));
    writeFileWithMtime(path.join(dirs.logDir, 'code-agent-2026-07-01.log'), 'stale log line', new Date(now - 30 * DAY_MS));

    const result = await buildAppDiagnosticsBundle({
      ...dirs,
      now,
      homeDir: root,
      workingDirectory: root,
    });

    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files)).toContain('logs/code-agent-2026-08-07.log');
    expect(Object.keys(zip.files)).not.toContain('logs/code-agent-2026-07-01.log');
    expect(result.manifest.includes.hostLogs).toBe(true);
  });

  it('bundles Tauri shell boot diagnostics and events when present', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    const now = Date.now();
    fs.mkdirSync(dirs.shellLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(dirs.shellLogDir, 'desktop-shell-boot-latest.json'),
      JSON.stringify({ schemaVersion: 1, stage: 'health-ready' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(dirs.shellLogDir, 'desktop-shell-events.ndjson'),
      `${JSON.stringify({ level: 'info', message: 'boot' })}\n`,
      'utf8',
    );

    const result = await buildAppDiagnosticsBundle({ ...dirs, now, homeDir: root, workingDirectory: root });

    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files)).toContain('desktop-shell/boot-latest.json');
    expect(Object.keys(zip.files)).toContain('desktop-shell/events.ndjson');
    expect(result.manifest.includes.desktopShellBoot).toBe(true);
    expect(result.manifest.includes.desktopShellEvents).toBe(true);
  });

  it('omits Tauri shell files gracefully when the directory has none', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    const result = await buildAppDiagnosticsBundle({ ...dirs, now: Date.now(), homeDir: root, workingDirectory: root });

    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files)).not.toContain('desktop-shell/boot-latest.json');
    expect(Object.keys(zip.files)).not.toContain('desktop-shell/events.ndjson');
    expect(result.manifest.includes.desktopShellBoot).toBe(false);
    expect(result.manifest.includes.desktopShellEvents).toBe(false);
  });

  it('redacts key/token/secret/password/credential fields in config.json regardless of value shape', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    fs.writeFileSync(dirs.configPath, JSON.stringify({
      apiKey: 'plain-looking-value-not-secret-shaped',
      authToken: 'abc123',
      userPassword: 'hunter2',
      dbCredential: { nested: 'still-redacted' },
      providers: [{ secretValue: 'zzz' }],
      theme: 'dark',
    }), 'utf8');

    const result = await buildAppDiagnosticsBundle({ ...dirs, now: Date.now(), homeDir: root, workingDirectory: root });

    const zip = await JSZip.loadAsync(result.buffer);
    const configText = await zip.file('config.sanitized.json')!.async('string');
    const parsed = JSON.parse(configText);
    expect(parsed.apiKey).toBe('[REDACTED]');
    expect(parsed.authToken).toBe('[REDACTED]');
    expect(parsed.userPassword).toBe('[REDACTED]');
    expect(parsed.dbCredential).toBe('[REDACTED]');
    expect(parsed.providers[0].secretValue).toBe('[REDACTED]');
    expect(parsed.theme).toBe('dark');
    expect(result.manifest.includes.config).toBe(true);
  });

  it('records a renderer-cache manifest of names/sizes/mtimes without copying content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    fs.mkdirSync(path.join(dirs.rendererCacheDir, 'active', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dirs.rendererCacheDir, 'active', 'index.html'), '<html>secret-content</html>', 'utf8');
    fs.writeFileSync(path.join(dirs.rendererCacheDir, 'active', 'assets', 'app.js'), 'console.log(1)', 'utf8');

    const result = await buildAppDiagnosticsBundle({ ...dirs, now: Date.now(), homeDir: root, workingDirectory: root });

    const zip = await JSZip.loadAsync(result.buffer);
    const manifestText = await zip.file('renderer-cache-manifest.json')!.async('string');
    const entries: Array<{ path: string; bytes: number; mtime: string }> = JSON.parse(manifestText);
    expect(entries.map((e) => e.path).sort()).toEqual(['active/assets/app.js', 'active/index.html']);
    expect(entries.every((e) => typeof e.bytes === 'number' && e.bytes > 0)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('secret-content');
  });

  it('embeds the optional doctor report when provided by the renderer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    const doctorReport = { summary: { pass: 5, warn: 1, fail: 0, skip: 0 }, items: [] };

    const result = await buildAppDiagnosticsBundle({
      ...dirs, now: Date.now(), homeDir: root, workingDirectory: root, doctorReport,
    });

    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files)).toContain('doctor-report.json');
    const parsed = JSON.parse(await zip.file('doctor-report.json')!.async('string'));
    expect(parsed).toMatchObject({ summary: { pass: 5 } });
    expect(result.manifest.includes.doctorReport).toBe(true);
  });

  it('omits the doctor report entry when none is provided', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    const result = await buildAppDiagnosticsBundle({ ...dirs, now: Date.now(), homeDir: root, workingDirectory: root });

    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files)).not.toContain('doctor-report.json');
    expect(result.manifest.includes.doctorReport).toBe(false);
  });

  it('produces a manifest with sha256 + byte counts for every packaged file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    const result = await buildAppDiagnosticsBundle({ ...dirs, now: Date.now(), homeDir: root, workingDirectory: root });

    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.manifest.files.length).toBeGreaterThan(0);
    for (const entry of result.manifest.files) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.bytes).toBeGreaterThanOrEqual(0);
    }
    expect(result.suggestedFileName).toMatch(/^neo-diagnostics-\d{8}-\d{6}\.zip$/);
  });

  it('scrubs the home directory out of sanitized log/audit content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    const now = Date.now();
    const homeDir = path.join(root, 'home', 'tester');
    writeFileWithMtime(
      path.join(dirs.logDir, 'code-agent-today.log'),
      `path=${homeDir}/project/secret.txt`,
      new Date(now),
    );
    writeFileWithMtime(
      path.join(dirs.auditDir, '2026-08-07.jsonl'),
      JSON.stringify({ command: `cat ${homeDir}/.ssh/id_rsa` }),
      new Date(now),
    );

    const result = await buildAppDiagnosticsBundle({ ...dirs, now, homeDir, workingDirectory: root });

    const zip = await JSZip.loadAsync(result.buffer);
    const logText = await zip.file('logs/code-agent-today.log')!.async('string');
    const auditText = await zip.file('audit/2026-08-07.jsonl')!.async('string');
    expect(logText).not.toContain(homeDir);
    expect(auditText).not.toContain(homeDir);
    expect(logText).toContain('~');
    expect(auditText).toContain('~');
  });

  // N-L7-SPK 判据 6：导出诊断包 → 包内无任何声纹向量（「不离机」的负例）。
  // 数据目录按真实布局搭：logs/audit/config.json/voiceprint 同根，声纹已注册后打包，
  // 逐个 zip 条目扫哨兵值——白名单式收集将来若被改成整目录扫描，这条会当场红。
  // （灵敏度已变异验证过：把 configPath 指向 owner-profile.json 时本测试红。）
  it('已注册声纹后导出诊断包：包内无 voiceprint 路径、无向量哨兵值（判据6）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-diag-'));
    const dirs = makeDirs(root);
    const now = Date.now();
    writeFileWithMtime(path.join(dirs.logDir, 'code-agent-today.log'), 'voiceprint verdict logged', new Date(now));
    fs.writeFileSync(dirs.configPath, JSON.stringify({ voice: { live: { voiceprint: true } } }), 'utf8');

    const prevDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = root;
    try {
      const { registerOwnerEmbedding } = await import('../../../src/host/services/voice/voiceprintStore');
      const { VOICEPRINT_EMBEDDING_DIM } = await import('../../../src/shared/constants/voice');
      const sentinel = 0.987654321;
      registerOwnerEmbedding(new Float32Array(VOICEPRINT_EMBEDDING_DIM).fill(sentinel), now);
      expect(fs.existsSync(path.join(root, 'voiceprint', 'owner-profile.json'))).toBe(true);

      const result = await buildAppDiagnosticsBundle({ ...dirs, now, homeDir: root, workingDirectory: root });
      const zip = await JSZip.loadAsync(result.buffer);
      const names = Object.keys(zip.files);
      expect(names.some((name) => name.toLowerCase().includes('voiceprint'))).toBe(false);
      for (const name of names) {
        const entry = zip.file(name);
        if (!entry) continue;
        const content = await entry.async('string');
        expect(content, `bundle entry ${name} 泄漏了声纹向量`).not.toContain('0.98765');
      }
    } finally {
      if (prevDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
      else process.env.CODE_AGENT_DATA_DIR = prevDataDir;
    }
  });
});
