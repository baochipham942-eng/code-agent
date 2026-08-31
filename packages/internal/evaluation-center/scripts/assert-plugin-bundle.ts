import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '..');

function matchingLine(source: string, pattern: RegExp): { line: number; text: string } | null {
  const lines = source.split(/\r?\n/u);
  const index = lines.findIndex((line) => pattern.test(line));
  return index < 0 ? null : { line: index + 1, text: lines[index].trim() };
}

function fail(message: string): never {
  throw new Error(`[assert-plugin-bundle] ${message}`);
}

export function assertPluginBundle(root = packageRoot): void {
  const jsPath = path.join(root, 'dist/renderer/index.js');
  const cssPath = path.join(root, 'dist/renderer/index.css');
  const js = fs.readFileSync(jsPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');

  const bundledRuntime = matchingLine(js, /node_modules\/(?:react|react-dom|zustand)\//u);
  if (bundledRuntime) {
    fail(`${path.relative(root, jsPath)}:${bundledRuntime.line}: ${bundledRuntime.text}`);
  }
  const bareRequire = matchingLine(js, /(^|[^\w])require\s*\(/u);
  if (bareRequire) {
    fail(`${path.relative(root, jsPath)}:${bareRequire.line}: 裸 require 命中：${bareRequire.text}`);
  }
  if (!/\.grid-cols-(?:1|2|3|4)\b/u.test(css)) {
    fail(`${path.relative(root, cssPath)}: 缺少包内使用的 grid-cols utility`);
  }
  if (!css.includes('.border-brand') || !/data-theme=['"]?dark/u.test(css) || !css.includes('high-contrast-dark')) {
    fail(`${path.relative(root, cssPath)}: 缺少宿主 theme 或 data-theme dark 变体`);
  }
  if (!/@layer\s+theme\b/u.test(css)) {
    fail(`${path.relative(root, cssPath)}: 缺少 Tailwind theme layer`);
  }
  if (/\*,::before,::after\s*\{\s*box-sizing/u.test(css)) {
    fail(`${path.relative(root, cssPath)}: 检测到 Tailwind preflight`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assertPluginBundle();
  process.stdout.write('[assert-plugin-bundle] renderer JS/CSS assertions passed\n');
}
