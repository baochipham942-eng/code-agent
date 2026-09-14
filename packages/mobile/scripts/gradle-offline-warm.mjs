import { spawnSync } from 'node:child_process';

export const OFFLINE_ASSEMBLE_ARGS = Object.freeze(['--offline', '--no-daemon', '--max-workers=2', 'assembleDebug']);
export const ONLINE_RESOLVE_ARGS = Object.freeze(['--no-daemon', '--max-workers=2', 'assembleDebug']);

const SDK_OR_PLATFORM_MISSING = [
  /SDK location not found/i,
  /Failed to find Build Tools revision/i,
  /Failed to find Platform SDK/i,
  /failed to find target with hash string/i,
  /Failed to install the following SDK components/i,
  /License for package Android SDK/i,
  /NDK (?:is )?not installed/i,
  /cmdline-tools component is missing/i,
];

const GRADLE_CACHE_MISS = [
  /No cached version(?: listing)?(?: of \S+)? available for offline mode/i,
  /No cached version listing(?: for \S+)? available for offline mode/i,
  /Cannot download \S+ in offline mode/i,
];

function asText(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

export function gradleErrorText(error) {
  const chunks = [asText(error?.stdout), asText(error?.stderr)].filter((chunk) => chunk.length > 0);
  if (chunks.length) return chunks.join('\n');
  return typeof error?.message === 'string' ? error.message : String(error ?? '');
}

export function isGradleCacheMiss(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (SDK_OR_PLATFORM_MISSING.some((pattern) => pattern.test(text))) return false;
  return GRADLE_CACHE_MISS.some((pattern) => pattern.test(text));
}

function defaultGradleExec(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    result.error.stdout = result.stdout ?? '';
    result.error.stderr = result.stderr ?? '';
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`Command failed: ${command} ${args.join(' ')}\n${result.stderr || result.stdout || ''}`);
    error.status = result.status;
    error.stdout = result.stdout ?? '';
    error.stderr = result.stderr ?? '';
    throw error;
  }
  return result.stdout;
}

export function assembleDebugOffline({
  gradle = './gradlew',
  cwd,
  exec = defaultGradleExec,
  log = console.log,
} = {}) {
  try {
    exec(gradle, OFFLINE_ASSEMBLE_ARGS, cwd);
    return { warmed: false };
  } catch (error) {
    if (!isGradleCacheMiss(gradleErrorText(error))) throw error;
    log('GRADLE_CACHE_MISS: --offline assembleDebug failed on unresolved/cached-missing dependencies; resolving online once (assembleDebug without --offline), then retrying --offline. SDK/platform installs stay fail-closed.');
    try {
      exec(gradle, ONLINE_RESOLVE_ARGS, cwd);
    } catch (onlineError) {
      throw onlineError;
    }
    exec(gradle, OFFLINE_ASSEMBLE_ARGS, cwd);
    return { warmed: true };
  }
}
