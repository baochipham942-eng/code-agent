# Neo Surface Execution completion audit

日期：2026-07-21

唯一产品与验收真相源：docs/plans/2026-07-20-surface-execution-browser-computer-use.md

结论：方案第 24 节九项完成条件全部满足。P0、P1、P2 均已逐项给出 implemented + verified 或 evidence-backed defer；当前 gate 为 passed，blockingStatuses 为空。G3/G4 defer 均保留 fail-closed 边界，没有被本地 fixture、动作调用成功或旧证据冒充为生产完成。

## 1. 基线与验收对象

| 字段 | 最终值 |
|---|---|
| worktree | /Users/linchen/.codex/worktrees/aedb/code-agent |
| branch | codex/surface-execution-v1 |
| origin/main | 719660e20dcd47aa77fbc1277c2379082ae4db0d |
| HEAD | af6f0f2989013e18923184b36de12359499ddd5e |
| merge-base | 719660e20dcd47aa77fbc1277c2379082ae4db0d |
| ahead / behind | 1 / 0 |
| campaign | surface-v1-20260721T033951Z-af6f0f298901 |
| campaign startedAt | 2026-07-21T03:39:51.214Z |
| Surface source fingerprint | d60e72a1204a7026473317698bd9df5e602931bbbb54395d8d918efbf89675fa |
| gate generatedAt | 2026-07-21T03:46:45.029Z |
| gate result | passed，exitCode 0，blockingStatuses [] |

开工、跨 30 分钟执行点和最终收口均执行 git fetch origin，并以 origin/main 而非共享 checkout 的本地 main 为基线。主 checkout 中的方案原件先只读，再落入独立 worktree；最终 cmp 退出 0，两个文件逐字节一致。当前 proof 只接受相同 campaign、HEAD 和 source fingerprint 的运行证据。

第一轮会话截图 campaign 因外层虚拟列表截图出现超长空白区而判为无效，整批证据已可恢复地移至 /tmp/neo-surface-proof-backup.DXmpqs；本报告只引用上表的新 campaign。更早的 proof 备份位于 /tmp/neo-surface-proof-backup.pgcjA，也不参与结论。

## 2. 依赖图与实现收口

~~~mermaid
flowchart LR
  A["Surface V1 contract + redaction"] --> B["Session owner / grant / observation / run control"]
  B --> C["Managed Browser V2"]
  B --> D["Relay Browser V2 lease boundary"]
  B --> E["Computer Adapter V2"]
  C --> F["Shared result / proof / continuation projection"]
  D --> F
  E --> F
  F --> G["Conversation timeline / evidence / output / intervention / PiP"]
  F --> H["Durable export / replay / P2 authority-policy-provider seams"]
  G --> I["Fresh runtime acceptance proofs"]
  H --> I
  I --> J["T0 / T1 / P0-P2 gate report"]
~~~

实现进入了真实调用链：

- 共享合同与兼容：src/shared/contract/surfaceExecution.ts、browserRelay.ts、desktop.ts，以及 shared redaction/export projection。既有 browser/computer tool 名保持不变，旧消息、replay 和 session export 仍可读取。
- 控制平面：src/host/services/surfaceExecution/ 下的 Session、owner、grant、observation、interrupt、continuation、switch、proof、output、frame 和 provider registry；RunRegistry / SessionManager 路径接入取消和恢复。
- Browser Managed：ManagedBrowserProviderAdapter、BrowserElementRefFence、TargetRefRegistry、真实 DOM/AX/backend ref、successor verification、真实 input、upload TOCTOU、profile import approval 和 cleanup。
- Browser Relay：RelayBrowserProviderAdapter、BrowserTabLeaseService、browserRelayApprovalBoundary、protocol-v2 扩展、pairing/doctor；只在明确 tab/domain/action/time scope 内复用登录态，越权、过期、错 Agent、协议偏差均 fail-closed，结束后归还 tab。
- Computer：cuaStatefulComputerUse、computerUse、ComputerSurfaceEventProjection、macOS helper/PiP 路径；与 Browser 共用控制语义，但保留独立 target、permission、input lock 和 cleanup 边界。
- Conversation Execution UX：renderer 的 surfaceExecution 组件、store、controller、hooks、i18n、会话/导出/侧栏接入；持久展示语义时间线、截图三态、判断、产物、权限、接管、暂停、停止、结束和统一运行态。
- 证据与安全：SurfaceProofService、browserComputerProofStore、durable export/replay、diagnostic bundle、telemetry 与 canary redaction；原始 reasoning/thinking 和 secret/cookie/profile/input payload 不进入投影或导出。
- P2 seam：ExternalSurfaceAgentAdapter、SurfaceOrganizationPolicyService 和 SurfaceProviderRegistry 已实现 deny-default authority、redacted audit/TTL 与 provider gate；未在缺少生产 consumer/环境/决策证据时擅自激活。

## 3. 第 24 节逐项完成判断

| # | 完成条件 | 结论与证据 |
|---|---|---|
| 1 | P0/P1/P2 逐项结论 | 本报告第 4 节逐项列出 implemented + verified 或 evidence-backed defer，并给出 G3/G4 决策门。 |
| 2 | 合同进入真实 Browser/Computer 路径 | cross-surface proof 验证同一 Surface contract 路由真实 Managed Browser 与真实 Computer helper；legacy projection 可读。 |
| 3 | 会话持久展示动作、截图、判断、验证、接管、产物 | conversation 48/48；durable 39/39；截图与产物已实际打开复核。 |
| 4 | lease/grant/freshness/cancel/cleanup/redaction 红线 | T0 12/12；stop benchmark 20 样本无 post-stop mutation/cleanup failure；7 个 raw canary 扫描 69 文件为 0 泄漏。 |
| 5 | Managed/Relay/Computer/跨 Surface 运行证据 | 八份 canonical proof 全部 passed、issues 为空，绑定同一 campaign 与指纹。 |
| 6 | WorkBuddy 同型主验收 | 失败稿生成→System Chrome 打开→截图/DOM 判断失败→调整→重开→截图/DOM/像素复验→最终产物，19/19。 |
| 7 | 全部工程与运行门 | build、20 文件定向 Vitest、typecheck、lint、repository structure、Browser/Computer 8 phase、cancel cleanup、全量 Vitest 均退出 0。环境预检失败单列在第 7 节。 |
| 8 | completion audit 与精确证据 | 本文件包含基线、文件级变更、命令结果、proof SHA、截图 SHA、剩余风险与 HEAD。 |
| 9 | 不做未授权外部动作 | 未 push、未开 PR、未 merge、未 deploy、未提交扩展商店、未写生产数据。 |

## 4. P0 / P1 / P2 状态

### P0

| 项 | 状态 | 结论 / 决策门 |
|---|---|---|
| p0-a-contract-compatibility | implemented + verified | Surface V1 进入 Browser/Computer 真路径；旧消息与 legacy projection 可读。 |
| p0-b-runtime-control-plane | implemented + verified | owner、grant、observation、pause/resume/takeover/stop/end、successor verification、durable continuation 已验证。 |
| p0-c-browser-trust-boundary | implemented + verified | Relay exact tab/domain/action/time lease、协议、权限、真实输入、stale ref、tab return、orphan recovery、cleanup 已验证。 |
| p0-d-conversation-execution-ux | implemented + verified | 会话 header、语义时间线、证据三态、outputs/evidence/source 分区、折叠、PiP 与运行控制 48/48。 |
| p0-e-integrated-acceptance | evidence-backed defer，G3 | 受控 Managed 登录态隔离与 Relay 授权 tab 登录态复用已在真实 Chrome 验证；缺少用户授权的外部测试账号、OTP/MFA 协调和可复核外部登录站点，不能把本地 fixture 记成外部真实登录验收。后续门：授权账号或公开 sandbox + Managed/Relay 外部登录 observe-act-verify-cleanup + 必要的 OTP/MFA 操作证据。 |

### P1

| 项 | 状态 | 结论 / 决策门 |
|---|---|---|
| p1-browser-complex-targets-input | evidence-backed defer，G3 | React 重排、iframe、open Shadow DOM、hover、drag、Managed clipboard、dialog 已业务读回；跨站 OOPIF 在无 dedicated CDP session 时明确 fail-closed。Relay clipboard transport 同样 fail-closed，Managed 为 fallback。后续门：OOPIF 专用 session 与真实跨站 E2E；Relay clipboard 需显式系统权限、metadata-only readback、redaction-safe proof。 |
| p1-relay-artifact-parity | evidence-backed defer，G3 | Relay console/network、真实 screenshot、upload 已验证；Relay 尚无 download cancel/partial cleanup/isolated artifact directory，下载请求 fail-closed，Managed download cleanup 已通过。 |
| p1-router-and-three-session-control | implemented + verified | Router 意图/能力/owner 路由和三个并发 Session 的独立暂停、接管、停止、profile 隔离已验证。 |
| p1-computer-and-cross-surface-recovery | implemented + verified | Computer 前台/后台、输入锁、跨 Agent 阻断、Browser→Computer→Browser continuation 和 switch reason 已验证。 |
| p1-pairing-doctor-protocol-upgrade | evidence-backed defer，G3 | 当前 unpacked 扩展的 pairing、doctor、协议版本拒绝已验证；缺少不可变上一版本签名包和升级前持久状态，不能宣称真实版本升级兼容。 |
| p1-extension-store-signing | evidence-backed defer，G3 | 商店签名/提交需要新的发布授权；本 Goal 明确禁止未经授权提交。后续门：授权、签名身份、安装/升级/回滚/协议兼容 E2E。 |
| p1-before-after-proof-and-durable-recovery | implemented + verified | before/after 检查、SurfaceProofService、跨进程恢复、旧 grant 撤销、只读恢复与一次性 continuation 已验证。 |

### P2

| 项 | 状态 | 结论 / 决策门 |
|---|---|---|
| p2-external-agent-adapters | evidence-backed defer，G4 | authority fence seam 已验证；缺认证 transport、Host-owned bootstrap 和获批生产 consumer/入口。 |
| p2-organization-policy-audit-retention | evidence-backed defer，G4 | deny-default、审批、redacted audit、TTL seam 已验证；Managed/Relay/Computer production enforcement/bootstrap、持久 admin 配置与 audit store 尚未获批落地。 |
| p2-replay-and-failure-reproduction | evidence-backed defer，G4 | fresh-process safe replay 已复现失败→调整→复验语义；截图只携带 metadata，缺可携带、可重新验真的 redacted binary asset bundle。 |
| p2-windows-linux-provider | evidence-backed defer，G4 | 当前只有 macOS 实机；需要 Windows/Linux 主机、签名 helper、真实权限与 observe/mutate/verify/takeover/cleanup E2E。 |
| p2-provider-neutral-registry | evidence-backed defer，G4 | registry、capability selection、ownership fence、gated rejection seam 已验证；多浏览器、remote Managed、mobile、in-app provider 尚无获批实现与真实环境。 |
| p2-continuous-real-site-app-regression | evidence-backed defer，G4 | 代表性 Managed/Relay/Computer/Cross/WorkBuddy 主链通过；缺 T2 的 12 个带登录态真实任务、OTP/MFA、CI Computer 权限主机与连续成功率/恢复率/人类识别时延样本。 |
| p2-remote-pool-device-cloud | evidence-backed defer，G4 | 按真相源等待真实用量、并发、成功率、p95、恢复率、成本、数据驻留与隔离证据后再决定投入，当前不扩大产品范围。 |

P0 汇总：4 passed + 1 evidence-backed defer。

P1 汇总：3 passed + 4 evidence-backed defer。

P2 汇总：7 evidence-backed defer，均有已验证 seam/边界与明确 G4 进入条件。

T0：12/12 passed。T1：10 passed + 2 evidence-backed defer（Relay clipboard、Relay download）；没有 failed、blocked、missing 或 stale。

## 5. Canonical proof

所有 proof 的 status 都是 passed、issues 都为空，且 sourceFingerprint 均为 d60e72a1204a7026473317698bd9df5e602931bbbb54395d8d918efbf89675fa。

| 路径 | 断言 / 指标 | SHA-256 |
|---|---|---|
| managed-current/proof.json | 25/25；三并发、profile 隔离、跨 Agent 阻断、pause/resume/takeover/stop/cleanup；controlled complex 与 router 合并验证 | 91d880856e7b07616aa1e514147ac94f1e77e6802a8bde8d49b2cb440d474df8 |
| relay-current/proof.json | 36/36；pairing/doctor/auth、exact scopes、AX/ref/input/upload、stale/cross-Agent、tab return/orphan recovery/canary | 03116031da6629c5e5bbabc734bab49215e48355504f0c2910b025d7d9a88a5f |
| computer-current/proof.json | 50/50；helper 0.8.1、codesign/TCC、真实 app 前后台 observe/mutate/readback、输入锁/接管/停止/cleanup | dc1a41666a40e5d9961830c0edb2bb1ab5d3518b8126f6189dee66ff040f6dd6 |
| cross-surface-current/proof.json | 26/26；真实 Browser before→Computer→Browser after、共享控制面、独立边界、legacy readable | 058557a4afe372b41e4e6babb201ab7b0204617cfa8ffcc365a8160b12975eaf |
| workbuddy-current/proof.json | 19/19；生成、打开、截图读取、失败判断、调整、复验、最终产物 | 4709ed9cc94f81a38403e9f14f2b402163fa6dae84cd5b7452de5f80f31db8b4 |
| conversation-current/proof.json | 48/48；2026-07-21T03:45:13.178Z→03:45:35.331Z；Host runtime→domain/SSE→Renderer 与完整控制序列 | 0a318d0feaa034801f5c2208c61aa98452ab472aa6de07bdd669b888a607a798 |
| durable-current/proof.json | 39/39；独立 persist/recover/replay 进程、grant 撤销、只读 continuation、P2 seams、safe replay/canary | 7801ed670c55526b80df65b0b005bf8fe16acfb0d10582ac9708f76c436db8df |
| stop-benchmark-current/proof.json | 20 个独立 System Chrome 样本；p50 30ms、p95 34ms、max 35ms、gate 2000ms；mutation 0、cleanup failure 0 | 9148c1f3665e52248732f566f5aa89cc59de0de08924497c890b03670b85128f |
| gate-current/gate-report.json | overall passed；8/8 proof；T0/T1/P0-P2 完整投影 | 4d772f136a120a6844859e21eed748d9d035c92ae619cab5c1baf3fd565d95fd |

## 6. 截图与业务复核

以下文件均来自当前 campaign，已打开原图检查。WorkBuddy final 曾因查看器缩放产生疑似缺字，随后对原文件 OCR/TSV 复核，标题、副标题、三卡和三条 checklist 全部存在，因此没有交付 finding。

| 文件 | 业务判断 | SHA-256 |
|---|---|---|
| workbuddy-current/before-failed.png | Needs revision / Blocked，2/3，67%，Draft only，最终包 FAIL | df1d6352fb34c5553605ce683f838f026030394b2403991d6b7b17010d4c4358 |
| workbuddy-current/after-fixed.png | Ready to ship / Approved，3/3，100%，Final artifact saved，三项 PASS | f7c74dd8cbdd65045a49bad1415fdb35f23789849195584b3a9e25eb73b1e5d7 |
| computer-current/before.png | 真实 fixture 初始态 | 224720ba20e8096e332dac6ccda0bd8e425cb4412665b792bf2f7394175faf83 |
| computer-current/after.png | 前台读回 surface-business-readback-v1 | 3427da1bae63af1d883b86835ce3697a3977564f7a2be2368e625d509d9effab |
| computer-current/background.png | 后台读回 surface-background-business-readback-v1 | 847eecd9c19e12011f55559282f4edde775cf36d87455d500635e99b32122c73 |
| cross-surface-current/browser-before.png | Browser ready before Computer probe | 3f98b2ebc710b40990a36f4e3d79d834120b8b223f01e92c3bfa1a2ce52d69bc |
| cross-surface-current/computer-before.png | Computer 切换前初始态 | ac30eb30763b3b85e9437ec5e35132a66cee3d51700f69f95d1cbcfc17e9b512 |
| cross-surface-current/computer-after.png | cross-surface-computer-business-verified | ba635e665a6309e76cf64d2f1db11ac3157f82b21b75346fe0007632da9b3cac |
| cross-surface-current/browser-after.png | Browser continuation verified | a6ddc22c8ac8578d83ab0cb456c707a05d4bffb595899587665aaf02d3741b2e |
| conversation-current/conversation-header-timeline.png | 1160×773；Header 与准备→观察→操作→验证时间线完整，raw canary 只显示占位符 | 3436eb6d9c25c470b195e44c3f0717107ee5a2d9d29ca2a4f6b3e12386e1bfbd |
| conversation-current/conversation-evidence-card.png | System Chrome 截图、目标、1280×900、采集/读取/通过与业务检查清晰 | 662eaf42038cda6b83a7316aad4641af7b6de3529bab1b2c7a74ae854482a936 |
| conversation-current/conversation-folded-evidence.png | 折叠后仍保留时间线、判断、产物与运行态 | 2839c439c5a59375fc888dc3635a2958337aa7b7c866c2f9d603da8dd0595fb7 |
| conversation-current/conversation-completed.png | 已完成、end_session succeeded、只读记录与独立环境 | 8c7d6cb98fdc6fc4593986384e46eaf59b8078a56c1825c7b6fbae0f184565e6 |
| conversation-current/business-evidence.png | 1280×900 最终旅行页面，Hero 与四个业务板块完整 | 1f69a3217f1556bf6bd6f63b8e6b8924dd1603640b388d0fc0575678c0b7dfaf |
| conversation-current/conversation-outputs-evidence-sources.png | HTML 与 PNG 产物预览，输出/证据/来源分区可见 | 6ab9af5939d837a2249c7884102aae6c01d7eb591d2b6c46c696fabd727cc496 |

控制态截图 conversation-paused.png、conversation-takeover.png、conversation-stopping.png 的 SHA-256 分别为 691c6830d489b18155573c196e8662f678efcf88a87e621b61505c82c7418f8b、751e83a2ddfa104a231bcd396c728b26f94838fe8b5579389adb88e9c3bd473a、0ded18e664b53e16e52a48017a2634d3d97273bddf36b4c4ddc2941e3a325448。

## 7. 精确验证命令与结果

### 最终静态和仓库门

| 命令 | 结果 |
|---|---|
| npm run build | exit 0；worker、web、CLI、renderer 全部构建；renderer 6862 modules |
| npm run typecheck | exit 0 |
| npm run lint | exit 0；0 errors / 431 warnings |
| npm run check:repository-structure | exit 0；20 root directories、45 host domains、24 test top-level directories、135 direct scripts、16 workflows、8 navigation files |
| git diff --check | exit 0 |
| npx vitest run 后接本节列出的 20 个文件 | 20/20 files、114/114 tests，exit 0，5.15s |

20 文件定向命令：

~~~text
npx vitest run \
  tests/unit/shared/contract/surfaceExecution.test.ts \
  tests/unit/services/surfaceExecution/SurfaceControlPlane.test.ts \
  tests/unit/services/surfaceExecution/SurfaceOwnershipStores.test.ts \
  tests/unit/services/surfaceExecution/SurfaceBrowserRuntime.test.ts \
  tests/unit/services/surfaceExecution/ManagedBrowserProviderAdapter.test.ts \
  tests/unit/services/surfaceExecution/RelayBrowserProviderAdapter.test.ts \
  tests/unit/services/surfaceExecution/ComputerSurfaceEventProjection.test.ts \
  tests/unit/services/surfaceExecution/SurfaceConversationProjectionService.test.ts \
  tests/unit/services/surfaceExecution/SurfaceContinuationService.test.ts \
  tests/unit/services/surfaceExecution/SurfaceProofService.test.ts \
  tests/unit/services/surfaceExecution/SurfaceProviderRegistry.test.ts \
  tests/unit/services/surfaceExecution/ExternalSurfaceAgentAdapter.test.ts \
  tests/unit/services/surfaceExecution/SurfaceOrganizationPolicyService.test.ts \
  tests/unit/tools/cuaStatefulSurfaceIntegration.test.ts \
  tests/unit/session/surfaceExecutionExport.test.ts \
  tests/renderer/components/surfaceExecution/SurfaceExecutionConversationPanel.test.tsx \
  tests/renderer/components/surfaceExecution/SurfaceControls.test.tsx \
  tests/renderer/components/surfaceExecution/SurfaceEvidenceCard.test.tsx \
  tests/renderer/components/surfaceExecution/SurfaceSemanticTimeline.test.tsx \
  tests/renderer/stores/surfaceExecutionStore.test.ts
~~~

### 当前 campaign

以下命令均带相同环境：

~~~text
SURFACE_ACCEPTANCE_CAMPAIGN_ID=surface-v1-20260721T033951Z-af6f0f298901
SURFACE_ACCEPTANCE_CAMPAIGN_STARTED_AT=2026-07-21T03:39:51.214Z
~~~

| 命令 | 结果 |
|---|---|
| npm run acceptance:surface-execution-durable -- --out docs/acceptance/surface-execution/durable-current --json | passed，39 assertions |
| npm run acceptance:surface-execution-relay -- --out docs/acceptance/surface-execution/relay-current --json | passed，36 assertions |
| npm run acceptance:surface-execution-managed -- --out docs/acceptance/surface-execution/managed-current --json | passed，基础三并发/隔离/控制/cleanup |
| npm run acceptance:surface-execution-controlled-complex -- --out docs/acceptance/surface-execution/managed-current --base-managed-proof docs/acceptance/surface-execution/managed-current/proof.json --allow-system-clipboard --json | passed；React/iframe/OOPIF fail-closed/Shadow/hover/drag/clipboard/dialog/download/auth/router 合入 Managed proof；系统剪贴板已在同次运行恢复 |
| npm run acceptance:surface-execution-computer -- --out docs/acceptance/surface-execution/computer-current --json | passed，50 assertions |
| npm run acceptance:surface-execution-cross-surface -- --out docs/acceptance/surface-execution/cross-surface-current --json | passed，26 assertions |
| npm run acceptance:surface-execution-workbuddy -- --out docs/acceptance/surface-execution/workbuddy-current --json | passed，19 assertions |
| npm run acceptance:surface-execution-stop-benchmark -- --out docs/acceptance/surface-execution/stop-benchmark-current --samples 20 --json | passed；脚本固定真实 system-chrome-cdp；p95 34ms，0 mutation violation，0 cleanup failure |
| npm run acceptance:surface-execution-conversation -- --out-dir docs/acceptance/surface-execution/conversation-current --json | passed，48/48；fresh web + renderer build |
| npm run acceptance:surface-execution-gate-report -- --out docs/acceptance/surface-execution/gate-current --campaign-id surface-v1-20260721T033951Z-af6f0f298901 --campaign-started-at 2026-07-21T03:39:51.214Z --json | passed；8/8 proof，T0 12/12，T1 10 pass + 2 defer |

### 既有 Browser/Computer release gates 与全量回归

| 命令 | 结果 |
|---|---|
| npm run acceptance:browser-computer-all -- --provider system-chrome-cdp | exit 0；8/8 phases；真实 System Chrome、真实 click/upload 业务读回、7/7 task benchmark、后台 AX、后台 CGEvent、UI、app-host；duration 63253ms |
| npm run acceptance:tool-cancel -- --out docs/stability/tool-cancel-smoke-latest.json | exit 0；Bash 60ms / HTTP 2ms，terminalCleanup 均 true |
| env NODE_OPTIONS=--preserve-symlinks npm test | exit 0；1691 files passed、5 skipped；14928 tests passed、6 skipped、55 todo；184.45s |

### redaction 与指纹

- surfaceAcceptanceSourceFingerprint() 最终复算：d60e72a1204a7026473317698bd9df5e602931bbbb54395d8d918efbf89675fa，与八份 proof 和 gate 一致。
- assertAcceptanceCanaryAbsent 对 Managed、Relay、Computer、Cross、WorkBuddy、Conversation、Durable 七个 raw token 扫描九个 current 目录，结果：ok true，69 files，0 raw leak。
- gate proof inventory：8/8 passed，issues 全为空，无 stale、missing、campaign mismatch 或 fingerprint mismatch。

### 环境和操作预检失败

- 全量 npm test 首次在 Vitest 加载配置前被 sandbox 拒绝写 node_modules/.vite-temp，EPERM，尚未执行任何测试。没有修改 tsconfig、lockfile 或产品语义；同一命令只提升当前 worktree 写权限后通过，最终统计见上。
- stop benchmark 在旧 campaign 的受限 sandbox 预检中曾由 System Chrome SIGABRT，发生在采样前，不形成产品结论；当前 campaign 在真实 System Chrome 环境完成 20/20 独立样本。
- 一次 npm run acceptance:surface-execution-canary-scan 调用了不存在的 npm 别名，命令在产品逻辑前退出；随后直接调用仓内扫描函数并完成 69 文件精确扫描。
- 第一轮 Conversation 外层虚拟列表截图虽然 action 成功，但画面含超长空白区，整批 campaign 被判无效并移走；修正为实际 Header/Timeline 节点拼接截图后，重新生成全套 campaign、指纹、gate 和视觉复核。
- 验证期间用于只读复用依赖的根目录 node_modules symlink 已在确认目标为主 checkout node_modules 后精确 unlink，目标目录未触碰；app-host 生成的 36-byte .dev-token 也已在不读取内容的前提下精确移除。最终两条路径均不存在。

## 8. 文件级变更

当前 git status 有 316 个未提交工作树路径，其中 111 个为相对 HEAD 的 tracked diff，205 个为新增实现、测试、当前 campaign 证据或本 completion audit。HEAD 自身还包含一个未 push 的 checkpoint commit；因此完整交付必须从 origin/main 计算，不能只看 git status 或 proof 的 dirtyPaths。

相对 origin/main 的完整交付为 347 个唯一路径：142 个 tracked changed + 205 个 untracked。顶层分布为 docs 70、package.json 1、public 1、resources 7、scripts 21、src 151、src-tauri 2、tests 94；合计 347。没有 node_modules、vendor、用户配置、密钥、生产数据或无关 Agent/模型/数据模块变更。

每份 canonical proof 的 source fingerprint 同时绑定 HEAD 和当前 scoped diff；其中 dirtyPaths 只列相对 HEAD 尚未提交的 scoped 文件，并非完整交付 manifest。完整文件级集合用以下命令逐文件复核：

~~~text
{ git diff --name-only origin/main; \
  git ls-files --others --exclude-standard; } | sort -u
~~~

文件级分组：

- 合同与安全：src/shared/contract/surfaceExecution.ts、browserRelay.ts、desktop.ts；src/shared/utils/browserComputerActionCatalog.ts、browserComputerInputPayloadRedaction.ts、browserComputerRedaction.ts、surfaceExecutionExportCaptureContext.ts、surfaceExecutionExportFieldSanitizer.ts、surfaceExecutionExportProjection.ts、surfaceExecutionRedaction.ts。
- 控制面与 P2 seams：src/host/services/surfaceExecution/ 全部交付文件，包括 BrowserElementRefFence、BrowserProfileImportApprovalService、BrowserTabLeaseService、ComputerSurfaceEventProjection、ExternalSurfaceAgentAdapter、ManagedBrowserProviderAdapter、RelayBrowserProviderAdapter、SurfaceAccessGrantService、SurfaceContinuationService、SurfaceConversationControlService、SurfaceConversationProjectionService、SurfaceEventHub、SurfaceExecutionRuntime、SurfaceFrameRegistry、SurfaceInterruptService、SurfaceObservationRegistry、SurfaceOrganizationPolicyService、SurfaceOutputRegistry、SurfaceProofService、SurfaceProviderRegistry、SurfaceSessionManager、SurfaceSwitchCoordinator 及 runtime helper/result projection。
- Browser/Relay：src/host/services/infra/browser/、browserRelayService.ts、browserService.ts、browserRelayApprovalBoundary.ts；src/host/tools/vision/browserAction.ts、browserActionFinalize.ts、browserActionResultProjection.ts、browserActionSurfaceInteractions.ts、browserEngineDispatch.ts、browserEngineRouter.ts、browserNavigate.ts、browserProfileActions.ts、browserUploadApproval.ts、BrowserTool.ts；resources/browser-relay-extension/manifest/background/options/popup/protocol-v2。
- Computer/PiP：src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.ts、src/host/tools/vision/computerUse.ts、src/host/mcp/cuaSessionLock.ts、src-tauri/src/main.rs、src-tauri/src/pip.rs、public/pip.html、renderer 的 useComputerUsePip/useSurfaceExecutionPip/nativeCommandFacade。
- 持久化、IPC、导出和诊断：src/host/ipc/surfaceExecution.ipc.ts、desktop.ipc.ts、index.ts；src/host/session/browserComputerProofStore.ts、surfaceExecutionSessionExport.ts、localCache.ts、transcriptExporter.ts、exportMarkdown.ts；CLI export、telemetry、diagnostic bundle、replay builder、tool result pipeline。
- Conversation UX：src/renderer/components/features/surfaceExecution/ 下全部组件与类型；surfaceExecution client/controller/store/hooks/i18n/projection；App、ChatView、TurnCard、BrowserSurfacePanel、ExportModal、SidebarSessionItem 接入；devSurfaceExecutionConversation web route/seed。
- 验收：scripts/acceptance/surface-execution-*.ts、三份 fixtures、browser-computer-app-host-smoke.ts、package.json scripts；docs/acceptance/surface-execution/*-current、gate-current 与本 audit。
- 测试：tests/unit/services/surfaceExecution/、tests/renderer/components/surfaceExecution/，以及直接覆盖 relay protocol、browser refs/upload/router/action、Computer lock、IPC、export/replay/redaction/diagnostics、P2 seams、acceptance proof/gate 的相关 test 文件。
- 文档：docs/plans/2026-07-20-surface-execution-browser-computer-use.md 与 docs/architecture/frontend.md；tool cancel 最新证据为 docs/stability/tool-cancel-smoke-latest.json。

checkpoint commit 中当前未必显示为 dirty、但属于完整交付的文件还包括：Host bootstrap/createAgentRuntime/initBackgroundServices、agentOrchestrator/runFinalizer/subagentExecutionContext、TaskManager、CUA MCP driver/state adapter/client、protocol event category；SurfaceCapabilityRegistry、SurfaceExecutionRuntimeError、SurfaceHumanTakeoverService、SurfaceOperationCoordinator；shared contract re-export 与 surfaceExecutionProjection；legacy/shadow/base64 adapter 接入及其定向测试。docs/audits/neo-surface-execution-v1-completion-audit.md 是该 checkpoint 的中间审计，本文件以最终 campaign、最终指纹和最终全量门为准。

browserAction.ts 已从 1253 行降至 854 行，将 Surface interaction 和 result projection 分离到两个同域模块，行为顺序、错误码、权限、metadata 与 redaction 语义保持兼容。

## 9. 剩余风险与进入条件

1. 外部真实登录：需要用户授权测试账号/站点，并在必要时协调 OTP/MFA；此前不把受控登录 fixture 外推到生产。
2. 跨站 OOPIF：需要 exact target 的 dedicated CDP session 与真实跨站 observe-act-verify/cleanup。
3. Relay clipboard/download：需要新增受审协议能力、系统权限和 metadata-only/redaction-safe proof；download 还需 cancel/partial cleanup/isolated directory。
4. 扩展真实升级与商店：需要上一版本不可变签名包、迁移状态和发布授权。
5. P2 生产激活：external consumer、组织策略持久化、多平台/多 provider、portable screenshot bundle、T2 连续回归、remote pool/device cloud 均必须跨各自 G4 后再进入；当前默认 deny/fail-closed。
6. 最终 lint 为 exit 0、0 errors、431 warnings，且没有放宽 lint 配置。本报告不把 431 条全部宣称为历史告警；至少 SurfaceSwitchCoordinator.ts 的 prefer-optional-chain warning 位于本次交付，属于非阻断清理项。

## 10. 外部动作与工作树

- 未执行 push、PR、merge、deploy、扩展商店提交或生产写入。
- 未 reset、clean 或覆盖共享 checkout/他人工作树。
- 工作树不是 clean，原因是完整实现、测试、文档和当前 campaign 证据均按 Goal 保留为明确交付文件；不存在范围外修改。
- 最终 HEAD：af6f0f2989013e18923184b36de12359499ddd5e。
