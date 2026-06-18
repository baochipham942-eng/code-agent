# Release Checklist for Agent Neo

Use this checklist when all sessions have completed and the release is ready.

> ## ⚡ 发版路径：推 tag 触发 CI，不要本地打包
>
> **正式发版 = 源码侧准备 + `git push origin v<version>`**。tag push 触发 `.github/workflows/release.yml`「Build and Release」，自动完成构建 / Developer ID 签名 / 公证 staple / OSS 上传（versioned + `stable/latest.json` + `stable/release.json`）/ GitHub Release / Vercel update API。
>
> 源码侧准备：`npm version <ver>` + 同步 `src-tauri/tauri.conf.json` + 写 `docs/releases/v<ver>.md`（= update API 的 releaseNotes）+ 更新 CHANGELOG + 跑只读门（`release:security-scan` / `verifyProductionEnv` / `releaseMacosGates` 测试）→ commit `chore: release v<ver>` → push main → tag → push tag。
>
> **本地 `npm run tauri:release:bundle` 只用于调试**，正式发版不需要（踩坑 2026-06-09：本地构建 20min 且会撞本机 syspolicyd EMFILE 导致 spctl 误报；CI 在干净 runner 上签名公证更可靠）。下面的手动 macOS gate 章节是 CI 内部逻辑的等价说明，供排查 CI 失败时参考，不是日常手动步骤。

## Pre-Release Verification

### Session Completion
- [ ] Session A (Security) completed A1-A15
- [ ] Session B (Tools/Context) completed B1-B16
- [ ] Session C (Prompts/Hooks) completed C1-C18
- [ ] Session D (Quality) completed D1-D15

### Branch Status
- [ ] `feature/security` branch up to date
- [ ] `feature/tools-context` branch up to date
- [ ] `feature/prompts-hooks` branch up to date
- [ ] `feature/quality` branch up to date

---

## Merge Process

### 1. Merge to develop
```bash
# In main repo (not worktree)
cd ~/Downloads/ai/code-agent

# Merge Session A
git merge feature/security --no-ff -m "Merge feature/security: Security module (A1-A15)"

# Merge Session B
git merge feature/tools-context --no-ff -m "Merge feature/tools-context: Tool enhancements (B1-B16)"

# Merge Session C
git merge feature/prompts-hooks --no-ff -m "Merge feature/prompts-hooks: Prompts and hooks (C1-C18)"

# Merge Session D
git merge feature/quality --no-ff -m "Merge feature/quality: Testing and documentation (D1-D15)"
```

### 2. Resolve Conflicts
- [ ] No merge conflicts, OR
- [ ] All conflicts resolved and tested

---

## Build Verification (D12)

### Type Check
```bash
npm run typecheck
```
- [ ] Type check passes with no errors

### Build
```bash
npm run build
```
- [ ] Build completes successfully
- [ ] No build warnings (or warnings are acceptable)

### Test Suite
```bash
npm run test
```
- [ ] All tests pass
- [ ] Scaffold tests (.todo) are expected to be skipped

---

## Version Update (D11)

### package.json
```bash
# Update version
npm version <version> --no-git-tag-version
```
- [ ] `package.json` and `package-lock.json` updated to `<version>`
- [ ] `src-tauri/tauri.conf.json` version updated to `<version>`

### Update Metadata
- [ ] `docs/releases/v<version>.md` contains the user-facing update notes
- [ ] `stable/latest.json.notes` is generated from `docs/releases/v<version>.md`
- [ ] `stable/release.json.body` is generated from `docs/releases/v<version>.md`
- [ ] Release policy env is set only when needed: `UPDATE_MIN_VERSION[_CHANNEL]`, `UPDATE_FORCE_UPDATE[_CHANNEL]`, `UPDATE_SHA256[_CHANNEL]`
- [ ] No manual version constant edit is needed in `vercel-api/api/update.ts`
- [ ] Recommended remote skill repositories are not auto-downloaded unless `CODE_AGENT_ALLOW_RECOMMENDED_SKILL_AUTO_DOWNLOAD=1` is intentionally set
- [ ] Capability registry payload, if used, is signed through `CONTROL_PLANE_CAPABILITY_REGISTRY_JSON`

---

## macOS Release Gate

These checks are mandatory for external macOS distribution. Real notarization
requires Apple credentials and must not be marked complete from a dry run.

### Required Secrets

- [ ] `APPLE_CERTIFICATE_P12_BASE64`
- [ ] `APPLE_CERTIFICATE_PASSWORD`
- [ ] `APPLE_KEYCHAIN_PASSWORD`
- [ ] `APPLE_SIGNING_IDENTITY` with a `Developer ID Application:` identity
- [ ] Apple notarization credentials: `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` or `APPLE_PASSWORD` + `APPLE_TEAM_ID`, or API key credentials
- [ ] `TAURI_UPDATER_PUBKEY`
- [ ] `TAURI_SIGNING_PRIVATE_KEY` — 🔑 **必须是私钥文件内容，不是文件路径**
  - release env 里通常存的是 `TAURI_SIGNING_PRIVATE_KEY_PATH`（路径），但 `cargo tauri build` 内部只读 `TAURI_SIGNING_PRIVATE_KEY`（值 = 私钥文本）
  - 漏设会报 `A public key has been found, but no private key`，`cargo tauri build` exit 1，`set -e` 会让整个 release chain 中断
  - 正确做法：`export TAURI_SIGNING_PRIVATE_KEY="$(cat $HOME/.code-agent-release/tauri-updater.key)"`
- [ ] `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the private key is encrypted
- [ ] Control-plane public key env: `CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS` or `CODE_AGENT_CONTROL_PLANE_KEY_ID` + `CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY`
- [ ] Vercel/control-plane signing private key is configured outside the client bundle

### Offline Env Verification

Run this before any real release packaging. It fails before `cargo tauri build`
when a required production secret is missing, and the error lists the exact
missing variable or variable group.

```bash
node scripts/verify-production-env.mjs --mode notarized
```

For local release-chain checks that must not require Apple credentials:

```bash
node scripts/verify-production-env.mjs --mode local
```

- [ ] Production env verifier passes in notarized mode before packaging
- [ ] Local mode is used only for dry runs and is not marked as release completion

### Static and Script Checks

```bash
node scripts/verify-production-env.mjs --mode notarized
bash -n scripts/tauri-release-bundle.sh scripts/tauri-notarize.sh scripts/verify-macos-release.sh
node -e "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8'))"
npx vitest run tests/scripts/verifyProductionEnv.test.ts
npx vitest run tests/scripts/releaseMacosGates.test.ts
npm run release:security-scan
```

- [ ] Production env verifier passes
- [ ] Shell scripts parse
- [ ] `package.json` parses
- [ ] Production env verifier tests pass
- [ ] Release gate tests pass
- [ ] Release security scan passes

### Signed Build, Notarization, and Verification

```bash
REQUIRE_NOTARIZATION=1 npm run tauri:release:bundle
```

> 🪟 **首次跑 codesign 会弹 keychain 确认窗 — 30 秒内必须点击**
> codesign 访问 Developer ID 私钥时会弹 macOS keychain 授权窗。如果点击拖延超过 ~5 分钟（实测 294 秒），
> codesign 拿到的本地时间会和 Apple timestamp server 时间差超过容忍阈值，报
> `timestamps differ by N seconds - check your system clock` —— **这不是真的时钟漂移**，是等弹窗等出来的。
> 解决：弹窗一出立刻点 **"始终允许"**（不是 "允许"，前者一劳永逸，下次 release 不再弹）。

- [ ] Build fails if updater public key is missing
- [ ] Build fails if updater private key is missing
- [ ] Build fails if control-plane public keys are missing
- [ ] Build fails if Apple notarization credentials are incomplete
- [ ] Build fails if Developer ID signing identity is missing or not `Developer ID Application:`
- [ ] DMG notarization uses `xcrun notarytool submit --wait`
- [ ] DMG staple succeeds and `xcrun stapler validate` passes
- [ ] App staple validate passes when the app bundle is present
- [ ] `verify-macos-release.sh` passes `codesign --verify --deep --strict`
- [ ] App and DMG signatures contain `Authority=Developer ID Application:`
- [ ] App and DMG signatures contain a non-empty `TeamIdentifier`
- [ ] App passes `spctl --assess --type execute`
- [ ] DMG passes `spctl --assess --type open --context context:primary-signature`
- [ ] Bundled `dist/web/control-plane-public-keys.json` exists and contains at least one key
- [ ] Updater artifacts are present: `.app.tar.gz`, `.app.tar.gz.sig`, `latest.json`
- [ ] Updater artifact names are normalized for remote hosting: `Agent.Neo.app.tar.gz` and `Agent.Neo.app.tar.gz.sig`

### Test Package

> 🚫 **禁止用 `scripts/tauri-install.sh` 安装 release dmg**
> 该脚本默认 `SIGNING_IDENTITY="Code Agent Dev"`，cp 之后会用 dev 证书重签，
> **直接毁掉 Developer ID 签名 + notarization ticket**，安装后 `spctl` 会 rejected。
> tauri-install.sh 只适用于本地 dev 构建，不要用在 release dmg 上。
>
> 正确做法（二选一）：
> - 推荐：`bash scripts/publish-release.sh`（自动化挂载/拷贝/staple/GitHub upload）
> - 手动：从 dmg 挂载，`cp -R "/Volumes/Agent Neo/Agent Neo.app" /Applications/`

```bash
# 从已 staple 的 dmg 安装
hdiutil attach "src-tauri/target/release/bundle/dmg/Agent Neo.dmg"
cp -R "/Volumes/Agent Neo/Agent Neo.app" /Applications/
hdiutil detach "/Volumes/Agent Neo"
```

> 🎟️ **安装到 /Applications 后必须单独 staple .app**
> dmg 重建发生在 staple 之前，所以 dmg 内的 .app 本身**没有 staple ticket**（只 dmg 有 ticket）。
> 安装后联网状态下 `spctl` 还能 accepted（会去 Apple ticket DB 查），但
> **离线 / 首次启动可能弹 "unverified developer" 警告**。必须补这一刀：

```bash
xcrun stapler staple "/Applications/Agent Neo.app"
xcrun stapler validate "/Applications/Agent Neo.app"
spctl --assess --type execute -vv "/Applications/Agent Neo.app"
```

- [ ] `/Applications/Agent Neo.app` 单独 `xcrun stapler staple` 通过
- [ ] `xcrun stapler validate` 在装机版 app 上 pass（说明 ticket 写入成功）
- [ ] App launches without errors
- [ ] `http://127.0.0.1:8180/api/health` returns 200 within the Tauri healthcheck window
- [ ] Basic functionality works (new session, send message)
- [ ] Security features work (audit log created)
- [ ] Hooks configuration loads
- [ ] Update check behavior is correct:
  - old installed version shows update to `<version>`
  - installed `<version>` reports `hasUpdate=false`
- [ ] App file logs are fresh after launch and smoke:
  ```bash
  ls -lt "$HOME/Library/Application Support/code-agent/logs" | head
  find "$HOME/Library/Application Support/code-agent/logs" -maxdepth 1 -type f -mtime -1 -print
  ```
- [ ] Computer Use helper resource usage is sane during idle:
  ```bash
  ps -axo pid,pcpu,pmem,comm | rg 'cua-driver|Agent Neo Computer Use|SkyComputerUse'
  # If a helper stays above ~20% CPU while idle, capture a short sample for triage.
  sample <pid> 5 -file /tmp/agent-neo-cua-driver.sample.txt
  ```

---

## Documentation (D14)

### Release Notes
- [ ] `docs/releases/v<version>.md` updated with final content
- [ ] Bug fixes section populated
- [ ] Known issues updated
- [ ] GitHub Release body matches `docs/releases/v<version>.md`
- [ ] Tauri updater manifest `latest.json.notes` shows the same release notes that should appear in the update modal

### CHANGELOG
- [ ] `CHANGELOG.md` [Unreleased] section moved to `[<version>]`
- [ ] Release date added

---

## Final Release (D15)

### Commit Version Update
```bash
git add package.json package-lock.json src-tauri/tauri.conf.json CHANGELOG.md docs/releases/v<version>.md
git commit -m "chore: release v<version>"
```

### Create Tag
```bash
git tag -a v<version> -m "Release v<version>"
```

### Push
```bash
git push origin main
git push origin v<version>
```

### Publish GitHub and OSS Artifacts

- [ ] GitHub Release `v<version>` exists and contains `Agent.Neo.dmg`, `Agent.Neo.app.tar.gz`, `Agent.Neo.app.tar.gz.sig`, and `latest.json`
- [ ] OSS version directory contains `Agent-Neo-<version>-arm64.dmg`, `Agent.Neo.app.tar.gz`, and `Agent.Neo.app.tar.gz.sig`
- [ ] OSS `stable/latest.json` points to `v<version>/Agent.Neo.app.tar.gz`
- [ ] OSS `stable/release.json` points to `v<version>/Agent-Neo-<version>-arm64.dmg`

### Verify API
```bash
curl "https://agentneo.vercel.app/api/update?action=check&version=0.0.0&platform=darwin&channel=stable"
curl -I "https://agentneo.vercel.app/api/update?action=download&version=0.0.0&platform=darwin&channel=stable"
npm run release:post-publish -- --version <version>
```
- [ ] API returns latest version `<version>`
- [ ] API returns non-empty `releaseNotes`
- [ ] Download endpoint redirects to the OSS DMG for `<version>`
- [ ] Distribution page `/code-agent/` has a visible version slot and reads the same update API version
- [ ] Control-plane `renderer_bundle_rollout`, OSS `renderer-bundle/latest/manifest.json`, OSS `release-record.json`, and app update `latestVersion` all point at `<version>`
- [ ] Control-plane renderer rollout is not `rollbackToBuiltin=true`
- [ ] `/api/update?action=health` source is understood:
  - `github_releases` is an expected functional fallback when Cloud API metadata publish is not configured
  - use `--require-cloud-api-metadata` only when this release is meant to require the Cloud API publish path

### Verify Server Logs

Export a bounded production log window after smoke traffic, then let the post-publish verifier scan for 5xx and error-level log pollution.

```bash
# Run from a shell with Vercel access. Keep the window tight to the release smoke.
vercel logs https://agentneo.vercel.app --since 30m > /tmp/agent-neo-vercel.log
npm run release:post-publish -- --version <version> --server-log-file /tmp/agent-neo-vercel.log
```

- [ ] No 5xx entries during release smoke
- [ ] No error-level `DEP0169` / `url.parse()` deprecation warnings
- [ ] If logs are not available in the current shell, record that as a permission boundary instead of marking server log audit complete

### Verify Renderer Production Alignment

Use the signed verifier when public keys are available:

```bash
npm run renderer:verify-production -- --expected-version-from-app-update --include-remote-snapshot
```

If local public keys are missing and the signed verifier exits before trust verification can complete, keep the failure visible and run the read-only post-publish verifier for alignment:

```bash
npm run release:post-publish -- --version <version>
```

- [ ] Signed verifier passes, or the missing public-key boundary is explicitly recorded
- [ ] Read-only verifier shows app update, control-plane rollout, OSS manifest, and release-record aligned to `<version>`

---

## Post-Release

### Cleanup Worktrees
```bash
git worktree remove ~/.claude-worktrees/code-agent/security
git worktree remove ~/.claude-worktrees/code-agent/tools-context
git worktree remove ~/.claude-worktrees/code-agent/prompts-hooks
git worktree remove ~/.claude-worktrees/code-agent/quality
```

### Delete Feature Branches
```bash
git branch -d feature/security
git branch -d feature/tools-context
git branch -d feature/prompts-hooks
git branch -d feature/quality
```

### Announcement
- [ ] Release notes published
- [ ] Users notified of update availability

---

## Rollback Plan

If critical issues are found:

- Prefer a superseding hotfix release when users may already have seen the version.
- If the bad version must be withdrawn from stable, republish `stable/latest.json` and `stable/release.json` from the last known-good version, then verify update check and download redirect again.
- Do not rewrite public release history unless the repository owner explicitly approves it.
