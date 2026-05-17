#!/usr/bin/env node
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

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

function buildPayloads(version) {
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
  };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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
  const payloads = buildPayloads(version);

  writeFileSync(join(targetDir, 'private.pem'), privatePem, { mode: 0o600 });
  writeFileSync(join(targetDir, 'public.pem'), publicPem, { mode: 0o600 });
  writeJson(join(targetDir, 'public-keys.json'), { [keyId]: publicPem });
  writeJson(join(targetDir, 'cloud-config.json'), payloads.cloudConfig);
  writeJson(join(targetDir, 'prompt-registry.json'), payloads.promptRegistry);
  writeJson(join(targetDir, 'capability-registry.json'), payloads.capabilityRegistry);
  writeFileSync(join(targetDir, 'vercel-env-commands.txt'), [
    `vercel env add CONTROL_PLANE_PRIVATE_KEY production --force --yes < ${targetDir}/private.pem`,
    `vercel env add CONTROL_PLANE_KEY_ID production --value ${keyId} --force --yes`,
    'vercel env add CONTROL_PLANE_TTL_SECONDS production --value 3600 --force --yes',
    `vercel env add CONTROL_PLANE_CLOUD_CONFIG_JSON production --force --yes < ${targetDir}/cloud-config.json`,
    `vercel env add CONTROL_PLANE_PROMPT_REGISTRY_JSON production --force --yes < ${targetDir}/prompt-registry.json`,
    `vercel env add CONTROL_PLANE_CAPABILITY_REGISTRY_JSON production --force --yes < ${targetDir}/capability-registry.json`,
    `vercel env add CODE_AGENT_CONTROL_PLANE_KEY_ID production --value ${keyId} --force --yes`,
    `vercel env add CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY production --force --yes < ${targetDir}/public.pem`,
    `vercel env add CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS production --force --yes < ${targetDir}/public-keys.json`,
  ].join('\n'), { mode: 0o600 });

  return {
    targetDir,
    keyId,
    version,
    files: [
      'private.pem',
      'public.pem',
      'public-keys.json',
      'cloud-config.json',
      'prompt-registry.json',
      'capability-registry.json',
      'vercel-env-commands.txt',
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
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2));
}
