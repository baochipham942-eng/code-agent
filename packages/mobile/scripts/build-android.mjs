import { configureVoiceRelease } from './configure-voice.mjs';
import './remote-only.mjs';
import { configureAndroidLan } from './configure-lan.mjs';
import { assembleDebugOffline } from './gradle-offline-warm.mjs';
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
        // First-party plugins must be registered before super.onCreate: BridgeActivity builds the
        // bridge (and consumes the plugin list) inside its own onCreate.
        registerPlugin(LanDnsPlugin.class);
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
// fix4-⑤（2026-09-15）：第一方 mDNS 单次解析插件。Android 的 Java 解析器不认 .local、
// NsdManager 只面向 service 类型（宿主只广告主机名），这里补最小解析能力：
// 一次 A 查询发到 224.0.0.251:5353，等第一条命中该名字的 A 应答，带超时、不长驻 browse。
writeFileSync('android/app/src/main/java/dev/neo/companion/preview/LanDnsPlugin.java', `package dev.neo.companion.preview;

import android.content.Context;
import android.net.wifi.WifiManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.net.DatagramPacket;
import java.net.InetAddress;
import java.net.MulticastSocket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import org.json.JSONObject;

/** One-shot mDNS A-record resolve for a .local hostname (fix4-⑤). Mirrors iOS NeoLanDnsPlugin. */
@CapacitorPlugin(name = "LanDns")
public class LanDnsPlugin extends Plugin {

    private static final String MDNS_GROUP = "224.0.0.251";
    private static final int MDNS_PORT = 5353;
    /** mDNS packets are capped at 9000 bytes (RFC 6762 §17). */
    private static final int MAX_PACKET_BYTES = 9000;
    /** Fallback timeout; JS always passes COMPANION_LIMITS.mdnsResolveTimeoutMs explicitly. */
    private static final int FALLBACK_TIMEOUT_MS = 3000;
    private static final String HOST_PATTERN = "(?i)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\\\.local";

    @PluginMethod
    public void resolve(PluginCall call) {
        String host = call.getString("host");
        int timeoutMs = call.getInt("timeoutMs", FALLBACK_TIMEOUT_MS);
        if (host == null || !host.matches(HOST_PATTERN)) {
            call.reject("INVALID_HOST");
            return;
        }
        // Blocking socket work runs on its own short-lived thread; PluginCall resolve is thread-safe.
        Thread worker = new Thread(() -> {
            Context appContext = getContext().getApplicationContext();
            WifiManager wifi = (WifiManager) appContext.getSystemService(Context.WIFI_SERVICE);
            WifiManager.MulticastLock lock = null;
            MulticastSocket socket = null;
            String address = null;
            try {
                // Receiving multicast on Wi-Fi needs the lock; without it packets are silently filtered.
                if (wifi != null) {
                    lock = wifi.createMulticastLock("neo-lan-dns");
                    lock.setReferenceCounted(false);
                    lock.acquire();
                }
                socket = new MulticastSocket(MDNS_PORT);
                socket.setReuseAddress(true);
                socket.setSoTimeout(Math.max(250, timeoutMs));
                InetAddress group = InetAddress.getByName(MDNS_GROUP);
                socket.joinGroup(group);
                byte[] query = buildQuery(host);
                socket.send(new DatagramPacket(query, query.length, group, MDNS_PORT));
                long deadline = System.currentTimeMillis() + Math.max(250, timeoutMs);
                byte[] buffer = new byte[MAX_PACKET_BYTES];
                while (address == null && System.currentTimeMillis() < deadline) {
                    DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                    try {
                        socket.receive(packet);
                    } catch (SocketTimeoutException noTraffic) {
                        break;
                    }
                    address = parseAAnswer(packet.getData(), packet.getLength(), host);
                }
            } catch (Exception unresolved) {
                address = null; // resolve failure is not an error: caller falls back to the old address
            } finally {
                if (socket != null) socket.close();
                if (lock != null) lock.release();
            }
            JSObject result = new JSObject();
            try {
                result.put("address", address == null ? JSONObject.NULL : address);
            } catch (org.json.JSONException invalid) {
                call.reject("INVALID_RESULT");
                return;
            }
            call.resolve(result);
        }, "neo-lan-dns");
        worker.setDaemon(true);
        worker.start();
    }

    /** Standard DNS query: header + one question (host, A, IN). */
    private static byte[] buildQuery(String host) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(host.length() + 18);
        out.write(0); out.write(0); // ID 0
        out.write(0); out.write(0); // flags 0 (standard query)
        out.write(0); out.write(1); // QDCOUNT 1
        out.write(0); out.write(0); // ANCOUNT
        out.write(0); out.write(0); // NSCOUNT
        out.write(0); out.write(0); // ARCOUNT
        for (String label : host.split("\\\\.")) {
            byte[] bytes = label.getBytes(StandardCharsets.US_ASCII);
            out.write(bytes.length);
            out.write(bytes, 0, bytes.length);
        }
        out.write(0);               // root label
        out.write(0); out.write(1); // QTYPE = A
        out.write(0); out.write(1); // QCLASS = IN
        return out.toByteArray();
    }

    /** Walks the answer section for an A record whose owner name equals host. */
    private static String parseAAnswer(byte[] data, int length, String host) {
        if (length < 12) return null;
        int questions = ((data[4] & 0xff) << 8) | (data[5] & 0xff);
        int answers = ((data[6] & 0xff) << 8) | (data[7] & 0xff);
        int offset = 12;
        for (int i = 0; i < questions; i++) {
            offset = skipName(data, offset, length);
            if (offset < 0 || offset + 4 > length) return null;
            offset += 4; // QTYPE + QCLASS
        }
        for (int i = 0; i < answers; i++) {
            int[] afterName = new int[1];
            String owner = readName(data, offset, length, afterName);
            offset = afterName[0];
            if (owner == null || offset + 10 > length) return null;
            int type = ((data[offset] & 0xff) << 8) | (data[offset + 1] & 0xff);
            int rdLength = ((data[offset + 8] & 0xff) << 8) | (data[offset + 9] & 0xff);
            int rdStart = offset + 10;
            if (type == 1 && rdLength == 4 && rdStart + 4 <= length && host.equalsIgnoreCase(owner)) {
                return String.format(Locale.US, "%d.%d.%d.%d",
                    data[rdStart] & 0xff, data[rdStart + 1] & 0xff, data[rdStart + 2] & 0xff, data[rdStart + 3] & 0xff);
            }
            offset = rdStart + rdLength;
        }
        return null;
    }

    private static int skipName(byte[] data, int offset, int limit) {
        int[] end = new int[1];
        return readName(data, offset, limit, end) != null ? end[0] : -1;
    }

    /**
     * Reads one (possibly compressed) domain name. end[0] is set to the offset just past this
     * name in the ORIGINAL record position; returns null on malformed input.
     */
    private static String readName(byte[] data, int offset, int limit, int[] end) {
        StringBuilder name = new StringBuilder();
        int cursor = offset;
        int jumps = 0;
        int afterName = -1;
        while (cursor < limit) {
            int length = data[cursor] & 0xff;
            if (length == 0) {
                if (afterName < 0) afterName = cursor + 1;
                break;
            }
            if ((length & 0xc0) == 0xc0) {
                if (cursor + 1 >= limit || ++jumps > 8) return null;
                if (afterName < 0) afterName = cursor + 2;
                cursor = ((length & 0x3f) << 8) | (data[cursor + 1] & 0xff);
                continue;
            }
            if (cursor + 1 + length > limit || (length & 0xc0) != 0) return null;
            if (name.length() > 0) name.append('.');
            name.append(new String(data, cursor + 1, length, StandardCharsets.US_ASCII));
            cursor += 1 + length;
        }
        if (cursor >= limit && afterName < 0) return null;
        end[0] = afterName < 0 ? cursor : afterName;
        return name.toString();
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
assembleDebugOffline({ cwd: resolve('android') });
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
