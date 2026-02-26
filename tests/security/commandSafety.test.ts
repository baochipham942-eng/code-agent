import { describe, it, expect } from 'vitest';
import { isKnownSafeCommand, classifyCommand } from '../../src/main/security/commandSafety';

describe('isKnownSafeCommand', () => {
  // ========================================================================
  // 无条件安全
  // ========================================================================

  describe('unconditionally safe commands', () => {
    const safeCmds = [
      'ls',
      'ls -la',
      'ls -la /tmp',
      'pwd',
      'echo hello',
      'cat file.txt',
      'head -n 20 file.txt',
      'tail -f log.txt',
      'wc -l file.txt',
      'grep "pattern" file.txt',
      'rg "pattern" src/',
      'jq ".data" response.json',
      'which node',
      'whoami',
      'date',
      'env',
      'file image.png',
      'stat file.txt',
      'du -sh .',
      'basename /path/to/file.txt',
      'diff file1.txt file2.txt',
    ];

    for (const cmd of safeCmds) {
      it(`should be safe: ${cmd}`, () => {
        expect(isKnownSafeCommand(cmd)).toBe(true);
      });
    }
  });

  // ========================================================================
  // 条件安全
  // ========================================================================

  describe('conditionally safe commands', () => {
    // Git safe
    it('git status is safe', () => {
      expect(isKnownSafeCommand('git status')).toBe(true);
    });
    it('git log is safe', () => {
      expect(isKnownSafeCommand('git log --oneline -10')).toBe(true);
    });
    it('git diff is safe', () => {
      expect(isKnownSafeCommand('git diff HEAD~1')).toBe(true);
    });
    it('git branch is safe', () => {
      expect(isKnownSafeCommand('git branch')).toBe(true);
    });
    it('git stash list is safe', () => {
      expect(isKnownSafeCommand('git stash list')).toBe(true);
    });

    // Git unsafe
    it('git push is NOT safe', () => {
      expect(isKnownSafeCommand('git push')).toBe(false);
    });
    it('git commit is NOT safe', () => {
      expect(isKnownSafeCommand('git commit -m "msg"')).toBe(false);
    });
    it('git reset is NOT safe', () => {
      expect(isKnownSafeCommand('git reset --hard')).toBe(false);
    });
    it('git -c with external command is NOT safe', () => {
      expect(isKnownSafeCommand('git -c core.editor=vim diff')).toBe(false);
    });

    // find safe
    it('find without -exec is safe', () => {
      expect(isKnownSafeCommand('find . -name "*.ts"')).toBe(true);
    });
    it('find with -exec is NOT safe', () => {
      expect(isKnownSafeCommand('find . -name "*.tmp" -exec rm {} \\;')).toBe(false);
    });
    it('find with -delete is NOT safe', () => {
      expect(isKnownSafeCommand('find . -name "*.tmp" -delete')).toBe(false);
    });

    // npm safe
    it('npm list is safe', () => {
      expect(isKnownSafeCommand('npm list')).toBe(true);
    });
    it('npm audit is safe', () => {
      expect(isKnownSafeCommand('npm audit')).toBe(true);
    });
    it('npm install is NOT safe', () => {
      expect(isKnownSafeCommand('npm install')).toBe(false);
    });
    it('npm publish is NOT safe', () => {
      expect(isKnownSafeCommand('npm publish')).toBe(false);
    });

    // sed safe
    it('sed -n is safe', () => {
      expect(isKnownSafeCommand('sed -n "5p" file.txt')).toBe(true);
    });
    it('sed -i is NOT safe', () => {
      expect(isKnownSafeCommand('sed -i "s/old/new/" file.txt')).toBe(false);
    });

    // docker safe
    it('docker ps is safe', () => {
      expect(isKnownSafeCommand('docker ps')).toBe(true);
    });
    it('docker rm is NOT safe', () => {
      expect(isKnownSafeCommand('docker rm container')).toBe(false);
    });

    // tsc safe
    it('tsc --noEmit is safe', () => {
      expect(isKnownSafeCommand('tsc --noEmit')).toBe(true);
    });
  });

  // ========================================================================
  // 复合命令
  // ========================================================================

  describe('compound commands', () => {
    it('safe && safe is safe', () => {
      expect(isKnownSafeCommand('ls && pwd')).toBe(true);
    });
    it('safe | safe is safe', () => {
      expect(isKnownSafeCommand('cat file.txt | grep pattern')).toBe(true);
    });
    it('safe && unsafe is NOT safe', () => {
      expect(isKnownSafeCommand('ls && rm file.txt')).toBe(false);
    });
    it('git status && git log is safe', () => {
      expect(isKnownSafeCommand('git status && git log --oneline -5')).toBe(true);
    });
  });

  // ========================================================================
  // 输出重定向
  // ========================================================================

  describe('output redirection', () => {
    it('redirect to file is NOT safe', () => {
      expect(isKnownSafeCommand('echo hello > file.txt')).toBe(false);
    });
    it('append to file is NOT safe', () => {
      expect(isKnownSafeCommand('echo hello >> file.txt')).toBe(false);
    });
    it('redirect to /dev/null is safe', () => {
      expect(isKnownSafeCommand('ls > /dev/null')).toBe(true);
    });
  });

  // ========================================================================
  // 不安全 shell 特性
  // ========================================================================

  describe('unsafe shell features', () => {
    it('command substitution $() is NOT safe', () => {
      expect(isKnownSafeCommand('echo $(whoami)')).toBe(false);
    });
    it('backtick substitution is NOT safe', () => {
      expect(isKnownSafeCommand('echo `whoami`')).toBe(false);
    });
  });

  // ========================================================================
  // 危险命令
  // ========================================================================

  describe('dangerous commands', () => {
    it('rm is NOT safe', () => {
      expect(isKnownSafeCommand('rm file.txt')).toBe(false);
    });
    it('rm -rf is NOT safe', () => {
      expect(isKnownSafeCommand('rm -rf /')).toBe(false);
    });
    it('chmod is NOT safe', () => {
      expect(isKnownSafeCommand('chmod 777 file.txt')).toBe(false);
    });
    it('mv is NOT safe', () => {
      expect(isKnownSafeCommand('mv old.txt new.txt')).toBe(false);
    });
    it('cp is NOT safe', () => {
      expect(isKnownSafeCommand('cp src.txt dst.txt')).toBe(false);
    });
    it('sudo anything is NOT safe', () => {
      expect(isKnownSafeCommand('sudo ls')).toBe(false);
    });
    it('kill is NOT safe', () => {
      expect(isKnownSafeCommand('kill -9 1234')).toBe(false);
    });
    it('mkfs is NOT safe', () => {
      expect(isKnownSafeCommand('mkfs.ext4 /dev/sda1')).toBe(false);
    });
    it('dd is NOT safe', () => {
      expect(isKnownSafeCommand('dd if=/dev/zero of=/dev/sda')).toBe(false);
    });
  });

  // ========================================================================
  // 边界场景 — 引号、空格、特殊字符
  // ========================================================================

  describe('edge cases', () => {
    it('empty command is NOT safe', () => {
      expect(isKnownSafeCommand('')).toBe(false);
    });
    it('whitespace only is NOT safe', () => {
      expect(isKnownSafeCommand('   ')).toBe(false);
    });
    it('command with leading spaces is safe', () => {
      expect(isKnownSafeCommand('  ls -la  ')).toBe(true);
    });
    it('command with single-quoted args is safe', () => {
      expect(isKnownSafeCommand("grep 'hello world' file.txt")).toBe(true);
    });
    it('command with double-quoted args is safe', () => {
      expect(isKnownSafeCommand('grep "hello world" file.txt')).toBe(true);
    });
    it('command with quoted path containing spaces', () => {
      expect(isKnownSafeCommand('cat "/path/with spaces/file.txt"')).toBe(true);
    });
    it('pipe chain of safe commands', () => {
      expect(isKnownSafeCommand('cat file.txt | grep pattern | sort | uniq -c | head -10')).toBe(true);
    });
    it('long pipe with one unsafe command fails', () => {
      expect(isKnownSafeCommand('cat file.txt | grep pattern | tee output.txt')).toBe(false);
    });
    it('semicolon separated safe commands', () => {
      expect(isKnownSafeCommand('ls; pwd; date')).toBe(true);
    });
    it('|| separated safe commands', () => {
      expect(isKnownSafeCommand('cat file.txt || echo "not found"')).toBe(true);
    });
  });

  // ========================================================================
  // 真实使用场景 — 模型常见的命令
  // ========================================================================

  describe('real-world model commands', () => {
    it('git status && git diff is safe', () => {
      expect(isKnownSafeCommand('git status && git diff')).toBe(true);
    });
    it('git log with format is safe', () => {
      expect(isKnownSafeCommand('git log --oneline --graph -20')).toBe(true);
    });
    it('git ls-files is safe', () => {
      expect(isKnownSafeCommand('git ls-files')).toBe(true);
    });
    it('git blame is safe', () => {
      expect(isKnownSafeCommand('git blame src/main.ts')).toBe(true);
    });
    it('npm list --depth=0 is safe', () => {
      expect(isKnownSafeCommand('npm list --depth=0')).toBe(true);
    });
    it('find with type and name is safe', () => {
      expect(isKnownSafeCommand('find src -name "*.test.ts" -type f')).toBe(true);
    });
    it('wc -l with glob is safe', () => {
      expect(isKnownSafeCommand('wc -l *.ts')).toBe(true);
    });
    it('du -sh node_modules is safe', () => {
      expect(isKnownSafeCommand('du -sh node_modules')).toBe(true);
    });
    it('grep -rn pattern src/ is safe', () => {
      expect(isKnownSafeCommand('grep -rn "TODO" src/')).toBe(true);
    });
    it('jq complex query is safe', () => {
      expect(isKnownSafeCommand('jq ".dependencies | keys" package.json')).toBe(true);
    });
    it('docker ps -a is safe', () => {
      expect(isKnownSafeCommand('docker ps -a')).toBe(true);
    });
    it('docker images is safe', () => {
      expect(isKnownSafeCommand('docker images')).toBe(true);
    });

    // 常见的不安全命令（模型会尝试执行）
    it('npm install is NOT safe', () => {
      expect(isKnownSafeCommand('npm install lodash')).toBe(false);
    });
    it('npm run build is NOT safe', () => {
      expect(isKnownSafeCommand('npm run build')).toBe(false);
    });
    it('python3 script.py is NOT safe', () => {
      expect(isKnownSafeCommand('python3 script.py')).toBe(false);
    });
    it('node script.js is NOT safe', () => {
      expect(isKnownSafeCommand('node script.js')).toBe(false);
    });
    it('mkdir is NOT safe', () => {
      expect(isKnownSafeCommand('mkdir -p new_dir')).toBe(false);
    });
    it('touch is NOT safe', () => {
      expect(isKnownSafeCommand('touch new_file.txt')).toBe(false);
    });
    it('wget is NOT safe by default', () => {
      expect(isKnownSafeCommand('wget https://example.com')).toBe(false);
    });
    it('curl with -o is NOT safe', () => {
      expect(isKnownSafeCommand('curl -o output.html https://example.com')).toBe(false);
    });
    it('git add is NOT safe', () => {
      expect(isKnownSafeCommand('git add .')).toBe(false);
    });
    it('git checkout is NOT safe', () => {
      expect(isKnownSafeCommand('git checkout -b new-branch')).toBe(false);
    });
    it('git merge is NOT safe', () => {
      expect(isKnownSafeCommand('git merge feature-branch')).toBe(false);
    });
    it('git stash pop is NOT safe', () => {
      expect(isKnownSafeCommand('git stash pop')).toBe(false);
    });
  });

  // ========================================================================
  // bash -c 包裹解析
  // ========================================================================

  describe('bash -c wrapper parsing', () => {
    it('bash -c with safe command is safe', () => {
      expect(isKnownSafeCommand('bash -c "ls -la"')).toBe(true);
    });
    it('bash -lc with safe command is safe', () => {
      expect(isKnownSafeCommand('bash -lc "git status"')).toBe(true);
    });
    it('sh -c with safe command is safe', () => {
      expect(isKnownSafeCommand('sh -c "pwd"')).toBe(true);
    });
    it('bash -c with unsafe command is NOT safe', () => {
      expect(isKnownSafeCommand('bash -c "rm -rf /tmp"')).toBe(false);
    });
  });

  // ========================================================================
  // pnpm/yarn 覆盖
  // ========================================================================

  describe('package managers', () => {
    it('yarn list is safe', () => {
      expect(isKnownSafeCommand('yarn list')).toBe(true);
    });
    it('yarn audit is safe', () => {
      expect(isKnownSafeCommand('yarn audit')).toBe(true);
    });
    it('yarn add is NOT safe', () => {
      expect(isKnownSafeCommand('yarn add lodash')).toBe(false);
    });
    it('pnpm list is safe', () => {
      expect(isKnownSafeCommand('pnpm list')).toBe(true);
    });
    it('pnpm install is NOT safe', () => {
      expect(isKnownSafeCommand('pnpm install')).toBe(false);
    });
  });
});

describe('classifyCommand', () => {
  it('classifies safe commands', () => {
    expect(classifyCommand('ls')).toBe('safe');
    expect(classifyCommand('git status')).toBe('safe');
  });

  it('classifies conditional commands', () => {
    expect(classifyCommand('git push')).toBe('conditional');
    expect(classifyCommand('npm install')).toBe('conditional');
  });

  it('classifies unknown commands', () => {
    expect(classifyCommand('rm -rf /')).toBe('unknown');
    expect(classifyCommand('some-unknown-binary')).toBe('unknown');
  });
});
