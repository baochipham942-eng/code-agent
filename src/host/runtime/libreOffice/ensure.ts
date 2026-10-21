import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  LIBREOFFICE_PROBE_SLOW_TTFB_MS,
  LIBREOFFICE_PROBE_TIMEOUT_MS,
  LIBREOFFICE_RUNTIME_VERSION,
  buildForArch,
} from './constants';
import { checksumError, installFailedError, offlineError, unsupportedError } from './errors';
import { appendInstallLog } from './log';
import { defaultProbe } from './probe';
import {
  clearInflight,
  clearInstallPercent,
  forgetError,
  getInflight,
  isManagedLibreOfficeInstalled,
  rememberError,
  setInflight,
  setInstallPercent,
} from './state';
import {
  managedLibreOfficePath,
  mountPath,
  readyJsonPath,
  resolveLibreOfficeRoot,
  temporaryDmgPath,
} from './layout';
import type { EnsureLibreOfficeOptions, EnsureLibreOfficeResult, LibreOfficeProbeResult } from './types';

const execFileAsync = promisify(execFile);
const STEP_PROBE = 5;
const STEP_COPY = 90;

function isFast(result: LibreOfficeProbeResult): boolean {
  return result.ok && result.ttfbMs <= LIBREOFFICE_PROBE_SLOW_TTFB_MS;
}

async function probeOne(
  probe: NonNullable<EnsureLibreOfficeOptions['probe']>,
  url: string,
  root: string,
  now: () => Date,
): Promise<LibreOfficeProbeResult> {
  let result: LibreOfficeProbeResult;
  try {
    result = await probe(url, LIBREOFFICE_PROBE_TIMEOUT_MS);
  } catch {
    result = { url, ok: false, ttfbMs: LIBREOFFICE_PROBE_TIMEOUT_MS };
  }
  appendInstallLog(root, now(), `probe url=${url} ok=${result.ok} ttfbMs=${result.ttfbMs}`);
  return result;
}

async function chooseSource(
  build: ReturnType<typeof buildForArch>,
  probe: NonNullable<EnsureLibreOfficeOptions['probe']>,
  root: string,
  now: () => Date,
): Promise<string | null> {
  const official = await probeOne(probe, build.officialUrl, root, now);
  if (isFast(official)) return build.officialUrl;
  const mirror = await probeOne(probe, build.mirrorUrl, root, now);
  if (mirror.ok) return build.mirrorUrl;
  // A reachable but slow official source remains usable when the mirror is down.
  if (official.ok) return build.officialUrl;
  return null;
}

async function defaultDownload(
  url: string,
  destination: string,
  totalBytes: number,
  onProgress: (transferred: number, total: number) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download HTTP ${response.status}`);
  const file = fs.createWriteStream(destination, { flags: 'w' });
  let transferred = 0;
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      await new Promise<void>((resolve, reject) => file.write(Buffer.from(chunk), (error) => error ? reject(error) : resolve()));
      transferred += chunk.byteLength;
      onProgress(transferred, Number(response.headers.get('content-length')) || totalBytes);
    }
  } finally {
    await new Promise<void>((resolve) => file.end(() => resolve()));
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

function writeReady(root: string, marker: Record<string, string>): void {
  const temporary = path.join(root, `.ready.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`);
  fs.renameSync(temporary, readyJsonPath(root));
}

async function defaultRunCommand(file: string, args: string[]): Promise<void> {
  await execFileAsync(file, args, { maxBuffer: 2 * 1024 * 1024 });
}

async function runInstall(options: EnsureLibreOfficeOptions, root: string): Promise<EnsureLibreOfficeResult> {
  const now = options.now ?? (() => new Date());
  const build = buildForArch(options.arch);
  const probe = options.probe ?? defaultProbe;
  const download = options.download ?? defaultDownload;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const dmgPath = temporaryDmgPath(root, build.fileName);
  const mount = mountPath(root);
  let attached = false;
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.rmSync(readyJsonPath(root), { force: true });
    fs.rmSync(dmgPath, { force: true });
    setInstallPercent(root, STEP_PROBE);
    const sourceUrl = await chooseSource(build, probe, root, now);
    if (!sourceUrl) {
      appendInstallLog(root, now(), 'chosen source=none');
      return { ok: false, error: offlineError(root), root };
    }
    appendInstallLog(root, now(), `chosen source=${sourceUrl}`);
    setInstallPercent(root, 10);
    await download(sourceUrl, dmgPath, build.bytes, (transferred, total) => {
      const denominator = total > 0 ? total : build.bytes;
      setInstallPercent(root, 10 + Math.min(80, Math.round((transferred / denominator) * 80)));
    });
    const actual = await sha256File(dmgPath);
    appendInstallLog(root, now(), `download complete bytes=${fs.statSync(dmgPath).size} sha256=${actual}`);
    if (actual.toLowerCase() !== build.sha256.toLowerCase()) {
      fs.rmSync(dmgPath, { force: true });
      appendInstallLog(root, now(), `checksum mismatch expected=${build.sha256} actual=${actual}`);
      return { ok: false, error: checksumError(root), root };
    }
    fs.rmSync(mount, { recursive: true, force: true });
    fs.mkdirSync(mount, { recursive: true });
    attached = true;
    await runCommand('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmgPath]);
    setInstallPercent(root, STEP_COPY);
    const appSource = path.join(mount, 'LibreOffice.app');
    const appDestination = path.join(root, 'LibreOffice.app');
    fs.rmSync(appDestination, { recursive: true, force: true });
    await runCommand('ditto', [appSource, appDestination]);
    if (!fs.existsSync(managedLibreOfficePath(root))) {
      return { ok: false, error: installFailedError(root), root };
    }
    writeReady(root, {
      version: LIBREOFFICE_RUNTIME_VERSION,
      arch: build.arch,
      sha256: build.sha256,
      sourceUrl,
      installedAt: now().toISOString(),
    });
    setInstallPercent(root, 100);
    return { ok: true, sofficePath: managedLibreOfficePath(root), reused: false, root };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try { appendInstallLog(root, now(), `install failed: ${reason}`); } catch { /* best effort */ }
    return { ok: false, error: installFailedError(root), root };
  } finally {
    if (attached) {
      try {
        await runCommand('hdiutil', ['detach', mount]);
        appendInstallLog(root, now(), `detached mount=${mount}`);
      } catch (error) {
        try { appendInstallLog(root, now(), `detach failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* best effort */ }
      }
    }
    fs.rmSync(dmgPath, { force: true });
    fs.rmSync(mount, { recursive: true, force: true });
  }
}

function finish(root: string, result: EnsureLibreOfficeResult, resolve: (result: EnsureLibreOfficeResult) => void): void {
  if (result.ok) forgetError(root);
  else rememberError(root, result.error);
  clearInflight(root);
  clearInstallPercent(root);
  resolve(result);
}

export function ensureLibreOffice(options: EnsureLibreOfficeOptions = {}): Promise<EnsureLibreOfficeResult> {
  const platform = options.platform ?? process.platform;
  const root = resolveLibreOfficeRoot(options.dataDir);
  if (platform !== 'darwin') return Promise.resolve({ ok: false, error: unsupportedError(root), root });
  const existing = getInflight(root);
  if (existing) return existing;
  if (isManagedLibreOfficeInstalled(root)) {
    return Promise.resolve({ ok: true, sofficePath: managedLibreOfficePath(root), reused: true, root });
  }
  let resolveRun: (result: EnsureLibreOfficeResult) => void = () => {};
  const promise = new Promise<EnsureLibreOfficeResult>((resolve) => { resolveRun = resolve; });
  setInflight(root, promise);
  void runInstall(options, root).then(
    (result) => finish(root, result, resolveRun),
    () => finish(root, { ok: false, error: installFailedError(root), root }, resolveRun),
  );
  return promise;
}
