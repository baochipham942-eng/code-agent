#!/usr/bin/env npx tsx

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { quote } from 'shell-quote';
import { createRunContext } from '../../src/host/runtime/runContext';
import {
  WorkspaceScopeResolver,
  createWorkspaceScope,
} from '../../src/host/runtime/workspaceScope';
import { getProjectSourceGitStates } from '../../src/host/services/git/gitStatusService';
import { wrapCommandForSandbox } from '../../src/host/sandbox';
import { resolveExternalEngineLaunch } from '../../src/host/services/agentEngine/agentEngineGuards';
import type { Session } from '../../src/shared/contract/session';

let passed = 0;
function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function runShell(command: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: 'ignore' });
    child.once('exit', (code) => resolve(code ?? -1));
  });
}

async function main(): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'neo-multi-source-acceptance-'));
  const primary = path.join(base, 'primary');
  const docs = path.join(base, 'docs');
  const tools = path.join(base, 'tools');
  const external = path.join(base, 'external');
  await Promise.all([primary, docs, tools, external].map((directory) => mkdir(directory)));
  await writeFile(path.join(docs, 'requirements.md'), 'multi-source requirements\n', 'utf8');
  await writeFile(path.join(external, 'secret.txt'), 'outside\n', 'utf8');

  try {
    for (const repo of [primary, tools]) {
      git(repo, ['init']);
      git(repo, ['config', 'user.email', 'acceptance@example.com']);
      git(repo, ['config', 'user.name', 'Acceptance']);
      await writeFile(path.join(repo, 'README.md'), `${path.basename(repo)}\n`, 'utf8');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-m', 'initial']);
    }
    await writeFile(path.join(tools, 'README.md'), 'tools dirty\n', 'utf8');

    const initialScope = createWorkspaceScope('proj_acceptance', [
      { sourceId: 'primary', path: primary, role: 'primary', access: 'read_write' },
      { sourceId: 'docs', path: docs, role: 'additional', access: 'read_only' },
      { sourceId: 'tools', path: tools, role: 'additional', access: 'read_write' },
    ]);
    const resolver = new WorkspaceScopeResolver(initialScope);
    check('Primary 可写', resolver.canWrite(path.join(primary, 'out.txt')));
    check('Additional 默认只读', resolver.canRead(path.join(docs, 'requirements.md'))
      && !resolver.canWrite(path.join(docs, 'blocked.txt')));
    check('显式读写 Additional 可写', resolver.canWrite(path.join(tools, 'generated.txt')));
    check('未加入目录保持 external', !resolver.canRead(path.join(external, 'secret.txt')));

    const oldRun = createRunContext({
      runId: 'run-old',
      sessionId: 'session-history',
      workspace: primary,
      workspaceScope: initialScope,
      cwd: docs,
      createdAt: 1,
    });
    const promotedScope = createWorkspaceScope('proj_acceptance', initialScope.roots.map((root) => (
      root.sourceId === 'docs' ? { ...root, access: 'read_write' as const } : root
    )));
    const newRun = createRunContext({
      runId: 'run-new',
      sessionId: 'session-history',
      workspace: primary,
      workspaceScope: promotedScope,
      cwd: docs,
      createdAt: 2,
    });
    check('运行中 Run 不因 Project 编辑动态扩权', oldRun.workspaceScope.roots.find((root) => root.sourceId === 'docs')?.access === 'read_only');
    check('历史 Session 下一 Run 使用新 Source 快照', newRun.workspaceScope.roots.find((root) => root.sourceId === 'docs')?.access === 'read_write');

    const gitStates = await getProjectSourceGitStates(initialScope);
    check('两个 Source Git 仓独立识别', gitStates.filter((state) => state.isRepository).length === 2);
    check('dirty repo 不被 clean repo 掩盖', gitStates.find((state) => state.sourceId === 'tools')?.dirtyFiles?.includes('README.md') === true
      && gitStates.find((state) => state.sourceId === 'primary')?.dirtyFiles?.length === 0);
    check('非 Git Source 不阻断', gitStates.find((state) => state.sourceId === 'docs')?.isRepository === false);

    const wrapped = wrapCommandForSandbox(
      [
        `cat ${quote([path.join(docs, 'requirements.md')])}`,
        `printf ok > ${quote([path.join(tools, 'generated.txt')])}`,
      ].join(' && '),
      {
        workingDirectory: primary,
        readOnlyRoots: [docs],
        readWriteRoots: [primary, tools],
      },
    );
    try {
      check('Seatbelt/Bubblewrap 多根读写矩阵允许合法操作', await runShell(wrapped.command, primary) === 0);
    } finally {
      wrapped.cleanup();
    }
    check('读写 Source 真实写入成功', (await readFile(path.join(tools, 'generated.txt'), 'utf8')) === 'ok');

    const denied = wrapCommandForSandbox(
      `printf denied > ${quote([path.join(docs, 'blocked.txt')])}`,
      {
        workingDirectory: primary,
        readOnlyRoots: [docs],
        readWriteRoots: [primary, tools],
      },
    );
    try {
      check('只读 Source 的 Bash 写入被 OS 沙箱拒绝', await runShell(denied.command, primary) !== 0);
    } finally {
      denied.cleanup();
    }

    const session = {
      id: 'session-history',
      title: 'history',
      type: 'chat',
      workingDirectory: primary,
      origin: { kind: 'manual' },
    } as Session;
    let engineBlocked = false;
    try {
      resolveExternalEngineLaunch(
        session,
        { kind: 'codex_cli', permissionProfile: 'read_only', origin: 'manual' },
        primary,
        initialScope,
      );
    } catch (error) {
      engineBlocked = /multiple Source roots/.test(error instanceof Error ? error.message : String(error));
    }
    check('无法安全表达多根的外部 Engine fail-closed', engineBlocked);

    await delay(10);
    console.log(`\nMulti-Source Project acceptance: ${passed} passed`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
