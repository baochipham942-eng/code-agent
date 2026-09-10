import { configureVoiceRelease } from './configure-voice.mjs';
import './remote-only.mjs';
import { configureAndroidLan } from './configure-lan.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const build = Number(process.env.NEO_MOBILE_BUILD);
if (!Number.isSafeInteger(build) || build < 1) throw new Error('POSITIVE_NEO_MOBILE_BUILD_REQUIRED');
if (!process.env.ANDROID_HOME || !process.env.JAVA_HOME) throw new Error('SDK_AND_JAVA_REQUIRED');
const root = resolve('../..');
const run = (command, args, cwd = process.cwd()) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const capture = (command, args, cwd = process.cwd()) => execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('INVALID_VERSION');
configureVoiceRelease();
run('npm', ['run', 'build']);
if (!existsSync('android')) run('node_modules/.bin/cap', ['add', 'android']);
const gradle = 'android/app/build.gradle';
const template = readFileSync(gradle, 'utf8');
if (!/versionCode\s+\d+/.test(template) || !/versionName\s+"[^"]+"/.test(template)) throw new Error('ANDROID_TEMPLATE_CHANGED');
writeFileSync(gradle, template.replace(/versionCode\s+\d+/, `versionCode ${build}`).replace(/versionName\s+"[^"]+"/, `versionName "${version}"`));
// MN-01/MN-02 native adaptations (regenerated projects get these reapplied on every build):
// edge-to-edge window, real safe-area insets injected as CSS variables, predictive back opt-in.
writeFileSync('android/app/src/main/java/dev/neo/companion/preview/MainActivity.java', `package dev.neo.companion.preview;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Draw behind the system bars so the web scrim covers the status bar area (MN-01).
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        View parent = (View) getBridge().getWebView().getParent();
        // Replaces the core SystemBars insets listener: WebView 95 has no env() safe-area support,
        // so zero the insets handed to the WebView and inject the real values as CSS variables.
        // The IME insets pad the container instead of resizing the window (Keyboard resize: native).
        ViewCompat.setOnApplyWindowInsetsListener(parent, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            v.setPadding(0, 0, 0, imeVisible ? ime.bottom : 0);
            // Zero the CSS bottom inset while the IME owns the container padding (no double subtraction).
            injectSafeArea(bars.top, bars.left, bars.right, imeVisible ? 0 : bars.bottom);
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(), Insets.of(0, 0, 0, 0))
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, 0))
                .build();
        });
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // WebView 95 never reflects Android night mode in prefers-color-scheme, so push it (MN-05).
        pushSystemNight();
    }

    private void pushSystemNight() {
        int mask = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        String js = "try{document.documentElement.dataset.systemNight="
            + (mask == Configuration.UI_MODE_NIGHT_YES ? "'true'" : "'false'")
            + ";document.dispatchEvent(new Event('neo-system-night'));}catch(e){}";
        getBridge().getWebView().evaluateJavascript(js, null);
    }

    private void injectSafeArea(int top, int left, int right, int bottom) {
        float density = getResources().getDisplayMetrics().density;
        int mask = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        String night = mask == Configuration.UI_MODE_NIGHT_YES ? "'true'" : "'false'";
        String js = String.format(Locale.US,
            "try{var s=document.documentElement.style;"
                + "s.setProperty('--safe-area-inset-top','%dpx');"
                + "s.setProperty('--safe-area-inset-left','%dpx');"
                + "s.setProperty('--safe-area-inset-right','%dpx');"
                + "s.setProperty('--safe-area-inset-bottom','%dpx');"
                + "document.documentElement.dataset.systemNight=%s;"
                + "document.dispatchEvent(new Event('neo-system-night'));}catch(e){}",
            Math.round(top / density), Math.round(left / density), Math.round(right / density), Math.round(bottom / density), night);
        getBridge().getWebView().evaluateJavascript(js, null);
    }
}
`);
const manifestPath = 'android/app/src/main/AndroidManifest.xml';
const manifestTemplate = readFileSync(manifestPath, 'utf8');
if (!manifestTemplate.includes('<application')) throw new Error('ANDROID_TEMPLATE_CHANGED');
if (!manifestTemplate.includes('enableOnBackInvokedCallback')) {
  writeFileSync(manifestPath, manifestTemplate.replace('<application',
    '<application\n        android:enableOnBackInvokedCallback="true"'));
}
run('node_modules/.bin/cap', ['sync', 'android']);
configureAndroidLan();
run('./gradlew', ['--offline', '--no-daemon', '--max-workers=2', 'assembleDebug'], resolve('android'));
mkdirSync('.artifacts', { recursive: true });
const apk = `.artifacts/neo-mobile-${version}-${build}.apk`;
copyFileSync('android/app/build/outputs/apk/debug/app-debug.apk', apk);
const sourceStatus = capture('git', ['status', '--porcelain'], root);
const manifest = {
  kind: 'mobile-base-preview', platform: 'android', version, build, appId: 'dev.neo.companion.preview',
  sourceSha: capture('git', ['rev-parse', 'HEAD'], root), sourceDirty: sourceStatus.length > 0,
  sourceTree: capture('git', ['rev-parse', 'HEAD^{tree}'], root), fixtures: process.env.NEO_MOBILE_FIXTURES === '1',
  lockSha256: hash('package-lock.json'), apk: apk.split('/').at(-1), apkSha256: hash(apk),
  node: process.version, npm: capture('npm', ['--version']),
  sdk: readFileSync('android/variables.gradle', 'utf8'),
  sdkPackages: ['platforms', 'build-tools', 'platform-tools'].flatMap(group => {
    const dir = resolve(process.env.ANDROID_HOME, group);
    const entries = group === 'platform-tools' ? [''] : readdirSync(dir);
    return entries.map(entry => ({ component: [group, entry].filter(Boolean).join('/'),
      properties: readFileSync(resolve(dir, entry, 'source.properties'), 'utf8') }));
  }),
};
writeFileSync(`${apk}.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`APK_BUILT ${manifest.apk} sha256=${manifest.apkSha256} source=${manifest.sourceSha} dirty=${manifest.sourceDirty}`);
