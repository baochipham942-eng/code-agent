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
