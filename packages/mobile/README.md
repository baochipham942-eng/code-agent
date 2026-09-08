# Neo mobile preview

Independent React/Capacitor entry. Desktop renderer and Host are unchanged. Native
preferences, lifecycle, keyboard and installed AppInfo are isolated behind
`src/platform/ports.ts`. No Host, recording, push, pairing or credential access is
implemented by this foundation package. A send attempt retains its draft until a
future authenticated Host adapter acknowledges it.

Use the assigned remote runner for all dependency installation and execution.
The `pre*` scripts reject local sessions. Do not install an SDK on the editing Mac.

```sh
npm ci
npm run typecheck
npm test
# Set ANDROID_HOME and JAVA_HOME to the runner's existing SDK/JDK.
NEO_MOBILE_BUILD=1 NEO_MOBILE_FIXTURES=1 npm run android:build
```

The build script generates the Android project from pinned Capacitor dependencies,
sets versionName from this package and versionCode from `NEO_MOBILE_BUILD`, then
builds offline using the existing Gradle cache. It does not silently install SDKs.
`android/`, dependencies, packages and reports stay outside Git. Check the generated
manifest's sourceDirty flag; delivery packages must come from a clean commit.
The preview identity is separate from the historical Spike app. Increase the build
number for every update. An update uses `adb -s SERIAL install -r APK`; uninstalling
is a different operation and is not used to demonstrate retained preferences.

`NEO_MOBILE_FIXTURES=1` enables explicitly labelled sample history in the preview
build; the default bundle has no fake conversations. A fixture conversation has
1,000 rows plus 20 timed appends. Only a viewport window is rendered. Fixture UI
and injected text cannot prove real Host operation or Chinese IME behavior.

Validate the new package on the dedicated emulator using `android:verify` with an
explicit serial, APK and matching ChromeDriver (see script arguments). Screenshots,
result JSON and the APK manifest belong in the private evidence archive. iPhone
installation, keyboard, voice, cross-network operation and APNs remain separate
device acceptance. The underlying native API references are [App](https://capacitorjs.com/docs/apis/app),
[Keyboard](https://capacitorjs.com/docs/apis/keyboard) and [Preferences](https://capacitorjs.com/docs/apis/preferences).

## iOS Ad Hoc trial builds

```sh
# Requires full Xcode (not just Command Line Tools), an iOS Distribution identity and
# an Ad Hoc profile covering the target iPhone.
NEO_MOBILE_BUILD=2 npm run ios:build
npm run ios:verify .artifacts/neo-mobile-0.1.0-2.ipa
```

The script generates the Xcode project from the pinned Capacitor dependency
(Swift Package Manager, no CocoaPods), stamps `MARKETING_VERSION` from this package
and `CURRENT_PROJECT_VERSION` from `NEO_MOBILE_BUILD`, adds the shared archive scheme
that a fresh `cap add ios` template lacks, then archives and exports an **Ad Hoc** IPA.
The manifest extends the Android shape with the Xcode/SDK versions and the signing
profile summary (name, UUID, expiry, method, device count). Device UDIDs never enter
the manifest; pass `NEO_IOS_EXPECTED_UDID` to record only whether the profile covers
that iPhone. Signing defaults to the Neo team `D7CVTJ72NV` via Xcode automatic
signing; set `NEO_IOS_PROFILE` and `NEO_IOS_IDENTITY` (or `NEO_IOS_SIGNING_STYLE=manual`)
for an explicit profile. The script fails up front with the exact missing
prerequisite (Xcode, identity or profile) instead of building an uninstallable package.

`ios:verify IPA [HANDOFF_COPY]` is the pre-install self-check (MI-03): the exported
IPA hash matches the manifest (and the copy being handed over is byte-identical),
the embedded provisioning profile is Ad Hoc, unexpired and team-matched, the bundle
version comes from the built package rather than a design mock, and the code
signature names the team. On-iPhone install and update acceptance (MI-01/02) stay
with the device.

试用安装与更新（给使用者）：

1. 没有蒲公英扫码入口。不要打开自称安装页的网页。IPA **不进 git**，由舰队机 `ios:build` 产出。
2. 构建产物在舰队 `.artifacts/neo-mobile-<版本>-<build>.ipa`（旁路 `.ipa.json` 清单含 sha256）。
   本机交接副本：`~/Downloads/neo-mobile-ipa/`。
3. 用数据线把 iPhone 连到本机，Apple Configurator 安装：
   `cfgutil install-app neo-mobile-<版本>-<build>.ipa`
   （profile 必须覆盖这台 iPhone；`ios:build` / `ios:verify` 在缺 `NEO_IOS_EXPECTED_UDID` 或覆盖失败时直接退出）。
4. 更新：更高 build 号的 IPA 直接覆盖安装（同一团队、同一 Bundle ID），不要先卸载。
5. 装不上先看清单 `signing.profile`：过期或不是 ad-hoc 都装不上，重新出包。
