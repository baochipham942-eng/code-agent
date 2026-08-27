import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const guardLibrary = join(repoRoot, 'scripts', 'lib', 'tauri-slot-process-guard.sh');
const appName = 'Agent Neo Dev 3';
const appPath = `/Applications/${appName}.app`;
const appExecutable = `${appPath}/Contents/MacOS/code-agent-tauri`;

let scratch = '';
let fakeBin = '';

function writeExecutable(name: string, body: string): void {
  const path = join(fakeBin, name);
  writeFileSync(path, `#!/bin/bash\nset -eu\n${body}`);
  chmodSync(path, 0o755);
}

function runGuard(extraEnv: Record<string, string> = {}) {
  // appPath 作为 bash argv 的字面量进入调用者命令行，覆盖真实的自匹配现场形状。
  const result = spawnSync(
    'bash',
    [
      '-c',
      `source "${guardLibrary}"; export TEST_GUARD_PID=$$; refuse_if_tauri_slot_in_use "${appName}" "$1" "$2"`,
      'guard-probe',
      appPath,
      '8183',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_APP_EXECUTABLE: appExecutable,
        ...extraEnv,
      },
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tauri-slot-process-guard-'));
  fakeBin = join(scratch, 'bin');
  mkdirSync(fakeBin);

  writeExecutable('pgrep', `
if [ "\${1:-}" != "-x" ] || [ "\${2:-}" != "code-agent-tauri" ]; then
  exit 64
fi
case "\${FAKE_PGREP_MODE:-none}" in
  app) printf '%s\\n' 4242 ;;
  caller-chain) printf '%s\\n%s\\n' "$TEST_GUARD_PID" "$TEST_PARENT_PID" ;;
esac
`);

  writeExecutable('ps', `
field="\${2:-}"
pid="\${4:-}"
if [ "$field" = "ppid=" ]; then
  if [ "$pid" = "$TEST_GUARD_PID" ] && [ -n "\${TEST_PARENT_PID:-}" ]; then
    printf '%s\\n' "$TEST_PARENT_PID"
  else
    printf '%s\\n' 1
  fi
elif [ "$field" = "comm=" ]; then
  case "$pid" in
    4242) printf '%s\\n' "\${FAKE_PS_APP_COMM:-code-agent-tauri}" ;;
    5252) printf '%s\\n' node ;;
    *) printf '%s\\n' "$FAKE_APP_EXECUTABLE" ;;
  esac
fi
`);

  writeExecutable('lsof', `
if [ "\${1:-}" = "-t" ]; then
  case "\${FAKE_LISTENER_MODE:-none}" in
    port) printf '%s\\n' 5252 ;;
    caller-chain) printf '%s\\n%s\\n' "$TEST_GUARD_PID" "$TEST_PARENT_PID" ;;
  esac
  exit 0
fi
pid="\${3:-}"
printf 'p%s\\nftxt\\n' "$pid"
case "$pid" in
  4242) printf 'n%s\\n' "\${FAKE_APP_PATH:-$FAKE_APP_EXECUTABLE}" ;;
  5252) printf 'n%s\\n' /usr/local/bin/node ;;
  *) printf 'n%s\\n' "$FAKE_APP_EXECUTABLE" ;;
esac
`);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('tauri slot process guard', () => {
  it('调用者命令行含 app 路径，且候选只有自己与祖先时放行', () => {
    const result = runGuard({
      FAKE_PGREP_MODE: 'caller-chain',
      FAKE_LISTENER_MODE: 'caller-chain',
      TEST_PARENT_PID: '3333',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('同名 Tauri 进程的真实可执行路径属于本槽时拒绝，并打印 pid 与路径', () => {
    const result = runGuard({ FAKE_PGREP_MODE: 'app' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pid=4242');
    expect(result.stderr).toContain(`real_executable=${appExecutable}`);
    expect(result.stderr).toContain('criterion=app-path');
  });

  it('同名 Tauri 进程属于其他槽时放行', () => {
    const result = runGuard({
      FAKE_PGREP_MODE: 'app',
      FAKE_APP_PATH: '/Applications/Agent Neo Dev 2.app/Contents/MacOS/code-agent-tauri',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('本槽端口被监听时拒绝，并打印监听进程 pid 与真实路径', () => {
    const result = runGuard({ FAKE_LISTENER_MODE: 'port' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pid=5252');
    expect(result.stderr).toContain('real_executable=/usr/local/bin/node');
    expect(result.stderr).toContain('criterion=tcp-listen:8183');
  });
});
