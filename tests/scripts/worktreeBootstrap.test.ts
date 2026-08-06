// worktree-bootstrap.sh 的行为测试——用 mkdtemp 造假「主树」与假「worktree」真跑脚本。
//
// 核心不变量（构建提速批3，2026-08-06）：
//   - 只读构建输入（node_modules / rtk / uv / poppler）必须是**软链**；
//   - 构建期会被写的输入（dist/native、dist/bundled-node、4 个 swift helper）
//     必须是**实体拷贝**，绝不允许是软链（软链会写穿透污染主树）；
//   - 幂等、fail-closed、绝不写主树。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SCRIPT = join(repoRoot, 'scripts', 'worktree-bootstrap.sh');

// 与 scripts/worktree-bootstrap.sh 里的清单保持一致；改脚本清单时必须同步这里。
const LINK_ITEMS = ['node_modules', 'scripts/rtk', 'scripts/uv', 'scripts/poppler'];
const COPY_ITEMS = [
  'dist/native',
  'dist/bundled-node',
  'scripts/system-audio-capture',
  'scripts/voice-aec-io',
  'scripts/vision-ocr',
  'scripts/vision-tagger',
];
const ALL_ITEMS = [...LINK_ITEMS, ...COPY_ITEMS];

let scratch = '';
let source = '';
let target = '';

function writeFake(payloadDir: string, rel: string): void {
  const abs = join(payloadDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `fake payload for ${rel}\n`);
}

// 造一个迷你「主树」：所有构建输入都是带哨兵文件的小目录/文件，不碰真实的几百 MB。
function makeSourceTree(dir: string): void {
  mkdirSync(dir, { recursive: true });
  // 主树的 .git 是目录（与 linked worktree 的指针文件相对），顺手造上以防回归。
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFake(dir, 'node_modules/some-pkg/index.js');
  writeFake(dir, 'scripts/rtk');
  writeFake(dir, 'scripts/uv');
  writeFake(dir, 'scripts/poppler/bin/pdftoppm');
  writeFake(dir, 'dist/native/index.node');
  writeFake(dir, 'dist/bundled-node/bin/node');
  writeFake(dir, 'scripts/system-audio-capture');
  writeFake(dir, 'scripts/voice-aec-io');
  writeFake(dir, 'scripts/vision-ocr');
  writeFake(dir, 'scripts/vision-tagger');
}

// 造一个迷你「目标 worktree」：.git 必须是指针**文件**（linked worktree 的判别特征）。
function makeTargetTree(dir: string, cuaExitCode = 0): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.git'), 'gitdir: /fake/main/.git/worktrees/fake\n');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts', 'stage-cua-driver-resource.sh'),
    `#!/usr/bin/env bash\necho "[stub] stage-cua exit ${cuaExitCode}"\nexit ${cuaExitCode}\n`,
  );
}

function runBootstrap(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runOk(extraArgs: string[] = []) {
  const result = runBootstrap([target, '--source', source, ...extraArgs]);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result;
}

// 递归快照一棵树的（相对路径 -> 类型:内容），用来证明「绝不写主树」。
function snapshotTree(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    for (const name of readdirSync(abs)) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const stat = lstatSync(join(root, childRel));
      if (stat.isSymbolicLink()) {
        entries.set(childRel, `symlink:${readlinkSync(join(root, childRel))}`);
      } else if (stat.isDirectory()) {
        entries.set(childRel, 'dir');
        walk(childRel);
      } else {
        entries.set(childRel, `file:${readFileSync(join(root, childRel), 'utf8')}`);
      }
    }
  };
  walk('');
  return entries;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'worktree-bootstrap-'));
  // 脚本内部用 pwd -P 归一化成物理路径，断言比对的 link 目标必须同样归一化
  // （macOS 上 /var 是 /private/var 的软链，mkdtemp 给的是逻辑路径）。
  makeSourceTree(join(scratch, 'main'));
  makeTargetTree(join(scratch, 'wt'));
  source = realpathSync(join(scratch, 'main'));
  target = realpathSync(join(scratch, 'wt'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('worktree-bootstrap.sh', () => {
  it('首次引导：只读项是软链、会被写的项是实体拷贝，且打逐项输出与汇总', () => {
    const result = runOk();
    for (const rel of ALL_ITEMS) {
      expect(result.stdout).toContain(rel);
    }
    expect(result.stdout).toContain(`link=${LINK_ITEMS.length} copy=${COPY_ITEMS.length} skip=0`);

    for (const rel of LINK_ITEMS) {
      const dst = join(target, rel);
      expect(lstatSync(dst).isSymbolicLink(), `${rel} 必须是软链`).toBe(true);
      expect(readlinkSync(dst)).toBe(join(source, rel));
    }
    // 本批核心不变量：拷贝项必须是实体，绝不能是软链。
    for (const rel of COPY_ITEMS) {
      const dst = join(target, rel);
      expect(existsSync(dst), `${rel} 必须存在`).toBe(true);
      expect(lstatSync(dst).isSymbolicLink(), `${rel} 绝不能是软链（写穿透污染主树）`).toBe(false);
    }
    // 拷过去的内容与主树一致。
    expect(readFileSync(join(target, 'dist/bundled-node/bin/node'), 'utf8')).toBe(
      readFileSync(join(source, 'dist/bundled-node/bin/node'), 'utf8'),
    );
  });

  it('幂等：连跑两次退出码都是 0，第二遍全部 skip 且链接/拷贝形态不变', () => {
    runOk();
    const first = snapshotTree(target);
    const second = runOk();
    expect(second.stdout).toContain(`link=0 copy=0 skip=${ALL_ITEMS.length}`);
    expect(snapshotTree(target)).toEqual(first);
    expect(lstatSync(join(target, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(target, 'dist/native')).isSymbolicLink()).toBe(false);
  });

  it('目标不是链接出来的 worktree（.git 不是指针文件）→ 拒绝执行', () => {
    rmSync(join(target, '.git'));
    mkdirSync(join(target, '.git')); // 主树形态：.git 是目录
    const result = runBootstrap([target, '--source', source]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('不是一个链接出来的 git worktree');
    expect(existsSync(join(target, 'node_modules'))).toBe(false);
  });

  it('目标 == 源 → 拒绝执行', () => {
    // 让「源」也长得像 linked worktree（.git 指针文件），确保命中的是判等闸而不是形态闸。
    rmSync(join(source, '.git'), { recursive: true, force: true });
    writeFileSync(join(source, '.git'), 'gitdir: /fake\n');
    const result = runBootstrap([source, '--source', source]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('同一路径');
  });

  it('源缺件 → 非零退出，错误信息指名缺的路径与补救命令，且不动目标', () => {
    rmSync(join(source, 'dist/bundled-node'), { recursive: true, force: true });
    const result = runBootstrap([target, '--source', source]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dist/bundled-node');
    expect(result.stderr).toContain('prepare-bundled-node.mjs');
    // fail-closed：预检没过就什么都不引导。
    for (const rel of ALL_ITEMS) {
      expect(existsSync(join(target, rel)), `${rel} 不应被引导`).toBe(false);
    }
  });

  it('绝不写主树：完整跑一遍前后主树内容逐字节一致', () => {
    const before = snapshotTree(source);
    runOk();
    expect(snapshotTree(source)).toEqual(before);
  });

  it('拷贝项上挂着软链（手工整过的写穿透雷）→ 拆链换实体拷贝', () => {
    rmSync(join(target, 'dist'), { recursive: true, force: true });
    mkdirSync(join(target, 'dist'), { recursive: true });
    symlinkSync(join(source, 'dist/native'), join(target, 'dist/native'));
    const result = runOk();
    expect(result.stdout).toContain('拆除软链改实体拷贝');
    expect(lstatSync(join(target, 'dist/native')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, 'dist/native/index.node'), 'utf8')).toContain('fake payload');
  });

  it('cua helper 就位失败不致命：整体退出 0，但必须明着 WARN', () => {
    writeFileSync(
      join(target, 'scripts', 'stage-cua-driver-resource.sh'),
      '#!/usr/bin/env bash\nexit 1\n',
    );
    const result = runBootstrap([target, '--source', source]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('WARN');
    expect(result.stderr).toContain('cua');
  });
});
