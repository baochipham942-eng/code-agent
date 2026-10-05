import { createHmac } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CHECK = path.join(ROOT, 'scripts/security/check-sensitive-hashes.mjs');
const HASHER = path.join(ROOT, 'scripts/security/hash-sensitive.mjs');
const SALT = 'unit-test-salt';

function hmac(value: string, salt = SALT): string {
  return createHmac('sha256', salt).update(value.normalize('NFC').trim().toLowerCase(), 'utf8').digest('hex');
}

function runCheck(
  args: string[],
  env: { salt?: string; hashes?: string } = {},
  cwd = ROOT,
) {
  return spawnSync(process.execPath, [CHECK, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      SENSITIVE_SALT: env.salt ?? '',
      SENSITIVE_HASHES: env.hashes ?? '',
    },
  });
}

function runHasher(value: string, salt = SALT) {
  return spawnSync(process.execPath, [HASHER, value], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SENSITIVE_SALT: salt },
  });
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
}

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'sensitive-hash-'));
}

describe('check-sensitive-hashes', () => {
  it('exits non-zero on a synthetic name token and does not echo the text', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, 'Hello Zork Quillfeather\n');
      const digest = hmac('zork');
      const result = runCheck([file], { salt: SALT, hashes: digest });
      expect(result.status).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.stdout).toContain(`note.txt:1 ${digest.slice(0, 12)}`);
      expect(output).not.toContain(digest);
      expect(output.toLowerCase()).not.toContain('zork');
      expect(output.toLowerCase()).not.toContain('quillfeather');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 when SENSITIVE_HASHES is empty', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, 'Hello Zork Quillfeather\n');
      const result = runCheck([file], { salt: SALT, hashes: '' });
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/SENSITIVE_SALT/);
      expect(result.stderr).toMatch(/SENSITIVE_HASHES/);
      expect(`${result.stdout}${result.stderr}`.toLowerCase()).not.toContain('zork');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 when unset and exits 2 with --require', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, 'plain\n');
      expect(runCheck([file], {}).status).toBe(0);
      const required = runCheck(['--require', file], {});
      expect(required.status).toBe(2);
      expect(required.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a hash list that is not 64-character hex', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, 'Zork\n');
      const result = runCheck([file], { salt: SALT, hashes: `${hmac('zork')},not-a-hash` });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('not-a-hash');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('matches email, IPv4, hostname, and a CJK window without echoing them', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, [
        'mail Zork@Example.Invalid',
        'ip 10.255.255.1',
        'host Gateway.Example.Invalid',
        'cjk 甲乙丙丁',
      ].join('\n'));
      const digests = [
        hmac('zork@example.invalid'),
        hmac('10.255.255.1'),
        hmac('gateway.example.invalid'),
        hmac('乙丙'),
      ];
      const result = runCheck([file], { salt: SALT, hashes: digests.join(',') });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`note.txt:1 ${digests[0].slice(0, 12)}`);
      expect(result.stdout).toContain(`note.txt:2 ${digests[1].slice(0, 12)}`);
      expect(result.stdout).toContain(`note.txt:3 ${digests[2].slice(0, 12)}`);
      expect(result.stdout).toContain(`note.txt:4 ${digests[3].slice(0, 12)}`);
      const output = `${result.stdout}${result.stderr}`.toLowerCase();
      expect(output).not.toContain('zork@example.invalid');
      expect(output).not.toContain('10.255.255.1');
      expect(output).not.toContain('gateway.example.invalid');
      expect(output).not.toContain('乙丙');
      for (const digest of digests) expect(output).not.toContain(digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not treat a spaced name as one candidate', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, 'Zork Quillfeather\n');
      const result = runCheck([file], { salt: SALT, hashes: hmac('zork quillfeather') });
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a newline-separated hash and a trimmed salt', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, 'token ZORK\n');
      const result = runCheck([file], { salt: `  ${SALT}  `, hashes: `\n${hmac('zork')}\n` });
      expect(result.status).toBe(1);
      expect(result.stdout.toLowerCase()).not.toContain('zork');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('misses when the salt differs', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, 'Zork\n');
      const result = runCheck([file], { salt: 'other-salt', hashes: hmac('zork') });
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips node_modules and dist unless dist is the target', () => {
    const dir = tempDir();
    try {
      writeFileSync(path.join(dir, 'keep.txt'), 'plain\n');
      mkdirSync(path.join(dir, 'node_modules'));
      writeFileSync(path.join(dir, 'node_modules', 'hidden.txt'), 'Zork\n');
      mkdirSync(path.join(dir, 'dist'));
      writeFileSync(path.join(dir, 'dist', 'built.txt'), 'Zork\n');
      const quiet = runCheck([dir], { salt: SALT, hashes: hmac('zork') });
      expect(quiet.status).toBe(0);
      const built = runCheck([path.join(dir, 'dist')], { salt: SALT, hashes: hmac('zork') });
      expect(built.status).toBe(1);
      expect(built.stdout).toContain('built.txt:1');
      expect(built.stdout.toLowerCase()).not.toContain('zork');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans staged blobs and ignores an unstaged edit', () => {
    const dir = tempDir();
    try {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'unit@example.invalid']);
      git(dir, ['config', 'user.name', 'Unit Tester']);
      writeFileSync(path.join(dir, 'note.txt'), 'clean\n');
      git(dir, ['add', 'note.txt']);
      git(dir, ['commit', '-m', 'init']);
      writeFileSync(path.join(dir, 'note.txt'), 'Zork\n');
      const unstaged = runCheck(['--staged'], { salt: SALT, hashes: hmac('zork') }, dir);
      expect(unstaged.status).toBe(0);
      git(dir, ['add', 'note.txt']);
      const staged = runCheck(['--staged'], { salt: SALT, hashes: hmac('zork') }, dir);
      expect(staged.status).toBe(1);
      expect(staged.stdout).toContain(`note.txt:1 ${hmac('zork').slice(0, 12)}`);
      expect(`${staged.stdout}${staged.stderr}`.toLowerCase()).not.toContain('zork');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans added history lines and not an uncommitted edit', () => {
    const dir = tempDir();
    try {
      git(dir, ['init']);
      git(dir, ['config', 'user.email', 'unit@example.invalid']);
      git(dir, ['config', 'user.name', 'Unit Tester']);
      writeFileSync(path.join(dir, 'note.txt'), 'alpha\nZork Quillfeather\nomega\n');
      git(dir, ['add', 'note.txt']);
      git(dir, ['commit', '-m', 'add note']);
      const digest = hmac('quillfeather');
      const hit = runCheck(['--git-history'], { salt: SALT, hashes: digest }, dir);
      expect(hit.status).toBe(1);
      expect(hit.stdout).toContain(`note.txt:2 ${digest.slice(0, 12)}`);
      expect(`${hit.stdout}${hit.stderr}`.toLowerCase()).not.toContain('quillfeather');
      expect(`${hit.stdout}${hit.stderr}`.toLowerCase()).not.toContain('zork');

      writeFileSync(path.join(dir, 'other.txt'), 'Plume\n');
      const pending = runCheck(['--git-history'], { salt: SALT, hashes: hmac('plume') }, dir);
      expect(pending.status).toBe(0);
      expect(`${pending.stdout}${pending.stderr}`.toLowerCase()).not.toContain('plume');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hash-sensitive', () => {
  it('prints the HMAC of the normalized string and not the string', () => {
    const digest = hmac('zork');
    const result = runHasher('  Zork  ');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${digest}\n`);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).not.toContain('zork');
  });

  it('warns when the argument is not itself a scanner candidate', () => {
    const result = runHasher('Zork Quillfeather');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${hmac('zork quillfeather')}\n`);
    expect(result.stderr).toMatch(/whitespace or punctuation/);
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).not.toContain('zork');
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).not.toContain('quillfeather');
  });

  it('exits 2 without a salt', () => {
    const result = spawnSync(process.execPath, [HASHER, 'Zork'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SENSITIVE_SALT: '' },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.toLowerCase()).not.toContain('zork');
  });
});
