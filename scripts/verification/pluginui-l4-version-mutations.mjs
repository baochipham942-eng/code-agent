#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const repoRoot = process.cwd();
const outputPath = process.argv[2] ?? '/tmp/pluginui-l4-version-mutations.md';
const storeFile = 'src/host/plugins/pluginPackageVersionStore.ts';
const runtimeFile = 'src/host/services/capabilities/pluginPackageVersionRuntime.ts';
const hostFile = 'src/renderer/slots/productSlotHosts.tsx';
const manualTest = 'tests/unit/services/capabilities/manualCapabilityPackageService.test.ts';

const immutableExistingBlock = `  if (existing) {
    const existingHash = await hashPluginPackage(packageRoot);
    if (existingHash !== input.packageHash) {
      throw new Error('已有版本的内容与记录不一致，已拒绝覆盖');
    }
    return { packageId, packageRoot, state };
  }
`;

const overwriteExistingBlock = `  if (existing) {
    await fs.rm(packageRoot, { recursive: true, force: true });
    delete state.packages[packageId];
  }
`;

const mutations = [
  {
    id: 'V1',
    label: '新版本覆盖旧版本',
    replacements: [
      [storeFile, "  return `${safeVersion}-${packageHash.slice(0, 16).toLowerCase()}`;", "  return 'mutable-package';"],
      [storeFile, immutableExistingBlock, overwriteExistingBlock],
    ],
    tests: [manualTest],
  },
  {
    id: 'V2',
    label: '把最近成功版本当成正在运行',
    replacements: [[
      runtimeFile,
      `      const detail = error instanceof Error ? error.message : String(error);
      delete state.runningPackageId;
      state.nextPackageId = packageId;`,
      `      const detail = error instanceof Error ? error.message : String(error);
      state.runningPackageId = state.currentPackageId;
      state.nextPackageId = packageId;`,
    ]],
    tests: [manualTest],
  },
  {
    id: 'V3',
    label: '没有成功版本时误判为更新',
    replacements: [[
      storeFile,
      "  return !currentPackageId || currentPackageId === targetPackageId ? 'run' : 'update';",
      "  return !currentPackageId ? 'update' : currentPackageId === targetPackageId ? 'run' : 'update';",
    ]],
    tests: [manualTest],
  },
  {
    id: 'V4',
    label: '同一版本误判为更新',
    replacements: [[
      storeFile,
      "  return !currentPackageId || currentPackageId === targetPackageId ? 'run' : 'update';",
      "  return !currentPackageId ? 'run' : currentPackageId === targetPackageId ? 'update' : 'update';",
    ]],
    tests: [manualTest],
  },
  {
    id: 'V5',
    label: '不同版本误判为普通启动',
    replacements: [[
      storeFile,
      "  return !currentPackageId || currentPackageId === targetPackageId ? 'run' : 'update';",
      "  return !currentPackageId || currentPackageId === targetPackageId ? 'run' : 'run';",
    ]],
    tests: [manualTest],
  },
  {
    id: 'V6',
    label: '显式恢复误判为更新',
    replacements: [[
      runtimeFile,
      '    const mode = activationMode(state.currentPackageId, packageId);',
      "    const mode = state.lastRun?.status === 'failed' && packageId === state.currentPackageId\n      ? 'update'\n      : activationMode(state.currentPackageId, packageId);",
    ]],
    tests: [manualTest],
  },
  {
    id: 'V7',
    label: '更新失败后自动恢复旧运行态',
    replacements: [[
      runtimeFile,
      `      await writePluginVersionState(pluginRoot, state);
      this.dependencies.lifecycle(pluginId, 'failed', detail);`,
      `      await writePluginVersionState(pluginRoot, state);
      if (state.currentPackageId) {
        const restored = await this.dependencies.registry.installPluginFromDirectory(
          pluginPackageRoot(pluginRoot, state.currentPackageId),
        );
        if (restored.success) {
          state.runningPackageId = state.currentPackageId;
          await writePluginVersionState(pluginRoot, state);
        }
      }
      this.dependencies.lifecycle(pluginId, 'failed', detail);`,
    ]],
    tests: [manualTest],
  },
  {
    id: 'V8',
    label: '修复代码覆盖失败版本',
    replacements: [
      [storeFile, "  return `${safeVersion}-${packageHash.slice(0, 16).toLowerCase()}`;", '  return safeVersion;'],
      [storeFile, immutableExistingBlock, overwriteExistingBlock],
    ],
    tests: [manualTest],
  },
  {
    id: 'V9',
    label: '单版本授权被提升为长期授权',
    replacements: [[
      runtimeFile,
      '    if (approveFutureVersions) state.approveFutureVersions = true;',
      '    state.approveFutureVersions = true;',
    ]],
    tests: [manualTest],
  },
  {
    id: 'V10',
    label: '拒绝后自动重试',
    replacements: [[
      runtimeFile,
      `    if (stored) stored.approval = 'denied';
    if (state.nextPackageId === candidate.packageId) delete state.nextPackageId;
    await writePluginVersionState(pluginRoot, state);`,
      `    if (stored) stored.approval = 'approved';
    state.nextPackageId = candidate.packageId;
    await writePluginVersionState(pluginRoot, state);
    await this.activate(candidate.manifest.id, candidate.packageId);`,
    ]],
    tests: [manualTest],
  },
  {
    id: 'V11',
    label: '技术失败后清掉授权',
    replacements: [[
      runtimeFile,
      `      state.lastRun = {
        pluginRunId,
        packageId,
        mode,
        status: 'failed',`,
      `      state.packages[packageId].approval = 'pending';
      state.lastRun = {
        pluginRunId,
        packageId,
        mode,
        status: 'failed',`,
    ]],
    tests: [manualTest],
  },
  {
    id: 'V12',
    label: '审批入口从全局界面移除',
    replacements: [[hostFile, '      <PluginApprovalOverlay />\n', '']],
    tests: [
      'tests/renderer/slots/pluginApprovalOverlay.test.tsx',
      'tests/renderer/slots/productSlotHosts.test.tsx',
    ],
  },
  {
    id: 'V13',
    label: '迁移第二次改变记录',
    replacements: [[
      storeFile,
      '  if (existing) return existing;\n\n  const parent = path.dirname(pluginRoot);',
      `  if (existing) {
    existing.approveFutureVersions = !existing.approveFutureVersions;
    await writePluginVersionState(pluginRoot, existing);
    return existing;
  }

  const parent = path.dirname(pluginRoot);`,
    ]],
    tests: [manualTest],
  },
];

function replaceExact(source, from, to, mutationId, file) {
  const first = source.indexOf(from);
  if (first === -1) throw new Error(`${mutationId}: anchor missing in ${file}`);
  if (source.indexOf(from, first + from.length) !== -1) {
    throw new Error(`${mutationId}: anchor is not unique in ${file}`);
  }
  return `${source.slice(0, first)}${to}${source.slice(first + from.length)}`;
}

const evidence = [
  '# N-PLUGINUI-L4-VERSION 反向变异原始红行',
  '',
  `执行时间：${new Date().toISOString()}`,
  '',
];

for (const mutation of mutations) {
  const originals = new Map();
  try {
    for (const [relative, from, to] of mutation.replacements) {
      const absolute = path.join(repoRoot, relative);
      const current = originals.has(absolute) ? readFileSync(absolute, 'utf8') : readFileSync(absolute, 'utf8');
      if (!originals.has(absolute)) originals.set(absolute, current);
      writeFileSync(absolute, replaceExact(current, from, to, mutation.id, relative));
    }
    const run = spawnSync(
      process.execPath,
      ['node_modules/vitest/vitest.mjs', 'run', ...mutation.tests],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/gu, '');
    const summary = output.split(/\r?\n/u).find((line) => /Tests\s+\d+ failed\s+\|\s+\d+ passed/u.test(line));
    if (run.status === 0 || !summary) {
      throw new Error(`${mutation.id}: mutation did not produce a raw failed/passed line\n${output.slice(-4000)}`);
    }
    evidence.push(`## ${mutation.id} ${mutation.label}`, '', '```text', summary.trim(), '```', '');
    process.stdout.write(`${mutation.id} ${summary.trim()}\n`);
  } finally {
    for (const [absolute, original] of originals) writeFileSync(absolute, original);
  }
}

writeFileSync(outputPath, `${evidence.join('\n')}\n`);
process.stdout.write(`evidence=${outputPath}\n`);
