#!/usr/bin/env node
// ============================================================================
// Skill Registry 收录流水线：钉 SHA + 算 hash + 结构扫描 → 输出 registry 条目 JSON
//
// 用法:
//   node scripts/skill-registry-pin.mjs \
//     --repo owner/repo [--ref main] [--path skills] \
//     --skills dir-a,dir-b [--commands cmds/x.md] \
//     --name my-plugin [--display-name 显示名] [--description 描述] \
//     [--publisher "Agent Neo"] [--risk low|medium|high] [--out entry.json]
//
// 输出的条目合入 CONTROL_PLANE_SKILL_REGISTRY_JSON 的 entries 数组后，
// 按 scripts/generate-control-plane-env.mjs 的流程写 Vercel env 并部署。
// 需要代理时设 HTTPS_PROXY（GitHub API/codeload）。
// ============================================================================

import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

function parseArgs(argv) {
  const args = {
    repo: null, ref: null, path: null, skills: [], commands: [],
    name: null, displayName: null, description: null,
    publisher: 'Agent Neo', risk: null, out: null, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; return argv[i] ?? ''; };
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--repo') args.repo = next();
    else if (a === '--ref') args.ref = next();
    else if (a === '--path') args.path = next();
    else if (a === '--skills') args.skills = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--commands') args.commands = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--name') args.name = next();
    else if (a === '--display-name') args.displayName = next();
    else if (a === '--description') args.description = next();
    else if (a === '--publisher') args.publisher = next();
    else if (a === '--risk') args.risk = next();
    else if (a === '--out') args.out = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function usage() {
  return 'Usage: node scripts/skill-registry-pin.mjs --repo owner/repo --skills dir-a,dir-b --name my-plugin [--ref main] [--path sub] [--out entry.json]';
}

function parseRepo(input) {
  const m = String(input).trim().replace(/\.git$/, '')
    .match(/^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s#?]+)$/);
  if (!m) throw new Error(`Invalid --repo: ${input}`);
  return { owner: m[1], repo: m[2] };
}

async function resolveCommit(owner, repo, ref) {
  const refs = ref ? [ref] : ['main', 'master'];
  let lastError = null;
  for (const candidate of refs) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${candidate}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (res.ok) {
      const body = await res.json();
      if (typeof body.sha === 'string' && /^[0-9a-f]{40}$/i.test(body.sha)) return body.sha;
      lastError = new Error(`invalid sha for ${candidate}`);
    } else {
      lastError = new Error(`GitHub API ${res.status} for ${candidate}`);
    }
  }
  throw new Error(`Unable to resolve commit for ${owner}/${repo}: ${lastError?.message ?? ''}`);
}

async function downloadZip(owner, repo, sha) {
  const res = await fetch(`https://codeload.github.com/${owner}/${repo}/zip/${sha}`);
  if (!res.ok) throw new Error(`codeload ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ARCHIVE_BYTES) throw new Error(`archive too large: ${buf.length} bytes`);
  return buf;
}

function listZipEntries(buf) {
  // unzip -l 输出可解析且无需解压落盘；macOS/Linux 自带
  const tmp = `${process.env.TMPDIR || '/tmp'}/skill-registry-pin-${crypto.randomUUID()}.zip`;
  writeFileSync(tmp, buf);
  try {
    const out = execFileSync('unzip', ['-Z1', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter(Boolean);
  } finally {
    execFileSync('rm', ['-f', tmp]);
  }
}

function scan(entries, args) {
  const problems = [];
  // zip-slip / 绝对路径
  for (const e of entries) {
    if (e.startsWith('/') || e.includes('..')) problems.push(`suspicious zip path: ${e}`);
  }
  // 每个 skill 目录必须有 SKILL.md（zip 根含 repo-sha/ 前缀）
  const base = args.path ? `${args.path.replace(/\/+$/, '')}/` : '';
  const normalize = (rel) => rel.split('/').filter((seg) => seg && seg !== '.').join('/');
  for (const skill of args.skills) {
    const want = normalize(`${base}${skill.replace(/\/+$/, '')}/SKILL.md`);
    const hit = entries.some((e) => e.split('/').slice(1).join('/') === want);
    if (!hit) problems.push(`missing SKILL.md for skill '${skill}' (expected <root>/${want})`);
  }
  for (const cmd of args.commands) {
    const want = normalize(`${base}${cmd}`);
    if (!cmd.endsWith('.md')) problems.push(`command must be .md: ${cmd}`);
    else if (!entries.some((e) => e.split('/').slice(1).join('/') === want)) {
      problems.push(`missing command file '${cmd}' (expected <root>/${want})`);
    }
  }
  return problems;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usage()); return; }
  if (!args.repo || !args.name || args.skills.length === 0) {
    console.error(usage());
    process.exit(2);
  }
  if (args.risk && !['low', 'medium', 'high'].includes(args.risk)) {
    throw new Error(`--risk must be low|medium|high, got: ${args.risk}`);
  }

  const { owner, repo } = parseRepo(args.repo);
  console.error(`[pin] resolving ${owner}/${repo}${args.ref ? `@${args.ref}` : ''} ...`);
  const pinnedCommit = await resolveCommit(owner, repo, args.ref);
  console.error(`[pin] pinned ${pinnedCommit}`);

  const archive = await downloadZip(owner, repo, pinnedCommit);
  const contentHash = crypto.createHash('sha256').update(archive).digest('hex');
  console.error(`[pin] sha256 ${contentHash} (${archive.length} bytes)`);

  const problems = scan(listZipEntries(archive), args);
  if (problems.length > 0) {
    for (const p of problems) console.error(`[scan] FAIL ${p}`);
    process.exit(1);
  }
  console.error('[scan] ok');

  const entry = {
    name: args.name,
    ...(args.displayName ? { displayName: args.displayName } : {}),
    ...(args.description ? { description: args.description } : {}),
    repository: `${owner}/${repo}`,
    ...(args.path ? { path: args.path } : {}),
    pinnedCommit,
    contentHash,
    skills: args.skills,
    ...(args.commands.length ? { commands: args.commands } : {}),
    publisher: args.publisher,
    reviewedAt: new Date().toISOString().slice(0, 10),
    ...(args.risk ? { risk: { tier: args.risk } } : {}),
  };

  const json = JSON.stringify(entry, null, 2);
  if (args.out) {
    writeFileSync(args.out, `${json}\n`);
    console.error(`[pin] wrote ${args.out}`);
  } else {
    console.log(json);
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`[skill-registry-pin] ${error.message}`);
  process.exit(1);
});
