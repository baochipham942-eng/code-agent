import { describe, expect, it } from 'vitest';
import {
  buildClaudeResumeArgs,
  buildCodexResumeArgs,
  createClaudeResumeLaunch,
  createCodexResumeLaunch,
} from '../../../src/host/services/agentEngine/externalEngineResumeBuilders';

const identity = {
  runId: 'logical-run',
  sessionId: 'neo-session',
  attempt: 2,
  ownerEpoch: 7,
  externalSessionId: 'external-session-123',
  cwd: '/tmp/workspace',
  permissionProfile: 'read_only' as const,
};

describe('external engine resume builders', () => {
  it('matches Codex 0.144.1 exec resume help and preserves read-only JSONL execution', () => {
    expect(buildCodexResumeArgs({ ...identity, model: 'gpt-5', lastMessagePath: '/tmp/last.md' })).toEqual([
      'exec', 'resume', '--json', '-c', 'sandbox_mode="read-only"', '--model', 'gpt-5',
      '--skip-git-repo-check', '--output-last-message', '/tmp/last.md', 'external-session-123',
    ]);
  });

  it('uses stdin only for an explicit Codex continuation and never places it in argv or summary', () => {
    const secret = 'continue with token=secret apiKey=hidden cookie=private';
    const launch = createCodexResumeLaunch({ ...identity, continuationInput: secret, lastMessagePath: '/tmp/last.md' });
    expect(launch.args.at(-1)).toBe('-');
    expect(launch.stdin).toBe(secret);
    expect(JSON.stringify(launch.args)).not.toContain(secret);
    expect(launch.commandSummary).not.toMatch(/secret|hidden|private/);
  });

  it('matches Claude Code 2.1.207 print resume help and preserves plan/read-only stream-json mode', () => {
    const args = buildClaudeResumeArgs({ ...identity, model: 'sonnet' });
    expect(args).toEqual(expect.arrayContaining([
      '-p', '--resume', 'external-session-123', '--output-format', 'stream-json',
      '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep,LS',
    ]));
    expect(args).not.toContain('--no-session-persistence');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('omits prompt input for a no-continuation Claude resume', () => {
    const launch = createClaudeResumeLaunch(identity);
    expect(launch.stdin).toBeUndefined();
    expect(launch.commandSummary).toContain('--resume');
    expect(launch.commandSummary).not.toContain(identity.externalSessionId);
  });

  it('fails closed without external session, recovered attempt, owner epoch, cwd, or read-only permission', () => {
    const invalid = [
      { ...identity, externalSessionId: '' },
      { ...identity, attempt: 0 },
      { ...identity, ownerEpoch: 0 },
      { ...identity, cwd: '' },
      { ...identity, permissionProfile: 'workspace_write' as const },
    ];
    for (const input of invalid) {
      expect(() => buildClaudeResumeArgs(input)).toThrow();
    }
  });
});
