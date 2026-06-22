#!/usr/bin/env node
/**
 * Packaged-webServer boot gate.
 *
 * Catches the class of bug that broke v0.19.0 in production: a library imported
 * during webServer startup that is esbuild-`external` but NOT shipped in the
 * packaged app → packaged `require()` throws MODULE_NOT_FOUND → the backend exits
 * 1 before healthcheck → "Web server exited before healthcheck completed".
 *
 * Local builds and CI never caught it because they run with the full repo
 * node_modules present, so the external `require()` resolved fine.
 *
 * Two layers:
 *   1. STATIC (hard gate, deterministic): the built bundle must NOT contain a
 *      bare `require("<lib>")` for any lib that must be bundled — those are never
 *      shipped as Tauri app resources, so an external require would crash the
 *      packaged app. This is the reliable, CI-safe gate.
 *   2. RUNTIME (best-effort): boot the bundle with the must-bundle libs hidden
 *      from node_modules and fail if a MODULE_NOT_FOUND occurs at startup. Other
 *      boot outcomes (env-specific: keychain, native deps, MCP) are not failures.
 *
 * Usage: node scripts/verify-webserver-boot.mjs   (run after `npm run build:web`)
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Libraries that MUST end up bundled into dist/web/webServer.cjs (they are NOT
// shipped as Tauri app resources — see src-tauri/tauri.conf.json `resources`).
// If any is accidentally left in NATIVE_EXTERNALS (esbuild.config.ts), the
// packaged app crashes at boot.
const MUST_BE_BUNDLED = ['pdfkit', 'pptxgenjs', 'mammoth', 'exceljs', 'qrcode'];

const BUNDLE = 'dist/web/webServer.cjs';

if (!existsSync(BUNDLE)) {
  console.error(`✗ ${BUNDLE} not found — run \`npm run build:web\` first.`);
  process.exit(1);
}

// ── Layer 1: static — no external require of a must-bundle lib ───────────────
const src = readFileSync(BUNDLE, 'utf8');
// esbuild emits an unbundled (external) require as `require("name")` with double
// quotes. Single-quoted occurrences come from embedded source-string templates
// (e.g. PPT scaffold code-gen) and are NOT real external requires, so match only
// the double-quote esbuild form to avoid false positives.
const stillExternal = MUST_BE_BUNDLED.filter((m) => src.includes(`require("${m}")`));
if (stillExternal.length > 0) {
  console.error(
    `✗ webServer boot gate FAILED — these libs are imported at startup but left esbuild-external (not bundled, not shipped):\n` +
    stillExternal.map((m) => `    - ${m}`).join('\n') +
    `\n  Fix: remove them from NATIVE_EXTERNALS in esbuild.config.ts (so esbuild bundles them).` +
    `\n  This is exactly what made v0.19.0 crash on launch ("Web server exited before healthcheck").`,
  );
  process.exit(1);
}
console.log(`✓ static: no external require of ${MUST_BE_BUNDLED.length} must-bundle libs (${MUST_BE_BUNDLED.join(', ')})`);

// ── Layer 2: best-effort runtime boot with those libs hidden ────────────────
const NM = join(process.cwd(), 'node_modules');
const READY = '[3/3] Starting HTTP server';
const TIMEOUT_MS = 90_000;
const PORT = String(20000 + Math.floor(Math.random() * 20000));

const hidden = [];
function restore() {
  for (const p of hidden) { try { renameSync(`${p}.smoke-hidden`, p); } catch { /* best effort */ } }
  hidden.length = 0;
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });

for (const m of MUST_BE_BUNDLED) {
  const p = join(NM, m);
  if (existsSync(p)) { renameSync(p, `${p}.smoke-hidden`); hidden.push(p); }
}
console.log(`[boot-smoke] hidden ${hidden.length} must-bundle libs; booting on port ${PORT}...`);

const child = spawn(process.execPath, [BUNDLE], {
  env: { ...process.env, WEB_PORT: PORT, CODE_AGENT_BOOT_SMOKE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let settled = false;
function finish(code, msg) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try { child.kill('SIGKILL'); } catch { /* noop */ }
  restore();
  if (code === 0) { console.log(`✓ ${msg}`); process.exit(0); }
  console.error(`✗ ${msg}`);
  console.error('--- last output ---\n' + out.slice(-2000));
  process.exit(1);
}
function isMustBundle(modPath) {
  // modPath is a bare name ("pdfkit") or a resolved path; match by basename.
  const base = modPath.split(/[\\/]/).pop();
  return MUST_BE_BUNDLED.some((m) => modPath === m || base === m || modPath.endsWith(`/${m}`));
}
function scan(chunk) {
  out += chunk;
  // Only a MUST-bundle lib missing at boot is our bug. Other missing modules
  // (e.g. `dist/native/better-sqlite3` not built in a lightweight web-only job)
  // are env/setup issues — let the exit/timeout handler warn+pass instead.
  const miss = out.match(/Cannot find module '([^']+)'/);
  if (miss && isMustBundle(miss[1])) {
    finish(1, `runtime boot: must-bundle lib '${miss[1]}' missing at boot — it is esbuild-external, not bundled.`);
    return;
  }
  if (out.includes(READY)) finish(0, 'runtime boot reached HTTP stage with must-bundle libs hidden.');
}
child.stdout.on('data', (d) => scan(d.toString()));
child.stderr.on('data', (d) => scan(d.toString()));
// Env-specific boot failures (keychain/native/MCP in CI) are NOT gate failures —
// the static layer already guarantees the bundling invariant.
child.on('exit', () => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  restore();
  console.log('⚠ runtime boot exited before HTTP stage (no missing-module) — env-specific, not a bundling failure. Static gate already passed.');
  process.exit(0);
});
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  try { child.kill('SIGKILL'); } catch { /* noop */ }
  restore();
  console.log(`⚠ runtime boot did not reach HTTP stage within ${TIMEOUT_MS}ms (no missing-module) — env-specific, not a bundling failure. Static gate already passed.`);
  process.exit(0);
}, TIMEOUT_MS);
