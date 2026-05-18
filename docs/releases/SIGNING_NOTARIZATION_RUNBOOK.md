# macOS 签名与公证 Runbook

> Agent Neo (Tauri) 端到端发版手册。读这篇能让你从零起步，签出一个用户双击就能跑、
> 离线也不弹 "unverified developer" 警告的 dmg。
>
> 适用范围：Apple Silicon (aarch64) + macOS 13+。Intel 走相同流程但 target triple 是 `x86_64-apple-darwin`。
>
> 关键路径全部使用绝对路径，方便 copy-paste。

---

## 章节速查

1. [首次配置](#1-首次配置一次性30-min) — 一次性 ~30 min
2. [每次发版](#2-每次发版) — 自动化 5 min / 手动 ~30 min
3. [Troubleshooting](#3-troubleshooting) — 已知坑速查表

---

## 1. 首次配置（一次性，~30 min）

### 1.1 Apple Developer 账号

- 注册 https://developer.apple.com/programs/enroll/ ，年费 $99
- 等账号 active 后登录 https://developer.apple.com/account ，**接受最新版 License Agreement**（不接受后续 notarytool 会 401）

### 1.2 生成 CSR（跳过 Keychain Access GUI）

不要用 Keychain Access "证书助理"，命令行版可重复执行：

```bash
mkdir -p $HOME/.code-agent-release && cd $HOME/.code-agent-release

# 生成 2048-bit RSA 私钥
openssl genrsa -out developer-id.key 2048

# 用私钥生成 CSR（Common Name 随便填，Apple 后台会忽略）
openssl req -new -key developer-id.key -out developer-id.csr \
  -subj "/emailAddress=zhangcouchai@gmail.com/CN=Lin Chen/C=CN"
```

产物：
- `$HOME/.code-agent-release/developer-id.key` — RSA 私钥（**永远不提交 git**）
- `$HOME/.code-agent-release/developer-id.csr` — CSR，准备上传

### 1.3 上传 CSR → 下载 Developer ID Application 证书

- 打开 https://developer.apple.com/account/resources/certificates/add
- 选 **Developer ID Application**（注意不是 "Apple Distribution"，那是 App Store 用的）
- 上传 `developer-id.csr`
- 下载得到 `developerID_application.cer`，丢到 `$HOME/.code-agent-release/`

### 1.4 装证书 + 私钥到 Keychain

```bash
cd $HOME/.code-agent-release

# 把 .cer + 私钥合并成 .p12（双击 .cer 装的话只有公钥，签名时会缺私钥）
openssl pkcs12 -export \
  -inkey developer-id.key \
  -in developerID_application.cer \
  -out developer-id.p12 \
  -name "Developer ID Application: Lin Chen" \
  -passout pass:CHANGE_ME_P12_PASSWORD

# 导入到默认 keychain
security import developer-id.p12 \
  -k ~/Library/Keychains/login.keychain-db \
  -P CHANGE_ME_P12_PASSWORD \
  -T /usr/bin/codesign \
  -T /usr/bin/security

# 允许 codesign 静默访问（避免每次都弹 keychain 窗）
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s -k <login-keychain-password> \
  ~/Library/Keychains/login.keychain-db
```

> 即便跑了 `set-key-partition-list`，**首次 codesign 仍会弹一次 "允许"** —— 那次点 **"始终允许"**，之后就不再弹了。

验证装好了：

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
# 应输出: 1) <HASH> "Developer ID Application: Lin Chen (TEAMID)"
```

记下 **TEAMID**（10 字符），后面 notarytool 要用。

### 1.5 App-Specific Password + notarytool 凭证

- 打开 https://account.apple.com/account/manage → 登录 → 安全 → App-Specific Passwords
- 生成一个名为 "code-agent-notarize"，得到形如 `xxxx-xxxx-xxxx-xxxx` 的密码
- 存到 keychain（一次性，之后所有 notarytool 调用都用这个 profile 名）：

```bash
xcrun notarytool store-credentials "code-agent-notary" \
  --apple-id "zhangcouchai@gmail.com" \
  --team-id "<TEAMID>" \
  --password "xxxx-xxxx-xxxx-xxxx"
```

验证：

```bash
xcrun notarytool history --keychain-profile "code-agent-notary"
# 头一次为空就对了，能跑通说明凭证有效
```

### 1.6 Tauri updater 密钥对

```bash
cd $HOME/.code-agent-release

# 生成 ed25519 密钥对（不要设密码 / 或者把密码记到 .env.release 里）
cargo tauri signer generate -w tauri-updater.key

# 产物:
#   tauri-updater.key      — 私钥（构建时用）
#   tauri-updater.key.pub  — 公钥（写进 tauri.conf.json）
```

把公钥写进 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 字段：

```bash
cat $HOME/.code-agent-release/tauri-updater.key.pub
# 把输出粘到 tauri.conf.json
```

### 1.7 Control-plane 密钥对

```bash
cd /Users/linchen/Downloads/ai/code-agent
node scripts/generate-control-plane-env.mjs
# 输出会告诉你把 PUBLIC_KEY 放哪、PRIVATE_KEY 放哪
```

- 公钥环境变量 `CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS` → 写进 `.env.release`（客户端构建时打包）
- 私钥环境变量 → 写进 Vercel project env（**绝对不进客户端 bundle**）

### 1.8 写 `~/.code-agent-release/.env.release`

```bash
cat > $HOME/.code-agent-release/.env.release <<'EOF'
# ===== Apple 签名 / 公证 =====
APPLE_SIGNING_IDENTITY="Developer ID Application: Lin Chen (TEAMID)"
APPLE_ID="zhangcouchai@gmail.com"
APPLE_TEAM_ID="<TEAMID>"
APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
APPLE_KEYCHAIN_PROFILE="code-agent-notary"

# ===== Tauri updater =====
# 路径变量，方便人类查看
TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.code-agent-release/tauri-updater.key"
TAURI_UPDATER_PUBKEY="<paste tauri-updater.key.pub content>"

# 🔑 关键：cargo tauri build 内部只读 TAURI_SIGNING_PRIVATE_KEY（值 = 私钥文本，不是路径）
# 漏设会报 "A public key has been found, but no private key" → build exit 1
# 启动 release 脚本时再 cat 注入，不要直接把私钥文本写在这里（避免 cat .env.release 时泄露）
# TAURI_SIGNING_PRIVATE_KEY 在脚本里 export，见下方

# ===== Control plane =====
CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS='<paste pubkey json>'

# ===== 强制 notarize =====
REQUIRE_NOTARIZATION=1
EOF

chmod 600 $HOME/.code-agent-release/.env.release
```

在 release 脚本里这样 source：

```bash
set -a
source $HOME/.code-agent-release/.env.release
export TAURI_SIGNING_PRIVATE_KEY="$(cat $TAURI_SIGNING_PRIVATE_KEY_PATH)"
set +a
```

---

## 2. 每次发版

### 2.1 推荐：一键自动化（5 min）

```bash
cd /Users/linchen/Downloads/ai/code-agent
bash scripts/publish-release.sh
```

脚本会依次：
1. source `~/.code-agent-release/.env.release` 并把私钥内容注入 `TAURI_SIGNING_PRIVATE_KEY`
2. `npm run tauri:release:bundle`（含递归签 nested .node/.dylib + notarize + staple dmg）
3. 挂载 dmg → cp .app 到 `/Applications/` → 单独 staple 装机版
4. `gh release create` 上传 dmg + `latest.json` + `.app.tar.gz` + `.sig` 到 GitHub

> 如果 `scripts/publish-release.sh` 不存在或不可用，走下面的手动流程。

### 2.2 手动版（~30 min）

#### Step 1: bump 版本

```bash
cd /Users/linchen/Downloads/ai/code-agent
NEW_VERSION="0.16.61"  # 改成你要的版本号

npm version $NEW_VERSION --no-git-tag-version

# 同步 tauri.conf.json
node -e "
  const fs = require('fs');
  const p = 'src-tauri/tauri.conf.json';
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  c.version = '$NEW_VERSION';
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + '\n');
"

git add package.json package-lock.json src-tauri/tauri.conf.json
git commit -m "chore: bump version to $NEW_VERSION"
```

#### Step 2: 验证生产 env

```bash
set -a
source $HOME/.code-agent-release/.env.release
export TAURI_SIGNING_PRIVATE_KEY="$(cat $TAURI_SIGNING_PRIVATE_KEY_PATH)"
set +a

node scripts/verify-production-env.mjs --mode notarized
```

任何一个变量缺失这里就会报具体名字。**这一步过不了就不要往下走。**

#### Step 3: 签名 + 公证 + staple dmg

```bash
HTTPS_PROXY=http://127.0.0.1:7897 \
REQUIRE_NOTARIZATION=1 \
  npm run tauri:release:bundle
```

> 🪟 **首次 codesign 会弹 keychain 窗 — 30 秒内点 "始终允许"。**
> 等超过 5 分钟会报 `timestamps differ by N seconds`（详见 §3）。

产物：
- `src-tauri/target/release/bundle/dmg/Agent Neo_<version>_aarch64.dmg`（已 staple）
- `src-tauri/target/release/bundle/macos/Agent Neo.app.tar.gz` + `.sig`（updater 用）
- `latest.json`（updater manifest）

#### Step 4: 装机版单独 staple

```bash
DMG="src-tauri/target/release/bundle/dmg/Agent Neo_${NEW_VERSION}_aarch64.dmg"

hdiutil attach "$DMG"
rm -rf "/Applications/Agent Neo.app"
cp -R "/Volumes/Agent Neo/Agent Neo.app" /Applications/
hdiutil detach "/Volumes/Agent Neo"

# 🎟️ 关键：dmg 重建在 staple 之前，dmg 里的 .app 本身没有 ticket
# 离线 / 首次启动会弹警告，必须补 staple
xcrun stapler staple "/Applications/Agent Neo.app"
xcrun stapler validate "/Applications/Agent Neo.app"
spctl --assess --type execute -vv "/Applications/Agent Neo.app"
```

#### Step 5: 上传到 GitHub Release

```bash
gh release create "v${NEW_VERSION}" \
  --title "v${NEW_VERSION}" \
  --notes-file "docs/releases/v${NEW_VERSION}.md" \
  "$DMG" \
  "src-tauri/target/release/bundle/macos/Agent Neo.app.tar.gz" \
  "src-tauri/target/release/bundle/macos/Agent Neo.app.tar.gz.sig" \
  "src-tauri/target/release/bundle/macos/latest.json"
```

#### Step 6: push tag

```bash
git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"
git push origin main
git push origin "v${NEW_VERSION}"
```

---

## 3. Troubleshooting

> 这部分是这篇 runbook 真正的价值。每一条都是踩过的坑。

### ❌ `timestamps differ by N seconds - check your system clock`

**症状**：codesign 报系统时间偏差，但 `date` 看时间是对的。

**根因**：**不是真的时钟漂移**。首次 release codesign 访问私钥时会弹 keychain 授权窗，
如果点击拖延（实测 294 秒触发），codesign 拿到的本地时间会和 Apple timestamp server
返回的时间差超过容忍阈值，于是抱怨"时钟不准"。

**解决**：
1. 看到 keychain 窗立刻点 **"始终允许"**（不是 "允许" —— 前者一劳永逸）
2. 之后重新跑 `npm run tauri:release:bundle`，不会再弹

如果已经设过 partition list 但还是弹，说明 keychain 锁了，先 `security unlock-keychain ~/Library/Keychains/login.keychain-db`。

---

### ❌ `A public key has been found, but no private key`

**症状**：`cargo tauri build` 在 bundle updater artifacts 时抱怨找不到私钥，exit 1。

**根因**：`.env.release` 里只设了 `TAURI_SIGNING_PRIVATE_KEY_PATH`（路径），但
`cargo tauri build` 内部读的是 `TAURI_SIGNING_PRIVATE_KEY`（**值 = 私钥文本**）。
两个变量名长得像但语义不同。

**解决**：

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat $HOME/.code-agent-release/tauri-updater.key)"
```

`set -e` 模式下这一步漏掉会让整个 release chain 在第一步中断，artifact 都不会生成。

---

### ❌ notarytool 返回 `binary is not signed with valid Developer ID`

**症状**：`xcrun notarytool submit` 上传成功但 `--wait` 后返回 status `Invalid`，
log 里指向某个 `.node` 或 `.dylib` 没签。

**根因**：Tauri 默认只签 main binary + `.app` 外壳。如果 bundle 里有 nested native
modules（比如 `better-sqlite3.node`、各种 ffi `.dylib`），它们需要**单独递归签名**。

**解决**：已经在 `scripts/tauri-release-bundle.sh` 里加了递归签名逻辑（`find .app -name '*.node' -o -name '*.dylib' | xargs codesign --force --options runtime --sign ...`）。如果再遇到，先用 `codesign --verify --deep --strict --verbose=4 "Agent Neo.app"` 定位哪个文件没签，把它加进递归列表。

---

### ❌ 装完启动 abort / hang

**症状**：双击 `/Applications/Agent Neo.app` → dock 跳一下就没了，或 hang 在启动 splash。

**根因**：**端口 8180 被旧版本的 webServer 子进程占着。** Tauri 的 webServer 是
launchd 启动的，旧版本进程残留时新版本没法 bind 端口。

**解决**：

```bash
lsof -ti :8180 | xargs kill -9
killall "Agent Neo" 2>/dev/null
killall node 2>/dev/null  # 谨慎用，会杀别的 node 进程
open "/Applications/Agent Neo.app"
```

或直接重启 Mac（最暴力但管用）。

---

### ❌ `spctl rejected source=Code Agent Dev`

**症状**：装完 app `spctl --assess` 抱怨签名身份是 "Code Agent Dev" 而不是
"Developer ID Application: Lin Chen"。

**根因**：用了 `scripts/tauri-install.sh` 装 release dmg。该脚本默认
`SIGNING_IDENTITY="Code Agent Dev"`（dev 证书），cp 之后会用 dev 证书重签，
**直接毁掉 Developer ID 签名 + notarization ticket**。

**解决**：
1. 把 `/Applications/Agent Neo.app` 删掉
2. 重新从 release dmg 挂载 + `cp -R`（**不要走 tauri-install.sh**）
3. 单独 `xcrun stapler staple "/Applications/Agent Neo.app"`
4. 再 `spctl --assess --type execute -vv` 确认 source 是 "Notarized Developer ID"

`tauri-install.sh` **只适用于本地 dev 构建**，不要用在 release 产物上。

---

### ❌ `Agent Neo.app does not have a ticket stapled`

**症状**：dmg 验证 staple OK 但装机版的 .app 单独 `stapler validate` 报没 ticket。

**根因**：tauri-release-bundle 的执行顺序是 build → notarize → staple **dmg**，
dmg 在 staple 之前就已经重建过了，所以 dmg **内**的 .app 本身没 ticket，只有
dmg 外壳有 ticket。

**解决**：装到 /Applications 后单独补一刀：

```bash
xcrun stapler staple "/Applications/Agent Neo.app"
xcrun stapler validate "/Applications/Agent Neo.app"
```

为啥要补：在线状态 spctl 会去 Apple ticket DB 联网查，看似 accepted；但**离线**
或**首次启动时** Gatekeeper 找不到本地 ticket 就会弹 "unverified developer" 警告。
补一刀就一劳永逸。

---

## 附录：常用 verify 命令

```bash
# 列出 keychain 里的签名身份
security find-identity -v -p codesigning

# 看 .app 的签名详情
codesign --display --verbose=4 "/Applications/Agent Neo.app"

# 验证签名 + 递归
codesign --verify --deep --strict --verbose=4 "/Applications/Agent Neo.app"

# 看 .app / dmg 的 staple ticket
xcrun stapler validate "/Applications/Agent Neo.app"
xcrun stapler validate "src-tauri/target/release/bundle/dmg/Agent Neo_*.dmg"

# Gatekeeper 评估
spctl --assess --type execute -vv "/Applications/Agent Neo.app"
spctl --assess --type open --context context:primary-signature -vv "<dmg path>"

# notarytool 历史
xcrun notarytool history --keychain-profile "code-agent-notary"

# 查某次 notarize 的详细 log
xcrun notarytool log <submission-id> --keychain-profile "code-agent-notary"
```
