#!/usr/bin/env node
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REQUIRED_PAYLOADS = [
  'cloud-config.json',
  'prompt-registry.json',
  'capability-registry.json',
  'agent-engine-model-catalog.json',
  'renderer-bundle-rollout.json',
];
const ALLOWED_CHANNELS = new Set(['stable', 'beta', 'canary']);
const ALLOWED_PROMPT_KEYS = new Set(['policyAddon', 'publicSystemAddon']);
const ALLOWED_CAPABILITY_KINDS = new Set(['mcp_template', 'channel_adapter', 'workflow_recipe']);
const DEFAULT_TTL_SECONDS = 3600;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class ControlPlaneReleaseBundleError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ControlPlaneReleaseBundleError';
    this.code = options.code ?? 'control_plane_release_bundle_error';
    this.details = options.details;
  }
}

function usage() {
  return [
    'Usage: node scripts/control-plane-release-bundle.mjs --source <dir> --out <dir> --version <version> --channel <stable|beta|canary> --key-id <id> [--previous <dir>]',
    '',
    'Builds a local control-plane release bundle from prepared payload JSON files.',
    'The script never generates private keys, writes Vercel env, or deploys.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    source: null,
    out: null,
    version: null,
    channel: null,
    keyId: null,
    previous: null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--source') {
      args.source = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--out') {
      args.out = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--version') {
      args.version = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--channel') {
      args.channel = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--key-id') {
      args.keyId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === '--previous') {
      args.previous = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    throw new ControlPlaneReleaseBundleError(`Unknown argument: ${arg}`, { code: 'unknown_argument' });
  }

  if (args.help) {
    return args;
  }
  for (const [name, value] of Object.entries({
    '--source': args.source,
    '--out': args.out,
    '--version': args.version,
    '--channel': args.channel,
    '--key-id': args.keyId,
  })) {
    if (!value || !String(value).trim()) {
      throw new ControlPlaneReleaseBundleError(`${name} is required`, { code: 'missing_argument' });
    }
  }
  if (!ALLOWED_CHANNELS.has(args.channel)) {
    throw new ControlPlaneReleaseBundleError(
      `--channel must be one of: ${[...ALLOWED_CHANNELS].join(', ')}`,
      { code: 'invalid_channel' },
    );
  }
  return args;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) {
    throw new ControlPlaneReleaseBundleError(`${label} must be a JSON object`, { code: 'invalid_payload' });
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function stripContentHashFields(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stripContentHashFields(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'contentHash')
      .map(([key, entry]) => [key, stripContentHashFields(entry)]),
  );
}

export function buildCanonicalContentHash(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(stripContentHashFields(value))))
    .digest('hex')}`;
}

function buildArtifactContentHash(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;
}

function stableJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ControlPlaneReleaseBundleError(`${basename(file)} must contain valid JSON: ${error.message}`, {
      code: 'invalid_json',
    });
  }
}

function assertReadableFile(file) {
  if (!existsSync(file)) {
    throw new ControlPlaneReleaseBundleError(`Missing required file: ${file}`, { code: 'missing_payload' });
  }
}

function validateCloudConfig(payload, { version, channel }) {
  assertRecord(payload, 'cloud-config.json');
  if (payload.version !== version) {
    throw new ControlPlaneReleaseBundleError(
      `cloud-config.json version must match --version (${version})`,
      { code: 'cloud_config_version_mismatch' },
    );
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'entitlement')) {
    throw new ControlPlaneReleaseBundleError('cloud-config.json entitlement is required', {
      code: 'missing_entitlement',
    });
  }

  const release = isRecord(payload.release) ? { ...payload.release } : {};
  if (release.channel !== undefined && release.channel !== channel) {
    throw new ControlPlaneReleaseBundleError(
      `cloud-config.json release.channel must match --channel (${channel})`,
      { code: 'release_channel_mismatch' },
    );
  }
  release.channel = channel;
  return {
    ...payload,
    release,
  };
}

function validatePromptRegistry(payload) {
  assertRecord(payload, 'prompt-registry.json');
  const prompts = payload.prompts ?? {};
  if (!isRecord(prompts)) {
    throw new ControlPlaneReleaseBundleError('prompt-registry.json prompts must be a JSON object', {
      code: 'invalid_prompt_registry',
    });
  }
  const dangerousKeys = Object.keys(prompts).filter((key) => !ALLOWED_PROMPT_KEYS.has(key));
  if (dangerousKeys.length > 0) {
    throw new ControlPlaneReleaseBundleError(
      `prompt-registry.json contains unsupported prompt keys: ${dangerousKeys.join(', ')}`,
      { code: 'unsupported_prompt_key', details: dangerousKeys },
    );
  }
  return {
    ...payload,
    prompts,
  };
}

function validateCapabilityRegistry(payload, { now }) {
  assertRecord(payload, 'capability-registry.json');
  if (!Array.isArray(payload.items)) {
    throw new ControlPlaneReleaseBundleError('capability-registry.json items must be an array', {
      code: 'invalid_capability_items',
    });
  }
  if (!Array.isArray(payload.revokedIds)) {
    throw new ControlPlaneReleaseBundleError('capability-registry.json revokedIds must be an array', {
      code: 'invalid_revoked_ids',
    });
  }

  const hasInstallableMcp = payload.items.some((item) => isRecord(item)
    && isRecord(item.install)
    && Object.prototype.hasOwnProperty.call(item.install, 'mcpServer'));
  if (hasInstallableMcp) {
    validateCapabilityRegistryTrust(payload, now);
  }

  const seenIds = new Set();
  for (const [index, item] of payload.items.entries()) {
    assertRecord(item, `capability-registry.json items[${index}]`);
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new ControlPlaneReleaseBundleError(`capability item at index ${index} must have a non-empty id`, {
        code: 'invalid_capability_id',
      });
    }
    if (seenIds.has(item.id)) {
      throw new ControlPlaneReleaseBundleError(`Duplicate capability id: ${item.id}`, {
        code: 'duplicate_capability_id',
      });
    }
    seenIds.add(item.id);

    if (!ALLOWED_CAPABILITY_KINDS.has(item.kind)) {
      throw new ControlPlaneReleaseBundleError(`Capability ${item.id} has unsupported kind: ${item.kind}`, {
        code: 'unsupported_capability_kind',
      });
    }

    if (isRecord(item.install) && Object.prototype.hasOwnProperty.call(item.install, 'mcpServer')) {
      validateInstallableMcpItem(item);
    }
  }

  return payload;
}

function validateAgentEngineModelCatalog(payload, { version }) {
  assertRecord(payload, 'agent-engine-model-catalog.json');
  if (payload.version !== version) {
    throw new ControlPlaneReleaseBundleError(
      `agent-engine-model-catalog.json version must match --version (${version})`,
      { code: 'agent_engine_catalog_version_mismatch' },
    );
  }
  if (typeof payload.updatedAt !== 'string' || !Number.isFinite(Date.parse(payload.updatedAt))) {
    throw new ControlPlaneReleaseBundleError('agent-engine-model-catalog.json updatedAt must be a valid date string', {
      code: 'invalid_agent_engine_catalog_updated_at',
    });
  }
  if (!Array.isArray(payload.engines)) {
    throw new ControlPlaneReleaseBundleError('agent-engine-model-catalog.json engines must be an array', {
      code: 'invalid_agent_engine_catalog_engines',
    });
  }

  const seenEngines = new Set();
  for (const [engineIndex, engine] of payload.engines.entries()) {
    assertRecord(engine, `agent-engine-model-catalog.json engines[${engineIndex}]`);
    if (engine.kind !== 'codex_cli' && engine.kind !== 'claude_code') {
      throw new ControlPlaneReleaseBundleError(`Unsupported Agent Engine kind: ${engine.kind}`, {
        code: 'unsupported_agent_engine_kind',
      });
    }
    if (seenEngines.has(engine.kind)) {
      throw new ControlPlaneReleaseBundleError(`Duplicate Agent Engine kind: ${engine.kind}`, {
        code: 'duplicate_agent_engine_kind',
      });
    }
    seenEngines.add(engine.kind);
    if (typeof engine.defaultModel !== 'string' || !engine.defaultModel.trim()) {
      throw new ControlPlaneReleaseBundleError(`Agent Engine ${engine.kind} defaultModel is required`, {
        code: 'missing_agent_engine_default_model',
      });
    }
    if (!Array.isArray(engine.models)) {
      throw new ControlPlaneReleaseBundleError(`Agent Engine ${engine.kind} models must be an array`, {
        code: 'invalid_agent_engine_models',
      });
    }
    const seenModels = new Set();
    for (const [modelIndex, model] of engine.models.entries()) {
      assertRecord(model, `agent-engine-model-catalog.json engines[${engineIndex}].models[${modelIndex}]`);
      if (typeof model.id !== 'string' || !model.id.trim()) {
        throw new ControlPlaneReleaseBundleError(`Agent Engine ${engine.kind} model id is required`, {
          code: 'missing_agent_engine_model_id',
        });
      }
      if (seenModels.has(model.id)) {
        throw new ControlPlaneReleaseBundleError(`Duplicate Agent Engine model id: ${engine.kind}/${model.id}`, {
          code: 'duplicate_agent_engine_model',
        });
      }
      seenModels.add(model.id);
      if (typeof model.label !== 'string' || !model.label.trim()) {
        throw new ControlPlaneReleaseBundleError(`Agent Engine ${engine.kind} model ${model.id} label is required`, {
          code: 'missing_agent_engine_model_label',
        });
      }
      if (!Array.isArray(model.capabilities)) {
        throw new ControlPlaneReleaseBundleError(`Agent Engine ${engine.kind} model ${model.id} capabilities must be an array`, {
          code: 'invalid_agent_engine_model_capabilities',
        });
      }
    }
    if (!seenModels.has(engine.defaultModel)) {
      throw new ControlPlaneReleaseBundleError(`Agent Engine ${engine.kind} defaultModel is not listed in models`, {
        code: 'agent_engine_default_model_not_listed',
      });
    }
  }

  return payload;
}

function validateRendererBundleRollout(payload, { version }) {
  assertRecord(payload, 'renderer-bundle-rollout.json');
  if (payload.version !== version) {
    throw new ControlPlaneReleaseBundleError(
      `renderer-bundle-rollout.json version must match --version (${version})`,
      { code: 'renderer_rollout_version_mismatch' },
    );
  }
  if (payload.channel !== undefined) {
    if (typeof payload.channel !== 'string' || !/^[A-Za-z0-9._-]+$/.test(payload.channel)) {
      throw new ControlPlaneReleaseBundleError('renderer-bundle-rollout.json channel is invalid', {
        code: 'invalid_renderer_rollout_channel',
      });
    }
  }
  if (payload.manifestUrl !== undefined) {
    if (typeof payload.manifestUrl !== 'string' || !/^https?:\/\//.test(payload.manifestUrl)) {
      throw new ControlPlaneReleaseBundleError('renderer-bundle-rollout.json manifestUrl must be http(s)', {
        code: 'invalid_renderer_rollout_manifest_url',
      });
    }
  }
  if (payload.rolloutPercent !== undefined) {
    if (
      typeof payload.rolloutPercent !== 'number' ||
      !Number.isFinite(payload.rolloutPercent) ||
      payload.rolloutPercent < 0 ||
      payload.rolloutPercent > 100
    ) {
      throw new ControlPlaneReleaseBundleError('renderer-bundle-rollout.json rolloutPercent must be between 0 and 100', {
        code: 'invalid_renderer_rollout_percent',
      });
    }
  }
  if (payload.paused !== undefined && typeof payload.paused !== 'boolean') {
    throw new ControlPlaneReleaseBundleError('renderer-bundle-rollout.json paused must be boolean', {
      code: 'invalid_renderer_rollout_paused',
    });
  }
  if (payload.rollbackToBuiltin !== undefined && typeof payload.rollbackToBuiltin !== 'boolean') {
    throw new ControlPlaneReleaseBundleError('renderer-bundle-rollout.json rollbackToBuiltin must be boolean', {
      code: 'invalid_renderer_rollout_rollback',
    });
  }
  if (payload.rollbackToBuiltin === true) {
    if (typeof payload.rollbackReason !== 'string' || payload.rollbackReason.trim().length === 0) {
      throw new ControlPlaneReleaseBundleError('renderer-bundle-rollout.json rollbackToBuiltin requires rollbackReason', {
        code: 'missing_renderer_rollout_rollback_reason',
      });
    }
    if (payload.rolloutPercent !== undefined && payload.rolloutPercent !== 0) {
      throw new ControlPlaneReleaseBundleError('renderer-bundle-rollout.json rollbackToBuiltin requires rolloutPercent to be omitted or 0', {
        code: 'invalid_renderer_rollout_rollback_percent',
      });
    }
  }
  return payload;
}

function validateCapabilityRegistryTrust(payload, now) {
  if (!isRecord(payload.source)) {
    throw new ControlPlaneReleaseBundleError('capability-registry.json source is required for installable MCP templates', {
      code: 'missing_registry_source',
    });
  }
  if (typeof payload.source.expiresAt !== 'string' || !payload.source.expiresAt.trim()) {
    throw new ControlPlaneReleaseBundleError('capability-registry.json source.expiresAt is required for installable MCP templates', {
      code: 'missing_registry_source_expires_at',
    });
  }
  const expiresAtMs = Date.parse(payload.source.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
    throw new ControlPlaneReleaseBundleError('capability-registry.json source.expiresAt is expired or invalid', {
      code: 'expired_registry_source',
    });
  }
  if (typeof payload.source.contentHash !== 'string' || !payload.source.contentHash.trim()) {
    throw new ControlPlaneReleaseBundleError('capability-registry.json source.contentHash is required for installable MCP templates', {
      code: 'missing_registry_source_content_hash',
    });
  }
  const actualHash = buildCanonicalContentHash(payload);
  if (payload.source.contentHash.toLowerCase() !== actualHash) {
    throw new ControlPlaneReleaseBundleError(
      `capability-registry.json source.contentHash mismatch: expected ${payload.source.contentHash}, actual ${actualHash}`,
      { code: 'registry_source_content_hash_mismatch' },
    );
  }
}

function validateInstallableMcpItem(item) {
  const install = item.install;
  const mcpServer = isRecord(install) ? install.mcpServer : null;
  if (!isRecord(mcpServer)) {
    throw new ControlPlaneReleaseBundleError(`Capability ${item.id} install.mcpServer must be an object`, {
      code: 'invalid_mcp_server_install',
    });
  }
  if (mcpServer.env !== undefined) {
    throw new ControlPlaneReleaseBundleError(`Capability ${item.id} install.mcpServer must not include env values`, {
      code: 'mcp_server_env_not_allowed',
    });
  }
  if (mcpServer.type !== undefined && mcpServer.type !== 'stdio') {
    throw new ControlPlaneReleaseBundleError(`Capability ${item.id} install.mcpServer.type must be stdio`, {
      code: 'unsupported_mcp_server_type',
    });
  }
  if (typeof mcpServer.command !== 'string' || !mcpServer.command.trim()) {
    throw new ControlPlaneReleaseBundleError(`Capability ${item.id} install.mcpServer.command is required`, {
      code: 'missing_mcp_server_command',
    });
  }
}

function readAndValidatePayloads(sourceDir, options) {
  for (const file of REQUIRED_PAYLOADS) {
    assertReadableFile(join(sourceDir, file));
  }
  const cloudConfig = validateCloudConfig(readJsonFile(join(sourceDir, 'cloud-config.json')), options);
  const promptRegistry = validatePromptRegistry(readJsonFile(join(sourceDir, 'prompt-registry.json')));
  const capabilityRegistry = validateCapabilityRegistry(readJsonFile(join(sourceDir, 'capability-registry.json')), options);
  const agentEngineModelCatalog = validateAgentEngineModelCatalog(readJsonFile(join(sourceDir, 'agent-engine-model-catalog.json')), options);
  const rendererBundleRollout = validateRendererBundleRollout(readJsonFile(join(sourceDir, 'renderer-bundle-rollout.json')), options);
  return {
    'cloud-config.json': cloudConfig,
    'prompt-registry.json': promptRegistry,
    'capability-registry.json': capabilityRegistry,
    'agent-engine-model-catalog.json': agentEngineModelCatalog,
    'renderer-bundle-rollout.json': rendererBundleRollout,
  };
}

function artifactEntry(fileName, payload) {
  return {
    fileName,
    contentHash: buildArtifactContentHash(payload),
  };
}

function writeJsonArtifact(outDir, fileName, payload) {
  const file = join(outDir, fileName);
  writeFileSync(file, stableJson(payload), { mode: 0o600 });
  return file;
}

function discoverPublicKeyCommands(sourceDir, outDir, keyId) {
  const commands = [];
  const publicPem = join(sourceDir, 'public.pem');
  const publicKeysJson = ['public-keys.json', 'control-plane-public-keys.json']
    .map((file) => join(sourceDir, file))
    .find((file) => existsSync(file));

  if (existsSync(publicPem)) {
    commands.push(`vercel env add CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY production --force --yes < ${shellQuote(publicPem)}`);
  }
  if (publicKeysJson) {
    commands.push(`vercel env add CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS production --force --yes < ${shellQuote(publicKeysJson)}`);
  } else if (existsSync(publicPem)) {
    const publicKeysBundle = join(outDir, 'public-keys.json');
    writeFileSync(publicKeysBundle, stableJson({ [keyId]: readFileSync(publicPem, 'utf8') }), { mode: 0o600 });
    commands.push(`vercel env add CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS production --force --yes < ${shellQuote(publicKeysBundle)}`);
  }
  return commands;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function writeTextArtifact(outDir, fileName, value) {
  const file = join(outDir, fileName);
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return file;
}

function buildEnvCommands({ payloadDir, keyIdFile, ttlFile, publicKeyCommands = [], repoRoot = REPO_ROOT }) {
  return [
    `cd ${shellQuote(repoRoot)}`,
    `vercel env add CONTROL_PLANE_CLOUD_CONFIG_JSON production --force --yes < ${shellQuote(join(payloadDir, 'cloud-config.json'))}`,
    `vercel env add CONTROL_PLANE_PROMPT_REGISTRY_JSON production --force --yes < ${shellQuote(join(payloadDir, 'prompt-registry.json'))}`,
    `vercel env add CONTROL_PLANE_CAPABILITY_REGISTRY_JSON production --force --yes < ${shellQuote(join(payloadDir, 'capability-registry.json'))}`,
    `vercel env add CONTROL_PLANE_AGENT_ENGINE_MODEL_CATALOG_JSON production --force --yes < ${shellQuote(join(payloadDir, 'agent-engine-model-catalog.json'))}`,
    `vercel env add CONTROL_PLANE_RENDERER_BUNDLE_ROLLOUT_JSON production --force --yes < ${shellQuote(join(payloadDir, 'renderer-bundle-rollout.json'))}`,
    `vercel env add CONTROL_PLANE_KEY_ID production --force --yes < ${shellQuote(keyIdFile)}`,
    `vercel env add CODE_AGENT_CONTROL_PLANE_KEY_ID production --force --yes < ${shellQuote(keyIdFile)}`,
    `vercel env add CONTROL_PLANE_TTL_SECONDS production --force --yes < ${shellQuote(ttlFile)}`,
    ...publicKeyCommands,
  ].join('\n');
}

function buildPostApplyCommands(repoRoot = REPO_ROOT) {
  return [
    `cd ${shellQuote(repoRoot)}`,
    'vercel deploy --prod --yes',
    'npm run renderer:verify-production -- --expected-version-from-app-update --include-remote-snapshot --retry-attempts 12 --retry-delay-ms 30000',
  ].join('\n');
}

function readPreviousMetadata(previousDir) {
  const manifestFile = join(previousDir, 'manifest.json');
  if (existsSync(manifestFile)) {
    const manifest = readJsonFile(manifestFile);
    return {
      version: typeof manifest.version === 'string' && manifest.version.trim()
        ? manifest.version
        : null,
      keyId: typeof manifest.keyId === 'string' && manifest.keyId.trim()
        ? manifest.keyId
        : null,
    };
  }
  const cloudConfigFile = join(previousDir, 'cloud-config.json');
  if (existsSync(cloudConfigFile)) {
    const cloudConfig = readJsonFile(cloudConfigFile);
    if (typeof cloudConfig.version === 'string' && cloudConfig.version.trim()) {
      return {
        version: cloudConfig.version,
        keyId: null,
      };
    }
  }
  return {
    version: null,
    keyId: null,
  };
}

function validatePreviousDir(previousDir) {
  for (const file of REQUIRED_PAYLOADS) {
    assertReadableFile(join(previousDir, file));
  }
}

export function buildControlPlaneReleaseBundle({
  sourceDir,
  outDir,
  version,
  channel,
  keyId,
  previousDir,
  now = new Date(),
}) {
  if (!sourceDir || !outDir || !version || !channel || !keyId) {
    throw new ControlPlaneReleaseBundleError('sourceDir, outDir, version, channel, and keyId are required', {
      code: 'missing_options',
    });
  }
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new ControlPlaneReleaseBundleError(`channel must be one of: ${[...ALLOWED_CHANNELS].join(', ')}`, {
      code: 'invalid_channel',
    });
  }

  const source = resolve(sourceDir);
  const out = resolve(outDir);
  const previous = previousDir ? resolve(previousDir) : null;
  mkdirSync(out, { recursive: true, mode: 0o700 });

  const payloads = readAndValidatePayloads(source, { version, channel, now });
  const artifactFiles = [];
  const manifestArtifacts = [];
  for (const fileName of REQUIRED_PAYLOADS) {
    writeJsonArtifact(out, fileName, payloads[fileName]);
    artifactFiles.push(join(out, fileName));
    manifestArtifacts.push(artifactEntry(fileName, payloads[fileName]));
  }

  const publicKeyCommands = discoverPublicKeyCommands(source, out, keyId);
  const keyIdFile = writeTextArtifact(out, 'control-plane-key-id.txt', keyId);
  const ttlFile = writeTextArtifact(out, 'control-plane-ttl-seconds.txt', DEFAULT_TTL_SECONDS);
  const vercelCommands = buildEnvCommands({ payloadDir: out, keyIdFile, ttlFile, publicKeyCommands });
  const commandsFile = join(out, 'vercel-env-commands.txt');
  writeFileSync(commandsFile, `${vercelCommands}\n`, { mode: 0o600 });
  const postApplyCommandsFile = join(out, 'post-apply-commands.txt');
  writeFileSync(postApplyCommandsFile, `${buildPostApplyCommands()}\n`, { mode: 0o600 });

  let previousVersion = null;
  let rollbackCommandsFile = null;
  const rollbackValueFiles = [];
  if (previous) {
    validatePreviousDir(previous);
    const previousMetadata = readPreviousMetadata(previous);
    previousVersion = previousMetadata.version;
    const rollbackKeyId = previousMetadata.keyId ?? keyId;
    const rollbackKeyIdFile = writeTextArtifact(out, 'rollback-control-plane-key-id.txt', rollbackKeyId);
    rollbackValueFiles.push(rollbackKeyIdFile);
    const rollbackCommands = buildEnvCommands({
      payloadDir: previous,
      keyIdFile: rollbackKeyIdFile,
      ttlFile,
      publicKeyCommands: discoverPublicKeyCommands(previous, out, rollbackKeyId),
    });
    rollbackCommandsFile = join(out, 'rollback-env-commands.txt');
    writeFileSync(rollbackCommandsFile, `${rollbackCommands}\n`, { mode: 0o600 });
  }

  const manifest = {
    schemaVersion: 1,
    version,
    channel,
    keyId,
    createdAt: now.toISOString(),
    artifacts: manifestArtifacts,
    previousVersion,
    rollbackAvailable: Boolean(previous),
  };
  writeJsonArtifact(out, 'manifest.json', manifest);

  return {
    outDir: out,
    sourceDir: source,
    version,
    channel,
    keyId,
    previousVersion,
    rollbackAvailable: Boolean(previous),
    artifacts: manifestArtifacts,
    files: [
      ...artifactFiles,
      keyIdFile,
      ttlFile,
      ...rollbackValueFiles,
      join(out, 'manifest.json'),
      commandsFile,
      postApplyCommandsFile,
      ...(rollbackCommandsFile ? [rollbackCommandsFile] : []),
    ],
  };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`[control-plane-release-bundle] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }
  if (args.help) {
    console.log(usage());
    return;
  }

  try {
    const result = buildControlPlaneReleaseBundle({
      sourceDir: args.source,
      outDir: args.out,
      version: args.version,
      channel: args.channel,
      keyId: args.keyId,
      previousDir: args.previous,
    });
    console.log(`[control-plane-release-bundle] wrote ${result.files.length} file(s) to ${result.outDir}`);
    console.log('[control-plane-release-bundle] review vercel-env-commands.txt before applying env changes');
    console.log('[control-plane-release-bundle] after applying env, run post-apply-commands.txt');
  } catch (error) {
    console.error(`[control-plane-release-bundle] ${error.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2));
}
