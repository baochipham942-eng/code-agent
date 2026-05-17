#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const VALID_MODES = new Set(['local', 'production', 'notarized']);

function isSet(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTruthy(value) {
  return value === '1' || value === 'true';
}

function parseArgs(argv) {
  const args = {
    mode: 'production',
    requireNotarization: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--require-notarization') {
      args.requireNotarization = true;
      continue;
    }
    if (arg === '--mode') {
      const mode = argv[index + 1];
      if (!VALID_MODES.has(mode)) {
        throw new Error(`Invalid --mode "${mode ?? ''}". Expected one of: ${[...VALID_MODES].join(', ')}`);
      }
      args.mode = mode;
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      const mode = arg.slice('--mode='.length);
      if (!VALID_MODES.has(mode)) {
        throw new Error(`Invalid --mode "${mode}". Expected one of: ${[...VALID_MODES].join(', ')}`);
      }
      args.mode = mode;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function usage() {
  return [
    'Usage: node scripts/verify-production-env.mjs [--mode local|production|notarized] [--require-notarization]',
    '',
    'Modes:',
    '  local       Check updater keys and control-plane public keys only.',
    '  production  Default external distribution gate; also requires Developer ID and notarization credentials.',
    '  notarized   Same Apple requirements as production; explicit for notarized release jobs.',
  ].join('\n');
}

function validateNonEmptyFile(filePath, variableName) {
  if (!existsSync(filePath)) {
    return `${variableName} points to a missing file: ${filePath}`;
  }
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    return `${variableName} points to an unreadable file: ${filePath} (${error.message})`;
  }
  if (!isSet(content)) {
    return `${variableName} points to an empty file: ${filePath}`;
  }
  return null;
}

function parseControlPlaneKeysJson(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: `${source} must be valid JSON`,
    };
  }

  const keysSource = parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && parsed.keys
    && typeof parsed.keys === 'object'
    && !Array.isArray(parsed.keys)
    ? parsed.keys
    : parsed;

  const keys = keysSource && typeof keysSource === 'object' && !Array.isArray(keysSource)
    ? Object.entries(keysSource).filter((entry) => isSet(entry[0]) && isSet(entry[1]))
    : [];

  if (keys.length === 0) {
    return {
      ok: false,
      reason: `${source} must contain at least one non-empty public key`,
    };
  }
  return { ok: true };
}

function checkUpdaterKeys(env) {
  const failures = [];

  if (!isSet(env.TAURI_UPDATER_PUBKEY)) {
    if (isSet(env.TAURI_UPDATER_PUBKEY_PATH)) {
      const fileFailure = validateNonEmptyFile(
        env.TAURI_UPDATER_PUBKEY_PATH,
        'TAURI_UPDATER_PUBKEY_PATH',
      );
      if (fileFailure) {
        failures.push(fileFailure);
      }
    } else {
      failures.push('TAURI_UPDATER_PUBKEY or TAURI_UPDATER_PUBKEY_PATH is required');
    }
  }

  if (!isSet(env.TAURI_SIGNING_PRIVATE_KEY)) {
    if (isSet(env.TAURI_SIGNING_PRIVATE_KEY_PATH)) {
      const fileFailure = validateNonEmptyFile(
        env.TAURI_SIGNING_PRIVATE_KEY_PATH,
        'TAURI_SIGNING_PRIVATE_KEY_PATH',
      );
      if (fileFailure) {
        failures.push(fileFailure);
      }
    } else {
      failures.push('TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required');
    }
  }

  return failures;
}

function checkControlPlanePublicKeys(env) {
  if (isSet(env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS)) {
    const parsed = parseControlPlaneKeysJson(
      env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS,
      'CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS',
    );
    return parsed.ok ? [] : [parsed.reason];
  }

  if (isSet(env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE)) {
    const filePath = env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE;
    const fileFailure = validateNonEmptyFile(filePath, 'CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE');
    if (fileFailure) {
      return [fileFailure];
    }
    const parsed = parseControlPlaneKeysJson(
      readFileSync(filePath, 'utf8'),
      'CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE',
    );
    return parsed.ok ? [] : [parsed.reason];
  }

  if (isSet(env.CODE_AGENT_CONTROL_PLANE_KEY_ID) && isSet(env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY)) {
    return [];
  }

  if (isSet(env.CODE_AGENT_CONTROL_PLANE_KEY_ID) || isSet(env.CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY)) {
    return ['CODE_AGENT_CONTROL_PLANE_KEY_ID and CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY must both be set'];
  }

  return [
    'CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS, CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE, or CODE_AGENT_CONTROL_PLANE_KEY_ID + CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY is required',
  ];
}

function checkDeveloperIdIdentity(env) {
  const identity = env.APPLE_SIGNING_IDENTITY || env.TAURI_MACOS_SIGNING_IDENTITY;
  if (!isSet(identity)) {
    return ['APPLE_SIGNING_IDENTITY or TAURI_MACOS_SIGNING_IDENTITY is required'];
  }
  if (!identity.startsWith('Developer ID Application:')) {
    return ['APPLE_SIGNING_IDENTITY or TAURI_MACOS_SIGNING_IDENTITY must be a Developer ID Application identity'];
  }
  return [];
}

function applePasswordIsSet(env) {
  return isSet(env.APPLE_PASSWORD) || isSet(env.APPLE_APP_SPECIFIC_PASSWORD);
}

function missingAppleIdCredentialNames(env) {
  return [
    ['APPLE_ID', isSet(env.APPLE_ID)],
    ['APPLE_PASSWORD or APPLE_APP_SPECIFIC_PASSWORD', applePasswordIsSet(env)],
    ['APPLE_TEAM_ID', isSet(env.APPLE_TEAM_ID)],
  ]
    .filter(([, present]) => !present)
    .map(([name]) => name);
}

function missingAppleApiCredentialNames(env) {
  return [
    ['APPLE_API_KEY', isSet(env.APPLE_API_KEY)],
    ['APPLE_API_ISSUER', isSet(env.APPLE_API_ISSUER)],
    ['APPLE_API_KEY_PATH', isSet(env.APPLE_API_KEY_PATH)],
  ]
    .filter(([, present]) => !present)
    .map(([name]) => name);
}

function checkNotarizationCredentials(env) {
  const hasAppleIdCredentials = isSet(env.APPLE_ID) && applePasswordIsSet(env) && isSet(env.APPLE_TEAM_ID);
  if (hasAppleIdCredentials) {
    return [];
  }

  const hasAppleApiCredentials = isSet(env.APPLE_API_KEY)
    && isSet(env.APPLE_API_ISSUER)
    && isSet(env.APPLE_API_KEY_PATH);
  if (hasAppleApiCredentials) {
    const fileFailure = validateNonEmptyFile(env.APPLE_API_KEY_PATH, 'APPLE_API_KEY_PATH');
    return fileFailure ? [fileFailure] : [];
  }

  const appleIdMissing = missingAppleIdCredentialNames(env);
  const appleApiMissing = missingAppleApiCredentialNames(env);
  return [
    `Apple notarization credentials are incomplete. Set APPLE_ID + (APPLE_PASSWORD or APPLE_APP_SPECIFIC_PASSWORD) + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH. Missing Apple ID path: ${appleIdMissing.join(', ') || 'none'}. Missing API key path: ${appleApiMissing.join(', ') || 'none'}.`,
  ];
}

function verifyEnvironment({ mode, requireNotarization }, env) {
  const failures = [
    ...checkUpdaterKeys(env),
    ...checkControlPlanePublicKeys(env),
  ];

  const shouldRequireApple = mode === 'production'
    || mode === 'notarized'
    || requireNotarization
    || (mode !== 'local' && isTruthy(env.REQUIRE_NOTARIZATION));

  if (shouldRequireApple) {
    failures.push(...checkDeveloperIdIdentity(env));
    failures.push(...checkNotarizationCredentials(env));
  }

  return {
    mode,
    checkedApple: shouldRequireApple,
    failures,
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[verify-production-env] ${error.message}`);
    console.error(usage());
    process.exit(2);
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  const result = verifyEnvironment(args, process.env);
  if (result.failures.length > 0) {
    console.error(`[verify-production-env] failed: mode=${result.mode}`);
    for (const failure of result.failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  const scopes = ['Tauri updater keys', 'control-plane public keys'];
  if (result.checkedApple) {
    scopes.push('Developer ID identity', 'Apple notarization credentials');
  }
  console.log(`[verify-production-env] passed: mode=${result.mode}; checked ${scopes.join(', ')}`);
}

main();
