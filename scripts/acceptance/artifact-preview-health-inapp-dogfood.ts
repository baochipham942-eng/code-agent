import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer } from 'http';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runArtifactPreviewHealth } from '../../src/host/agent/runtime/browser/artifactPreviewHealth';
import { browserService } from '../../src/host/services/infra/browserService';

interface StartedWebServer {
  baseUrl: string;
  token: string;
  child: ChildProcessWithoutNullStreams;
  output: () => string;
}

async function findPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('Unable to allocate port');
  return address.port;
}

async function waitForHealth(baseUrl: string, token: string, output: () => string): Promise<void> {
  const startedAt = Date.now();
  let lastError = '';
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const health = await response.json() as { status?: string };
      if (response.ok && health.status === 'ok') return;
      lastError = JSON.stringify(health);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for webServer health. token=${token.slice(0, 4)}... last=${lastError}\n${output()}`);
}

async function startWebServer(dataDir: string): Promise<StartedWebServer> {
  if (!existsSync('dist/web/webServer.cjs')) {
    throw new Error('dist/web/webServer.cjs is missing. Run npm run build:web first.');
  }
  const port = await findPort();
  const outputChunks: string[] = [];
  const child = spawn(process.execPath, [path.join(process.cwd(), 'dist/web/webServer.cjs')], {
    env: {
      ...process.env,
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_E2E: '1',
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => outputChunks.push(String(chunk)));
  child.stderr.on('data', (chunk) => outputChunks.push(String(chunk)));
  const output = () => outputChunks.join('').slice(-200_000);
  let token = '';
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const match = output().match(/\{"port":\d+,"token":"([^"]+)"\}/);
    if (match) {
      token = match[1];
      break;
    }
    if (child.exitCode !== null) {
      throw new Error(`webServer exited early with ${child.exitCode}\n${output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!token) throw new Error(`webServer did not print startup token\n${output()}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, token, output);
  return { baseUrl, token, child, output };
}

async function stopWebServer(server: StartedWebServer | null): Promise<void> {
  if (!server) return;
  if (server.child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    server.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    server.child.kill('SIGTERM');
  });
}

async function writeArtifact(root: string): Promise<string> {
  await mkdir(path.join(root, 'styles'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'nested', 'images'), { recursive: true });
  await writeFile(path.join(root, 'styles', 'site.css'), 'main[data-preview-root]{display:block!important;padding:24px;min-height:180px}', 'utf8');
  await writeFile(path.join(root, 'scripts', 'app.js'), "console.error('dogfood-relative-js-error');", 'utf8');
  await writeFile(path.join(root, 'nested', 'images', 'broken.png'), 'not-a-real-png', 'utf8');
  const artifactPath = path.join(root, 'index.html');
  await writeFile(artifactPath, String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>In-app preview health dogfood</title>
    <link rel="stylesheet" href="./styles/site.css" />
    <script src="./scripts/app.js"></script>
  </head>
  <body>
    <main data-preview-root style="display:none">
      <h1>In-app preview health dogfood</h1>
      <p>Relative CSS and JS must load through /api/workspace/file.</p>
      <img alt="broken nested asset" src="./nested/images/broken.png" />
    </main>
  </body>
</html>`, 'utf8');
  return artifactPath;
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'artifact-preview-health-inapp-dogfood-'));
  const dataDir = path.join(dir, 'data');
  let server: StartedWebServer | null = null;
  try {
    server = await startWebServer(dataDir);
    const artifactPath = await writeArtifact(path.join(dir, 'artifact'));
    const result = await runArtifactPreviewHealth(artifactPath, {
      webServerBaseUrl: server.baseUrl,
      webServerToken: server.token,
      viewports: [{ name: 'mobile', width: 390, height: 780 }],
      locale: 'en',
    });
    const state = browserService.getSessionState();
    if (result.route !== 'in-app-browser') {
      throw new Error(`Expected in-app-browser route, got ${result.route ?? '<missing>'}: ${JSON.stringify(result.checks)}`);
    }
    console.log(JSON.stringify({
      route: result.route,
      passed: result.passed,
      findingCodes: result.findings.map((finding) => finding.code),
      checks: result.checks,
      diagnostics: {
        viewportCount: result.diagnostics?.viewports.length ?? 0,
        brokenImageEvidence: result.findings.find((finding) => finding.code === 'broken_image')?.evidence,
      },
      managedBrowser: {
        running: state.running,
        provider: state.provider,
        tabCount: state.tabCount,
        mode: state.mode,
      },
      webServer: {
        baseUrl: server.baseUrl,
        outputHasWorkspaceRoute: result.checks.some((check) => check.includes('/api/workspace/file')),
      },
      artifactPath,
    }, null, 2));
  } finally {
    await browserService.close().catch(() => undefined);
    await stopWebServer(server);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
