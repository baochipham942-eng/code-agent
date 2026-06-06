#!/usr/bin/env node
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    outDir: null,
    keyId: 'production-2026-05-17',
    version: 'production-2026-05-17.1',
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--out') {
      args.outDir = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--key-id') {
      args.keyId = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (arg === '--version') {
      args.version = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.help && (!args.keyId.trim() || !args.version.trim())) {
    throw new Error('--key-id and --version must be non-empty');
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/generate-control-plane-env.mjs [--out <dir>] [--key-id <id>] [--version <version>]',
    '',
    'Writes a local env bundle for Vercel control-plane setup.',
    'It does not write to Vercel or deploy anything.',
  ].join('\n');
}

function buildPayloads(version, now = new Date()) {
  const updatedAt = now.toISOString();
  return {
    cloudConfig: {
      version,
      prompts: {},
      skills: [],
      toolMeta: {},
      featureFlags: {},
      uiStrings: { zh: {}, en: {} },
      rules: {},
      mcpServers: [],
      entitlement: {
        status: 'revoked',
        plan: 'unauthenticated',
        capabilities: [],
        reason: 'production_default_locked',
      },
    },
    promptRegistry: {
      version,
      prompts: {},
    },
    capabilityRegistry: {
      version,
      items: [],
      revokedIds: [],
    },
    agentEngineModelCatalog: {
      version,
      updatedAt,
      engines: [
        {
          kind: 'codex_cli',
          defaultModel: 'gpt-5.5',
          updatedAt,
          models: [
            {
              id: 'gpt-5.5',
              label: 'GPT-5.5',
              capabilities: ['code', 'reasoning', 'longContext'],
              recommended: true,
              updatedAt,
            },
            {
              id: 'gpt-5.4',
              label: 'GPT-5.4',
              capabilities: ['code', 'reasoning', 'longContext'],
              updatedAt,
            },
            {
              id: 'gpt-5.4-mini',
              label: 'GPT-5.4 Mini',
              capabilities: ['code', 'fast', 'reasoning'],
              updatedAt,
            },
            {
              id: 'gpt-5.3-codex',
              label: 'GPT-5.3 Codex',
              capabilities: ['code', 'reasoning', 'longContext'],
              updatedAt,
            },
            {
              id: 'gpt-5.3-codex-spark',
              label: 'GPT-5.3 Codex Spark',
              capabilities: ['code', 'fast', 'reasoning'],
              updatedAt,
            },
            {
              id: 'gpt-5.2',
              label: 'GPT-5.2',
              capabilities: ['code', 'reasoning', 'longContext'],
              updatedAt,
            },
          ],
        },
        {
          kind: 'claude_code',
          defaultModel: 'sonnet',
          updatedAt,
          models: [
            {
              id: 'sonnet',
              label: 'Claude Sonnet (latest alias)',
              capabilities: ['code', 'reasoning', 'longContext'],
              recommended: true,
              updatedAt,
            },
            {
              id: 'opus',
              label: 'Claude Opus (latest alias)',
              capabilities: ['code', 'reasoning', 'longContext'],
              updatedAt,
            },
          ],
        },
      ],
    },
    rendererBundleRollout: {
      version,
      channel: 'latest',
      rolloutPercent: 100,
    },
  };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildPostApplyCommands(repoRoot = REPO_ROOT) {
  return [
    `cd ${shellQuote(repoRoot)}`,
    'vercel deploy --prod --yes',
    'npm run renderer:verify-production -- --skip-renderer-bundle --retry-attempts 12 --retry-delay-ms 30000',
  ].join('\n');
}

function buildVercelEnvCommands({ targetDir, keyId, repoRoot = REPO_ROOT }) {
  const keyIdFile = join(targetDir, 'control-plane-key-id.txt');
  const ttlFile = join(targetDir, 'control-plane-ttl-seconds.txt');
  return [
    `cd ${shellQuote(repoRoot)}`,
    `vercel env add CONTROL_PLANE_PRIVATE_KEY production --force --yes < ${shellQuote(join(targetDir, 'private.pem'))}`,
    `vercel env add CONTROL_PLANE_KEY_ID production --force --yes < ${shellQuote(keyIdFile)}`,
    `vercel env add CONTROL_PLANE_TTL_SECONDS production --force --yes < ${shellQuote(ttlFile)}`,
    `vercel env add CONTROL_PLANE_CLOUD_CONFIG_JSON production --force --yes < ${shellQuote(join(targetDir, 'cloud-config.json'))}`,
    `vercel env add CONTROL_PLANE_PROMPT_REGISTRY_JSON production --force --yes < ${shellQuote(join(targetDir, 'prompt-registry.json'))}`,
    `vercel env add CONTROL_PLANE_CAPABILITY_REGISTRY_JSON production --force --yes < ${shellQuote(join(targetDir, 'capability-registry.json'))}`,
    `vercel env add CONTROL_PLANE_AGENT_ENGINE_MODEL_CATALOG_JSON production --force --yes < ${shellQuote(join(targetDir, 'agent-engine-model-catalog.json'))}`,
    `vercel env add CONTROL_PLANE_RENDERER_BUNDLE_ROLLOUT_JSON production --force --yes < ${shellQuote(join(targetDir, 'renderer-bundle-rollout.json'))}`,
    `vercel env add CODE_AGENT_CONTROL_PLANE_KEY_ID production --force --yes < ${shellQuote(keyIdFile)}`,
    `vercel env add CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY production --force --yes < ${shellQuote(join(targetDir, 'public.pem'))}`,
    `vercel env add CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS production --force --yes < ${shellQuote(join(targetDir, 'public-keys.json'))}`,
  ].join('\n');
}

export function generateControlPlaneEnvBundle({
  outDir,
  keyId,
  version,
  now = new Date(),
}) {
  const targetDir = resolve(outDir ?? join(
    tmpdir(),
    `code-agent-control-plane-env-${now.toISOString().replace(/[:.]/g, '-')}`,
  ));
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const payloads = buildPayloads(version, now);

  writeFileSync(join(targetDir, 'private.pem'), privatePem, { mode: 0o600 });
  writeFileSync(join(targetDir, 'public.pem'), publicPem, { mode: 0o600 });
  writeFileSync(join(targetDir, 'control-plane-key-id.txt'), `${keyId}\n`, { mode: 0o600 });
  writeFileSync(join(targetDir, 'control-plane-ttl-seconds.txt'), '3600\n', { mode: 0o600 });
  writeJson(join(targetDir, 'public-keys.json'), { [keyId]: publicPem });
  writeJson(join(targetDir, 'cloud-config.json'), payloads.cloudConfig);
  writeJson(join(targetDir, 'prompt-registry.json'), payloads.promptRegistry);
  writeJson(join(targetDir, 'capability-registry.json'), payloads.capabilityRegistry);
  writeJson(join(targetDir, 'agent-engine-model-catalog.json'), payloads.agentEngineModelCatalog);
  writeJson(join(targetDir, 'renderer-bundle-rollout.json'), payloads.rendererBundleRollout);
  writeFileSync(join(targetDir, 'vercel-env-commands.txt'), buildVercelEnvCommands({ targetDir, keyId }), { mode: 0o600 });
  writeFileSync(join(targetDir, 'post-apply-commands.txt'), buildPostApplyCommands(), { mode: 0o600 });

  return {
    targetDir,
    keyId,
    version,
    files: [
      'private.pem',
      'public.pem',
      'control-plane-key-id.txt',
      'control-plane-ttl-seconds.txt',
      'public-keys.json',
      'cloud-config.json',
      'prompt-registry.json',
      'capability-registry.json',
      'agent-engine-model-catalog.json',
      'renderer-bundle-rollout.json',
      'vercel-env-commands.txt',
      'post-apply-commands.txt',
    ].map((file) => join(targetDir, file)),
  };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`[generate-control-plane-env] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = generateControlPlaneEnvBundle({
    outDir: args.outDir,
    keyId: args.keyId,
    version: args.version,
  });
  console.log(`[generate-control-plane-env] wrote ${result.files.length} file(s) to ${result.targetDir}`);
  console.log(`[generate-control-plane-env] review ${result.targetDir}/vercel-env-commands.txt before writing production env`);
  console.log(`[generate-control-plane-env] after applying env, run ${result.targetDir}/post-apply-commands.txt`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2));
}
