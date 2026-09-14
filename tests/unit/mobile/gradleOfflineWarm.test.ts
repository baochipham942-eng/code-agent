import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  assembleDebugOffline,
  gradleErrorText,
  isGradleCacheMiss,
  OFFLINE_ASSEMBLE_ARGS,
  ONLINE_RESOLVE_ARGS,
} from '../../../packages/mobile/scripts/gradle-offline-warm.mjs';

const IONCAMERA_OFFLINE_MISS = `FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:checkDebugAarMetadata'.
> Could not resolve all files for configuration ':app:debugRuntimeClasspath'.
   > Could not resolve io.ionic.libs:ioncamera-android:1.0.2.
     Required by:
         project :app > project :capacitor-camera
      > No cached version of io.ionic.libs:ioncamera-android:1.0.2 available for offline mode.
   > Could not resolve com.google.android.material:material:1.13.0.
     Required by:
         project :app > project :capacitor-camera
      > No cached version of com.google.android.material:material:1.13.0 available for offline mode.
   > Could not resolve androidx.exifinterface:exifinterface:1.4.1.
     Required by:
         project :app > project :capacitor-camera
      > No cached version of androidx.exifinterface:exifinterface:1.4.1 available for offline mode.
`;

const COMPILE_ERROR = `FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugJavaWithJavac'.
> Compilation failed; see the compiler error output for details.
`;

const SIGNING_ERROR = `FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:packageDebug'.
> SigningConfig "debug" is missing required property "storeFile".
`;

const SDK_LOCATION_MISSING = `FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:compileDebugJavaWithJavac'.
> SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable or by setting the sdk.dir path in your project's local properties file at '/tmp/android/local.properties'.
`;

const BUILD_TOOLS_MISSING = `FAILURE: Build failed with an exception.

* What went wrong:
Failed to find Build Tools revision 35.0.0
`;

const ONLINE_RESOLVE_FAILURE = `FAILURE: Build failed with an exception.

* What went wrong:
Could not resolve all files for configuration ':app:debugRuntimeClasspath'.
> Could not find io.ionic.libs:ioncamera-android:9.9.9.
  Searched in the following locations:
    - https://dl.google.com/dl/android/maven2/io/ionic/libs/ioncamera-android/9.9.9/ioncamera-android-9.9.9.pom
`;

function gradleError(stdout: string, message = 'Command failed: ./gradlew'): Error & { stdout: string; stderr: string; status: number } {
  const error = new Error(`${message}\n${stdout}`) as Error & { stdout: string; stderr: string; status: number };
  error.stdout = stdout;
  error.stderr = '';
  error.status = 1;
  return error;
}

describe('isGradleCacheMiss', () => {
  it('matches Gradle --offline missing-cache text from a new native plugin', () => {
    expect(isGradleCacheMiss(IONCAMERA_OFFLINE_MISS)).toBe(true);
    expect(isGradleCacheMiss('No cached version listing available for offline mode.')).toBe(true);
    expect(isGradleCacheMiss('Cannot download ioncamera-android-1.0.2.aar in offline mode.')).toBe(true);
  });

  it('does not treat compile, signing, or SDK/platform gaps as a cache miss', () => {
    expect(isGradleCacheMiss(COMPILE_ERROR)).toBe(false);
    expect(isGradleCacheMiss(SIGNING_ERROR)).toBe(false);
    expect(isGradleCacheMiss(SDK_LOCATION_MISSING)).toBe(false);
    expect(isGradleCacheMiss(BUILD_TOOLS_MISSING)).toBe(false);
    expect(isGradleCacheMiss(ONLINE_RESOLVE_FAILURE)).toBe(false);
    expect(isGradleCacheMiss('')).toBe(false);
  });

  it('fail-closes on SDK missing even when the same log mentions unresolved files', () => {
    const mixed = `${IONCAMERA_OFFLINE_MISS}\nSDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable.`;
    expect(isGradleCacheMiss(mixed)).toBe(false);
  });
});

describe('gradleErrorText', () => {
  it('prefers stdout/stderr over the wrapper Command failed line so --offline in argv is not a signal', () => {
    const error = gradleError(IONCAMERA_OFFLINE_MISS, 'Command failed: ./gradlew --offline assembleDebug');
    expect(gradleErrorText(error)).toBe(IONCAMERA_OFFLINE_MISS);
    expect(gradleErrorText({ message: 'Command failed: ./gradlew --offline assembleDebug' })).toContain('--offline');
  });
});

describe('assembleDebugOffline', () => {
  it('on a cache miss logs once, resolves online once, then retries --offline', () => {
    const events: string[] = [];
    const result = assembleDebugOffline({
      cwd: '/tmp/android',
      gradle: './gradlew',
      log: (message) => events.push(`log:${message}`),
      exec: (_command, args) => {
        events.push(`exec:${args.join(' ')}`);
        if (args.includes('--offline') && !events.some((event) => event.startsWith('log:'))) {
          throw gradleError(IONCAMERA_OFFLINE_MISS);
        }
        return '';
      },
    });
    expect(result).toEqual({ warmed: true });
    expect(events[0]).toBe(`exec:${OFFLINE_ASSEMBLE_ARGS.join(' ')}`);
    expect(events[1]).toMatch(/^log:GRADLE_CACHE_MISS:/);
    expect(events[1]).toMatch(/online once/);
    expect(events[2]).toBe(`exec:${ONLINE_RESOLVE_ARGS.join(' ')}`);
    expect(events[3]).toBe(`exec:${OFFLINE_ASSEMBLE_ARGS.join(' ')}`);
    expect(events.filter((event) => event.startsWith('exec:'))).toHaveLength(3);
    expect(ONLINE_RESOLVE_ARGS).not.toContain('--offline');
    expect(OFFLINE_ASSEMBLE_ARGS).toContain('--offline');
  });

  it('does not retry compile, signing, or SDK failures', () => {
    for (const stdout of [COMPILE_ERROR, SIGNING_ERROR, SDK_LOCATION_MISSING, BUILD_TOOLS_MISSING]) {
      const original = gradleError(stdout);
      let calls = 0;
      const logs: string[] = [];
      expect(() => assembleDebugOffline({
        cwd: '/tmp/android',
        log: (message) => logs.push(message),
        exec: () => {
          calls += 1;
          throw original;
        },
      })).toThrow(original);
      expect(calls).toBe(1);
      expect(logs).toEqual([]);
    }
  });

  it('rethrows the online resolve error as-is and does not retry --offline', () => {
    const onlineError = gradleError(ONLINE_RESOLVE_FAILURE);
    const events: string[] = [];
    expect(() => assembleDebugOffline({
      cwd: '/tmp/android',
      log: (message) => events.push(`log:${message}`),
      exec: (_command, args) => {
        events.push(`exec:${args.includes('--offline') ? 'offline' : 'online'}`);
        if (args.includes('--offline')) throw gradleError(IONCAMERA_OFFLINE_MISS);
        throw onlineError;
      },
    })).toThrow(onlineError);
    expect(events).toEqual([
      'exec:offline',
      expect.stringMatching(/^log:GRADLE_CACHE_MISS:/),
      'exec:online',
    ]);
  });

  it('rethrows the --offline retry error as-is and does not resolve online a second time', () => {
    const retryError = gradleError(IONCAMERA_OFFLINE_MISS);
    let onlineCalls = 0;
    let offlineCalls = 0;
    expect(() => assembleDebugOffline({
      cwd: '/tmp/android',
      log: () => {},
      exec: (_command, args) => {
        if (args.includes('--offline')) {
          offlineCalls += 1;
          throw retryError;
        }
        onlineCalls += 1;
        return '';
      },
    })).toThrow(retryError);
    expect(offlineCalls).toBe(2);
    expect(onlineCalls).toBe(1);
  });

  it('returns warmed:false when the official --offline assemble already succeeds', () => {
    const events: string[] = [];
    expect(assembleDebugOffline({
      cwd: '/tmp/android',
      log: (message) => events.push(message),
      exec: (_command, args) => {
        events.push(args.join(' '));
        return 'BUILD SUCCESSFUL';
      },
    })).toEqual({ warmed: false });
    expect(events).toEqual([OFFLINE_ASSEMBLE_ARGS.join(' ')]);
  });
});

describe('android:build wiring', () => {
  it('routes assembleDebug through the cache-miss warm helper instead of a bare --offline gradlew', () => {
    const source = readFileSync('packages/mobile/scripts/build-android.mjs', 'utf8');
    expect(source).toContain("import { assembleDebugOffline } from './gradle-offline-warm.mjs'");
    expect(source).toContain('assembleDebugOffline({ cwd: resolve(\'android\') })');
    expect(source).not.toMatch(/run\('\.\/gradlew'/);
  });
});
