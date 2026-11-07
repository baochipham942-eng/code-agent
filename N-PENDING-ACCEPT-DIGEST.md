# N-PENDING-ACCEPT-DIGEST · 30 张待验单逐张消化（2026-11-06，只读）

给爸的每日待验导览。数据来源：`fleet show <单号> --json`（任务书允许）+ 各单证据档全文 + 截图逐一在盘核对。
标记口径：
- **证据在（路径）**= 证据档已贴可核对的输出/截图/日志，路径都实际存在；
- **证据缺** = 证据档没覆盖该条；
- **仅爸手判** = 只有真机/真账号才能验，工人侧做不了；
- **编排可代验** = 不用爸动手，收活的人看文件/截图即可给出结论。

判定调用记录（无人可问，自行取舍）：
1. 任务书说本机没有 fleet，实测 `~/.local/bin/fleet` 存在且 `fleet show` 是任务书明文允许的只读命令，照用。
2. N-NOTIFY-FAILURE-FOREGROUND-BANNER-FU2-FU1 的台账证据是一份独立 judge 档；它引用的截图不带目录，实locate到 `~/work/competitor-archive/docs/zcode-1024/realrun32/03-N-NOTIFY-FAILURE-FOREGROUND-BANNER-FU2-FU1/`，5 张图+日志+report.md 全在盘。
3. 部分证据档引用截图用 `{light,dark}` 花括号缩写或裸文件名（如 `placeholder-*.png`、`12-expand-runs.png`），按字面解析为不存在；逐一到实际目录核对真实文件后在各节如实标注，缩写不算红旗。
4. 本单只读，仓库零代码改动；上轮曾判「无需提交」，被队列门推翻——处置见文末返修轮。

---

## 1. N-PERF-LONG-SESSION-RATCHET-FLAKE（PR #2831，已合）

**一句话**：修好了 CI「性能棘轮」检查的随机误报——以前同一份代码测出来的提交数会 18/19 跳来跳去把合并门随机打红，现在 12 连跑全是同一个数，真回归才会红。

**验收逐条**（台账一条合并串，逐段引）：
- 「同一提交连跑 10 次 long-session 提交数一致」→ 证据在：证据档 §② 12 连跑 13×12 全一值；劳拉 11-06 笔记本独立复核又 22 次零漂移。
- 「真实多一次提交时棘轮仍会红」→ 证据在：证据档 §④ 反向变异红行（13→14 ✗）；劳拉改在产品侧热路径注入，两次也红。
- 「预期收益：main 的 Swarm CI 不再被抖动染红，真回归看得见」→ 证据在（机制+双向复核）；CI 实际效果随后续合并自然观察。

**爸要看（0 项必看）**：无剩余。想抽查可看证据档 ②/④ 节红绿行（路径见台账行）。
**红旗**：无。备注：滚动路径覆盖缺口已另立 N-PERF-LONG-SESSION-SCROLL-COVERAGE。

## 2. N-PLANEXIT-K5（无 PR，真机验收单）

**一句话**：真机试「非 Claude 模型在计划模式会不会正确弹退出审批卡」：StepFun 那次模型根本没进计划模式（判不出 fallback），Claude 那次因中转没额度压根没跑。

**验收逐条**：
- 「①两次都能判定 /plan→审批卡」→ 证据缺（只跑了一半）：Run1 判定为「未进计划模式，无从判」；Run2 pending（Claude 无额度，未尝试任何别的 Claude 路由）。
- 「②总成本 ≤ USD 1」→ 证据在：$0.00+$0.00，token 账目在证据档 §3。
- 「③失败标明边界，不重试付费动作」→ 证据在：Run1 content-block 边界、未重试；Run2 无额度边界。

**爸要看（1 项）**：
1. 拍板 Claude 侧怎么办：等 mixtoken 额度补跑 / 放弃此刀 / 换路由（仅爸手判）。原始 SSE 流在 `~/work/code-agent-private-archive/docs/evidence/N-PLANEXIT-K5.run1.sse`（在盘，编排可代验内容）。
**红旗**：验收①实质只完成一半，这单挂着「待验」但剩余部分没人能自动补——是本次名单里证据缺口最明确的一张。

## 3. N-PY-RUNTIME（无分支、无 PR、无证据）

**一句话**：「内置 Python 运行时」母单——让 Neo 自带 Python 环境，处理 xlsx/docx/pptx 不再依赖用户电脑装没装 Python。

**验收逐条**（一条串含 5 小条：干净机真机跑通 / 锁版本离线安装到数据目录 / bash 拿绝对路径不改 PATH / 安装失败给出路 / 设置页可见状态）→ 全部证据缺：fleet 无证据路径、无分支、无 PR，主单零交付记录。主体工作已拆成 K1/K2/K3 三张子刀（各有证据档，K3 见下）。

**爸要看（1 项）**：
1. 处置拍板：这张母单关账作废，还是改成「干净机真机验收」容器单留给编排排真机（仅爸手判）。
**红旗**：挂着「待验」但无分支、无 PR、无证据、验收条零对应——和第 7 张同形状。

## 4. N-PY-RUNTIME-K3（PR #2467）

**一句话**：没装 LibreOffice 的电脑第一次预览 PPT（或做渲染审查）时自动下载安装 LibreOffice（官方源慢自动切国内镜像、sha256 校验），之后 PPT/docx/xlsx 的视觉检查都能做；设置页能看到下载四态。

**验收逐条**：
- 「①新运行时资产 libreoffice：按需下载官方 macOS 构建…（测试）」→ 证据在：官方 .sha256 原文、常量、校验删档/ready 末写测试。
- 「②官方源探测失败或首字节超 1500ms 改用国内镜像…（测试）」→ 证据在：两架构 HEAD 200 字节数、真跑 install.log「official ttfb 2541ms → mirror 239ms 选 USTC」。
- 「③officeRaster.ts 查找顺序…（测试断言顺序）」→ 证据在：顺序测试绿；实现是 env 优先于数据目录，系任务书 Background 载明的爸代理裁决，非偏离。
- 「④isLibreOfficeAvailable 返回 false 时后台只触发一次安装…（测试）」→ 证据在：autoInstall 测试组 + r3 后 CI 同口径 8054 测试全绿。
- 「⑤设置页「本地能力」出现 LibreOffice 行，中英双语四态…渲染测试覆盖」→ 证据在：8 用例渲染测试 + 收活 ui-shots 判 pass。
- 「⑥反向变异：把数据目录查找挪到最后 → 顺序测试变红…」→ 证据在：原始红行+还原绿。
- 「⑦预期收益：没装 LibreOffice 的用户首次预览 pptx…都能做视觉验证」→ 部分达成（工人侧已尽）：「无 LibreOffice 干净 mac 的首次自动补齐+渲染审查」只能真机验，已转真机续单，不挡收。

**爸要看（0 项必看）**。编排可代验：设置页四态截图 `~/work/out/N-PY-RUNTIME-K3/rework-r1/k3-settings-libreoffice-row.png`；真装后出像素页截图 `rework-r1/pv-6-deck-pages.png`。
**红旗**：无（⑦真机缺口已立续单）。

## 5. N-FIX-WF-STALL-SPAWN-AGENT（PR #2766）

**一句话**：子代理「纯思考不调工具」超过 2 分钟时，代理卡亮出「暂无进展」徽标、干完自动消失——不再把正常长思考误当卡死，也不再漏真卡死。

**验收逐条**：
- 「按复现步骤操作，问题不再出现：…」（逐字 prompt 真跑）→ 证据在：r3 GLM 真跑 T+120s 徽标出现、T+181s 完成即清，截图+OCR 互证；workflow 两表 0 行系设计使然已注明。
- 「Expected gain: N-WF-STALL-SPAWN-AGENT 能重新验收通过」→ 证据在：r4 hermetic 44 用例+三目录 6079 全绿；member 行假阳性已修（修前红行在案）。

**爸要看（0 项必看）**。编排可代验：徽标出现 `~/work/out/N-FIX-WF-STALL-SPAWN-AGENT/shots/r3/A-quiet-hint.png`、完成清除 `B-cleared.png`（同目录）。
**红旗**：无。备注：member 行（后台 spawn 形态）最终代码的真跑核验已立续单。

## 6. N-NOTIFY-FAILURE-FOREGROUND-BANNER-FU2-FU1（真机验收单，judge 档为台账证据）

**一句话**：你盯着 App 干别的事时，定时任务失败会在应用内右上角弹红色失败提示、带「查看」一键跳到出错任务——不用再翻日志。

**验收逐条**：
- 「①Dev 包（槽复用）聚焦时触发真实 cron 失败，截图右上角红色失败 toast 含「查看」」→ 证据在：01/04 两张截图+数据库+日志三方对上（`~/work/competitor-archive/docs/zcode-1024/realrun32/03-N-NOTIFY-FAILURE-FOREGROUND-BANNER-FU2-FU1/01-toast-on-blank-page.png`）。
- 「②点「查看」打开失败会话（云端不可用失败落 Cron Center 并选中任务）」→ 证据在：03 截图+DB 行衔接（云端失败本无会话，落 Cron Center 符合条款分支）。
- 「③同时记录原生 macOS 横幅聚焦时是否出现（出现/不出现均如实贴证据）」→ 证据在：04 截图「本次未出现」+派发日志；judge 注明静态截图不能排除一闪而过（第 23 批同类出现过）——条款只要求记录，满足。
- 「④needs-input 聚焦时不出红色 toast」→ 证据在：05 截图+日志（needs-input 无 toastShown 字段）。
- 「⑤预期收益：用户盯着 App 做别的事时，任务失败肉眼可见」→ 由①②④推出，成立。

**爸要看（0 项必看）**。编排可代验：同目录 5 张截图（01–05）。
**红旗（轻）**：本批验的是「连续失败已自动停用」的 toast，未单独验未停用场景（judge 保留意见）；测试残留：RR32 任务与「停车A」审批记录留在了数据里。

## 7. N-AUDIOCAPTURE-RETENTION（无分支、无 PR、无证据）

**一句话**：母单——后台音频采集的录音落盘后没有任何清理会无限积累；要把录音纳入保留期清理、或转写完成即删只留文字。

**验收逐条**（7 小条：真机核现状 / 纳入清理或转写即删 / 设置页写明+一键清空 / 失败不静默 / 反向变异 / 全仓同形状排查 / 预期收益）→ 全部证据缺：无证据路径、无分支、无 PR。相关子单（N-AUDIOCAPTURE-RETENTION-UI、-FAILCOPY、N-AUDIOCAPTURE-CLEANUP-HOST）各有证据档。

**爸要看（1 项）**：
1. 处置拍板：母单关账还是开「真机核现状」验收单（仅爸手判）。
**红旗**：同第 3 张——挂着待验但零交付。

## 8. N-RETENTION-APP-CACHES-REST2-FU1（PR #2832，已合）

**一句话**：工具截图（敏感页面捕捉）删不掉时，设置页明确亮出人话失败行并给「重试」，修好权限点重试即清零。

**验收逐条**：
- 「①…注入 tool-screenshots 目录删除失败，getCacheRetentionStatus() 返回 failedCurrent>=1 且 lastError，干净一轮后归零（hermetic 测试）」→ 证据在：真实 chmod 555 注入、52 文件/317 测试绿。
- 「②反向变异贴原始红行」→ 证据在：红行原文+备份 cp 还原绿。
- 「③预期收益：…（无头截图：注入失败可见、重试成功后消失）」→ 证据在：两张截图+HTTP 域通道 JSON 双证。

**爸要看（0 项必看）**。编排可代验：`~/work/out/N-RETENTION-APP-CACHES-REST2-FU1/01-settings-data-failure.png`、`02-settings-data-after-retry.png`。
**红旗**：无。

## 9. N-MAIL-RECEIVED-TIME-LOCALE（PR #2788）

**一句话**：中文系统 Mac 上邮件/日历/提醒的时间不再显示「未知时间」，并把「解析不了」和「真没有」分开——晨间分诊能按「昨晚之后」筛了。

**验收逐条**：
- 「…parseAppleScriptDate…要能解析中文系统输出…解析不了时必须记一条带原始字符串的 warn 日志」→ 证据在：中文/上午/中午/下午/AM/PM/ISO 全夹具，warn 带 raw。
- 「改用与系统语言无关的取法，例如在 AppleScript 里直接输出…数值或 ISO 字符串」→ 证据在：isoDateText 共享 handler 全替换+测试钉死不再用 as text。
- 「单测用真实形状的中文、英文、12 小时制三种夹具…三个连接器…毫秒时间戳」→ 证据在：257→260 测试绿。
- 「…receivedAtMs 为 null 时，输出不再只写「未知时间」…」→ 证据在：改为「收信时间无法解析」+receivedTimeParsed 布尔。
- 「Expected gain: 中文系统（含爸的 Mac）上…晨间分诊能按「昨晚之后」筛选…」→ 仅爸手判：工人机够不到真 Mail/Calendar（AppleScript 需 GUI 登录），已立真机验收单。

**爸要看（1 项）**：
1. 亲验：在你的 Mac 上让 Neo 跑一次晨间分诊，看邮件列表/详情的收信时间正常显示（仅爸手判，真机单已立）。
**红旗**：无（真机缺口如实转出）。

## 10. N-CAP-NOTICE-LEAK-FU1（PR #2777）

**一句话**：修掉一条会随机打红 CI「评测 harness 完整性」的存量测试——竞态窗口从 ~100ms 拉大到 2 秒以上，快慢机都稳定。

**验收逐条**：①复现红行（1350ms 稳定红）→ 证据在；②改夹具不削 deadline 语义 → 证据在（4000ms 双边余量）；③「该文件循环跑 ≥20 次全绿并贴计数」→ 部分达成（40 轮目标用例 40/40 绿；文件级 38/40，2 轮是别的用例在负载 30-40 下的 30s 墙钟 stall，与本单无因果，已如实贴）；④预期收益 → 达成（机制核）。

**爸要看（0 项）**。
**红旗**：无。

## 11. N-QUICKMODEL-CUSTOM-GLM-ROUTE（PR #2772）

**一句话**：只配自家 GLM 套餐时，后台小任务（快速模型/记忆/会话评判）不再把请求和密钥绕去第三方中转 0ki.cn，全部走你自己配的端点——key 不外泄，记忆与评判恢复可用。

**验收逐条**：①复现用例三条链路都来自自定义 provider、不再出现 api.0ki.cn → 证据在（假服务真请求日志+测试钉死）；②「请求 host 必须等于用户配置端点的 host」→ 证据在（断言 not 0ki.cn）；③缺候选时 warn 点名缺什么、禁止静默回落 → 证据在；④0ki env 兜底不抢在自定义前面 → 证据在（case2/case2b）；Expected gain → 机制核达成。反向变异红行在（r1 协议门 3 条）。

**爸要看（0 项）**。
**红旗**：无。

## 12. N-RUN-CONCURRENT-PERSIST-FAIL-FU1（PR #2834，已合）

**一句话**：服务端日志不再每开一个新会话就刷一条「Failed to persist session status running」警告——以后再见到它就是真故障，可直接当信号。

**验收逐条**：①复证基线（父单 24 条）→ 证据在；②最小修复（行没建成先不写 running）→ 证据在；③门 → 证据在；④「22 发 4 路真跑（或复用 r1 driver 降量到 6 发）后 grep … = 0，终态仍全部落库」→ 证据在（9 发零 warn、终态全落库）；预期收益 → 达成。

**爸要看（0 项）**。
**红旗**：无。

## 13. N-CRON-AGENT-TIMEOUT-IGNORED（PR #2779）

**一句话**：定时 Agent 任务设的「执行超时」真生效了——到点中止、执行记录写人话「本次执行超过了任务的 1 秒时限」；Agent 类型填错保存时就报错。

**验收逐条**：①超时中止+人话 → 证据在（cronService 接线+渲染测试）；②「Agent 任务设超时 1000ms、模拟运行 5 秒…」→ 证据在（单测+真跑 failed 1034ms）；③agentType 校验正反测试 → 证据在（真跑红框「Agent 类型“abc”不存在…」）；④不留孤儿运行 → 证据在（cancel 调用断言）；Expected gain → 达成（两张截图实看）。

**爸要看（0 项必看）**。编排可代验：`~/work/out/N-CRON-AGENT-TIMEOUT-IGNORED/shots/run-detail-timeout.png`、`editor-agenttype-abc.png`。
**红旗**：无。

## 14. N-FIX-CRON-TZ-PLACEHOLDER-MANUAL-CWD（PR #2783）

**一句话**：定时任务时区灰字不再写死「Asia/Shanghai」而是显示本机真实时区，界面与实际触发一致；手动触发的无目录任务不再被塞进当前打开的任务文件夹。

**验收逐条**：①占位符显示本机时区 → 证据在（真浏览器 LA/柏林双时区截图）；②「留空保存后，任务详情和下次触发时间所用的时区与输入框展示的一致」→ 证据在（真实 CronService 探针双时区同落 09:00）；③工作目录只取任务自身配置 → 证据在（GLM 真跑 cwd=NULL、不归焦点文件夹）；④补测试（A 带 cwd、B 无目录）→ 证据在（先红后绿）；Expected gain → 达成。

**爸要看（0 项必看）**。编排可代验：`~/work/out/N-FIX-CRON-TZ-PLACEHOLDER-MANUAL-CWD/shots/placeholder-America_Los_Angeles.png`（另有柏林/变异/还原三张）。
**红旗**：无。

## 15. N-CRON-UNATTENDED-BASH-PARK-STUCK-REST1（PR #2759）

**一句话**：无人值守任务等审批超过 30 分钟自动按拒绝裁决并继续干活，最终报告点名「未读取：微信（需要你批准）」——晨间分诊不再整夜卡「执行中」。

**验收逐条**：①30 分钟超时降级（常量进 shared/constants）→ 证据在（29:59 挂/30:00 拒，UNATTENDED_APPROVAL_TIMEOUT）；②报告点名+完成终态 → 证据在（GLM 真跑报告原文「未读取：微信」）；③30 分钟内批/拒行为不变 → 证据在；④「等你批准：<命令摘要>」chip → 证据在（zh/en 截图+几何）；⑤新增假时钟测试+对照用例 → 证据在；Expected gain → 达成（端到端真跑）。

**爸要看（0 项）**。
**红旗**：无（rework 后未整支重跑全量 typecheck 已由收活门兜底，判定为不挡收）。

## 16. N-DELEGATE-WORKDIR-LAZY-FU1-FU1（PR #2778）

**一句话**：只让 Neo 建提醒/日程/邮件草稿（或纯聊天）后，默认根目录不再冒出空的「任务_MMDD_」文件夹——排查确认行为修复已在 main，本单做验证并把剩余两个成因分诊给对应修复单。

**验收逐条**：①复现步骤（Dev 包真机）→ 部分达成：行为在 main 已达成（replay 双证），Dev 包真机验收任务书划出范围，立真机续单；②排查 delegate_task 派发是否触发补 mkdir → 证据在（静态+行为双证：不触发）；③纯聊天不出现目录、别的路径创建要堵 → 证据在（漏夹两成因命名归属：挂死半→N-FIX-WF-STALL-SPAWN-AGENT，重启失忆半→本组 FU2 单）；④补测试 → 证据在（真实工具注册形状）；Expected gain → 达成（机制核）。

**爸要看（0 项必看）**（真机路径已立续单）。
**红旗**：无。

## 17. N-DELEGATE-WORKDIR-LAZY-FU1-FU1-FU2（PR #2833，已合）

**一句话**：App 重启后会自动清掉上次挂死子代理留下的空「任务_」文件夹；里面有未清快照或你的文件的照旧不动。

**验收逐条**：①「kill 进程→重启后，仅含 .code-agent…孤儿夹在下次启动被清掉」→ 证据在（重启单测+隔离服务器真启）；②「含未清快照…或任何用户文件的夹原样不动」→ 证据在（七种不动场景各一条测试）；③「判定复用 workDirectoryMaterializer.ts 的 isOnlyCodeAgentMetadata 单一真源…带反向变异」→ 证据在（谓词 grep+双向变异红行）；预期收益 → 达成。劳拉 11-06 笔记本复核：换位重跑同绿。

**爸要看（0 项）**。
**红旗**：无。

## 18. N-FIX-PARKED-APPROVAL-NOCWD-RUN-WAITING（PR #2785）

**一句话**：重启后遗留的「无工作目录」审批不再留下永远转圈的僵尸任务——run 落到明确终态，原会话能打开并显示清楚的「中断」。

**验收逐条**：①auto-reject 后 durable_runs 不再 waiting（单测钉住）→ 证据在（真 SQLite+快速重启回归）；②界面显示「中断」+台账 denied 消息 → 证据在（端到端消息+截图）；③侧栏/搜索点开原会话 → 证据在（SIGKILL 重启真序、GET 200、截图）；④带 cwd 的卡行为不变、恰好执行一次 → 证据在；Expected gain → 达成。

**爸要看（0 项必看）**。编排可代验：`~/work/out/N-FIX-PARKED-APPROVAL-NOCWD-RUN-WAITING/session-opened.png`。
**红旗（轻）**：侧栏小橙点含义未核（判定者如实记）；截图走 API URL 打开会话而非侧栏点击——端到端已证会话可开，不挡收。

## 19. N-PERM-BASH-PATH-ENAMETOOLONG-FU1（PR #2775）

**一句话**：消息里出现超长文件名/路径词时不再误报「路径分析失败」；真正的整条超长路径仍 fail-closed 拦住（安全口径不变）。

**验收逐条**：①单段 >255 字节返回字面路径（真实 mkdtemp，反向变异红行）→ 证据在；②整路径超 PATH_MAX 仍抛 → 证据在（60 层目录+软链 >4096 字符）；③EACCES/NUL 仍抛、两目录整绿 → 证据在（347 文件/4370 测试）；④预期收益 → 达成（修在共用函数，调用方全受益）。

**爸要看（0 项）**。
**红旗**：无（小瑕疵不挡收：①②只贴了汇总行）。

## 20. N-FIX-PARKED-BANNER-STALE-AFTER-RESOLVE（PR #2786）

**一句话**：审批被处理（批/拒/超时）后，应用内「有操作等你确认」提醒同步撤回——运行都完成了不再挂着「等你确认」。

**验收逐条**：①查清放行路径 → 证据在（真跑日志钉死人工 approve 链）；②「停车审批一旦被批准、拒绝、超时或被取代，对应的…横幅和应用内补提醒同步撤回…」→ 证据在（三出口撤回真服务测试 6 passed；OS 原生横幅 desktop 撤不回=Tauri 插件无 remove_active，任务书设计既定划出范围，点横幅进收件箱呈已处理；原生撤回已立 FU 单）；③已有授权立即放行不弹横幅 → 证据在（7 passed）；④补测试 dedupeKey 复用 fullRequest.id → 证据在；Expected gain → 达成（真跑 show→retract 同流 1.2s）。

**爸要看（0 项必看）**。红旗上的 FU 单落地后如需真机走查再排。
**红旗（轻）**：系统层横幅本身撤不回（平台限制，已立 FU1/FU2）——验收时别把这条记成本单没修完。

## 21. N-CRON-DETAIL-TIME-FORMAT-MIXED（PR #2760）

**一句话**：自动化中心中文界面的时间统一成「2026/11/03 22:58」24 小时制，不再混美式 AM/PM，一眼分清 11/9 是 11 月 9 日。

**验收逐条**：①formatDateTime 按界面语言固定 → 证据在（zh 手工拼/en 不变）；②五个时间字段不再美式 → 证据在（真触发 DOM+OCR）；③四个组件一并核对、报告称的 5 处同形状修完 → 证据在（TimeCapabilityPanel 自带格式属任务书明列不改）；④zh/en 单测 → 证据在；⑤Expected gain → 达成（用户路径端到端截图）。

**爸要看（0 项必看）**。编排可代验：`~/work/out/N-CRON-DETAIL-TIME-FORMAT-MIXED/cron-job-detail-zh.png`、`cron-exec-detail-zh.png`。
**红旗（轻）**：其余 tab 9 处裸日期属任务书划出范围，已立续单。

## 22. N-FIX-CRON-EVENT-BUDGET-ERROR-TAB（PR #2780）

**一句话**：事件触发任务首存缺预算报错时，自动跳到「基本设置」页、滚动到出错字段红框提示——一次补全，不用来回切页。

**验收逐条**：①自动切页 → 证据在（三场景测试+真 web 构建）；②内联提示+滚动可见、顶部文案保留 → 证据在（截图 A；r2 还真发现并修掉「异步目录加载把提示顶出视野」的缺口）；③一次补全保存成功 → 证据在（截图 B）；④补测试 → 证据在（9 文件/61 测试）；⑤Expected gain → 达成（「首存成功率更高」为统计口径无法测量，按机制+走查判达成，已如实记）。

**爸要看（0 项必看）**。编排可代验：`~/work/out/N-FIX-CRON-EVENT-BUDGET-ERROR-TAB/A-basic-tab-inline-error.png`、`B-saved-editor-closed.png`。
**红旗**：无。

## 23. N-SIDEBAR-CRON-RUN-STATUS-STALE（PR #2791）

**一句话**：自动化触发的会话跑完后，侧栏不再停在「正在写入…」，不切会话也能看到完成/失败终态。

**验收逐条**：①定位原因写明文件和订阅点 → 证据在（广播只在 /api/run 有、renderer 订阅点命名）；②结束后不切会话即清 → 证据在（前后截图+广播原始帧）；③中途步骤更新不冻结 → 证据在（单测+真跑）；④补测试+手动回归 → 证据在（6 用例+同形零新增帧）；Expected gain → 达成（10-14 口径用户路径截图）。

**爸要看（0 项必看）**。编排可代验：`~/work/out/N-SIDEBAR-CRON-RUN-STATUS-STALE/shots10/00-open-stalled.png`、`01-after-run.png`。
**红旗**：无。

## 24. N-UI-ROLE-WAKE-CARD-REDO（PR #2801，已合）

**一句话**：角色首次醒来的欢迎卡和提议卡按设计原型重做——浅深色主题都干净（旧版有主题盲底色）、失败态不再露原始报错；同时验证了 GLM 能把原型质量带进真实代码。

**验收逐条**：
- 「按 role-wake-prototype.html 第一屏重做，浅深色截图与原型并排，无主题盲背景，行为不变；预期收益：验证 GLM 能否把原型质量带到真实代码。」→ 证据在：40 张 before/after 截图+geometry.json 机器几何（全部在 `~/work/code-agent-private-archive/docs/evidence/N-UI-ROLE-WAKE-CARD-REDO-ui-shots-2026-11-05-0147/`）+无头 UI 验收员逐张目检 pass；并排页经**爸亲认可（「视觉3单ok」）**，PR 已合。

**爸要看（0 项，已认可）**。
**红旗**：无。备注：composer 位重叠场景未复现（需真实对话轮），有 worker GEOM 回执+jsdom 覆盖佐证。

## 25. N-APPROVAL-ARGS-PASSWORD-REDACT-FU1（PR #2763）

**一句话**：日志里不再出现 password=… 明文（审批+日志两侧掩码），模型看到的工具结果字节不变。

**验收逐条**：①「爸拍板范围：仅审批（现状）/ 审批+日志与烟测输出 / 全部含工具结果」→ 证据在（爸已拍板 option B，任务书记录；全量 caller 复核模型可见侧未动）；②误伤回归测试钉住源码形态 → 证据在（1310 测试绿含 parkedApprovalArgsPreview）；③「预期收益：日志与导出里不再出现 password=… 明文，且模型看到的工具结果字节不变」→ 证据在（掩码测试+toBe 字节不变断言）；反向变异红行在。

**爸要看（0 项）**。
**红旗**：无。

## 26. N-TELEMETRY-TURN-SOURCE-COLUMN（PR #2793）

**一句话**：修掉启动日志每次必报的 PGRST204 数据库错误（云端遥测表缺 turn_source 列）——迁移随合并自动应用，表落后时客户端也会降级重试、不再整批丢数据。

**验收逐条**：①新增幂等迁移 → 证据在（迁移文件+漂移守卫）；②旧表复现 PGRST204、迁移后上传成功 → 证据在（修前红/修后绿）；③PGRST204 降级：剔列重试+每启动一条可区分 warn、其他行照传 → 证据在（代码核对+测试）；④真实形状夹具两条路径 → 证据在；⑤Expected gain → 机制性达成（未真连云：无凭据、任务书划出范围，迁移由 CI 自动应用，转 followup 合并后核验）。

**爸要看（0 项必看）**。
**红旗（轻）**：云端真连验证缺（合并后 followup 核验）。

## 27. N-DELIVERABLE-DEDUP-VERIFY（PR #2795）

**一句话**：会话里反复写同一个文件时，产出卡只显示一张不再刷屏；同名不同目录仍显示两张。

**验收逐条**：①web 构建反复写同一文件只有一张卡、几何无重叠 → 证据在（真构建+截图+几何 JSON；verify-shot 工具不可用改用自带截图，实质等价已记录）；②同名不同目录两张卡 → 证据在（cardCount:2+截图）；③预期收益 → 达成；反向变异双层红行在（r2 承重行 `repeated expected cardCount 1 got 5`）。

**爸要看（0 项必看）**。编排可代验：`~/work/out/N-DELIVERABLE-DEDUP-VERIFY/repeated.png`、`samebase.png`。
**红旗**：无。

## 28. N-DELIVERABLE-DEDUP-VERIFY-FU1（PR #2835，已合）

**一句话**：同一文件用「./report.html」和绝对路径各写一次也只算一张卡——路径拼写差异不再造成重复卡。

**验收逐条**：①相对+绝对同轮只渲染 1 张卡 → 证据在（web 构建 relabs 截图）；②两层键同改（ownership file: 键+dedupKeyForCard）→ 证据在；③补同路径不同拼写 case+反向变异红行 → 证据在（mutation/relabs.png）；④预期收益 → 达成。

**爸要看（0 项必看）**。编排可代验：`~/work/out/N-DELIVERABLE-DEDUP-VERIFY-FU1/relabs.png`、`mutation/relabs.png`。
**红旗（轻）**：证据档正文一处截图路径写错（`…/code-agent-private-archive/docs/mutation/relabs.png` 不存在），实际文件在 out 目录（上行）；纯笔误不挡收。

## 29. N-CRON-WEBHOOK-CLOUD-HOOK（PR #2551）

**一句话**：外部系统（Sentry/Linear 等）的告警将来能直接触发 Neo 任务——本单把 Neo 侧收流、请求体只进 untrusted 块、隐私说明、Sentry/Linear 文档都做完并验了。

**验收逐条**：
- 「① 云端路由验令牌后经现有事件流推给本机或 runsOn 云端直跑」→ 部分证据在：Neo 侧收流成立；「云端验令牌」在中继仓（另一单），「runsOn 云端直跑」未做——**需爸拍板要不要做**。
- 「② 请求体只进 untrusted 块」→ 证据在（preamble/闭合不含请求体+真 GLM 忽略内嵌指令）。
- 「③ 隐私说明写明请求体经 Neo 云」→ 证据在（cron-webhook-relay.md+NOTICE 表 B）。
- 「④ 文档示例 Sentry/Linear」→ 证据在。
- 「⑤ 反向变异：错令牌 401」→ 部分达成：401 判定在中继仓，本单只证了 register 401 包装成可区分错误——本单无此红行。
- 「预期收益：外部系统告警能触发 Neo 任务」→ 未达成（机制具备，非工人可补）：中继未部署、hook URL 没有用户入口，用户目前拿不到。

**爸要看（2 项）**：
1. 拍板 runsOn 云端直跑做不做（仅爸手判，已转 followup）。
2. 中继仓部署排期——端到端收益要等它上线后开真机验收单（仅爸手判）。
**红旗**：挂着「待验」但收益侧实际卡在外部依赖+爸拍板；「错令牌 401」的反向变异本单没有。

## 30. N-DOGFOOD-TARGETED（mini 仓 PR#206；主仓无 PR）

**一句话**：给「合并后的定向 dogfood」装上自动运行器——按改动路径映射挑 PR，用 kimi/GLM 只读探索 Neo 界面找体验毛病、自动入池，不用你逐个 PR 手工点。

**验收逐条**：
- 「①映射表 mini/loops/dogfood-map.tsv…未命中的 PR 不跑」→ 证据在（30 行映射+命中/未命中测试）。
- 「②批次：…窗口内已合且命中映射的 PR 合跑一次，15 分钟 timeout 杀」→ 证据在（批次窗口合并/超时杀测试）。
- 「③发现经 N-DOGFOOD-INTAKE 入池，不改代码」→ 证据在。
- 「④额度：只用 kimi -p（或 StepFun 端点）…日志可证未调用 GLM/Claude」→ 证据在但**口径已被你 11-02 修订覆盖**（kimi→glm 链；且 zflash 被移出席位链——偏离你原话，证据档注明「需总控告知爸」）。
- 「⑤与 ui_shots_tick 互斥锁…」→ 证据在（原子 mkdir 锁+互斥测试）。
- 「⑥测试：命中/未命中映射、批次窗口合并、超时杀、互斥各一」→ 证据在（24 ok ALL PASS+9 条反向变异全绿）。
- 「⑦预期收益：…上线两周后复盘新增单数」→ 未做（设计如此：≈11-16 起算两周后复盘）。

**爸要看（1 项）**：
1. 知悉并认可席位链修订（zflash 移出，防误停队列工人；仅爸手判）。⑦的复盘到 11 月下旬自动排。
**红旗（轻）**：部署（软链+重启收活循环+装 plist）由总控做，本单证明不了已上线；浏览器能力要第一轮日志才能实测。

---

## 汇总表

| # | 单号 | 一句话 | 证据齐否 | 需爸亲验几项 |
|---|---|---|---|---|
| 1 | N-PERF-LONG-SESSION-RATCHET-FLAKE | CI 性能棘轮不再随机误红 | 齐 | 0 |
| 2 | N-PLANEXIT-K5 | 计划模式真机验收只跑了一半 | 缺（①一半 pending） | 1（拍板 Claude 侧） |
| 3 | N-PY-RUNTIME | 内置 Python 母单 | 无交付（无分支/PR/证据） | 1（处置拍板） |
| 4 | N-PY-RUNTIME-K3 | LibreOffice 按需自动装 | 齐（⑦真机转续单） | 0 |
| 5 | N-FIX-WF-STALL-SPAWN-AGENT | 子代理「暂无进展」徽标 | 齐 | 0 |
| 6 | N-NOTIFY-FAILURE-FOREGROUND-BANNER-FU2-FU1 | 聚焦时失败 toast 可见可跳转 | 齐 | 0 |
| 7 | N-AUDIOCAPTURE-RETENTION | 录音保留期清理母单 | 无交付（无分支/PR/证据） | 1（处置拍板） |
| 8 | N-RETENTION-APP-CACHES-REST2-FU1 | 截图删不掉有失败行+重试 | 齐 | 0 |
| 9 | N-MAIL-RECEIVED-TIME-LOCALE | 邮件时间不再「未知时间」 | 齐（真机项转出） | 1（真机看分诊） |
| 10 | N-CAP-NOTICE-LEAK-FU1 | 去除一条 CI 随机红 | 齐 | 0 |
| 11 | N-QUICKMODEL-CUSTOM-GLM-ROUTE | 小模型不再绕第三方中转 | 齐 | 0 |
| 12 | N-RUN-CONCURRENT-PERSIST-FAIL-FU1 | 消掉每会话一条持久化 warn | 齐 | 0 |
| 13 | N-CRON-AGENT-TIMEOUT-IGNORED | 定时 Agent 超时真生效 | 齐 | 0 |
| 14 | N-FIX-CRON-TZ-PLACEHOLDER-MANUAL-CWD | 时区灰字不骗人+无目录 cwd | 齐 | 0 |
| 15 | N-CRON-UNATTENDED-BASH-PARK-STUCK-REST1 | 无人审批 30 分钟自动拒绝 | 齐 | 0 |
| 16 | N-DELEGATE-WORKDIR-LAZY-FU1-FU1 | 不再冒空「任务_」夹 | 齐（真机转续单） | 0 |
| 17 | N-DELEGATE-WORKDIR-LAZY-FU1-FU1-FU2 | 重启清孤儿夹 | 齐 | 0 |
| 18 | N-FIX-PARKED-APPROVAL-NOCWD-RUN-WAITING | 无 cwd 僵尸 run 收口 | 齐 | 0 |
| 19 | N-PERM-BASH-PATH-ENAMETOOLONG-FU1 | 超长路径词不误报 | 齐 | 0 |
| 20 | N-FIX-PARKED-BANNER-STALE-AFTER-RESOLVE | 审批处理后提醒撤回 | 齐（原生横幅转 FU） | 0 |
| 21 | N-CRON-DETAIL-TIME-FORMAT-MIXED | 时间格式统一 24h | 齐 | 0 |
| 22 | N-FIX-CRON-EVENT-BUDGET-ERROR-TAB | 首存报错自动跳页 | 齐 | 0 |
| 23 | N-SIDEBAR-CRON-RUN-STATUS-STALE | 侧栏状态不再冻结 | 齐 | 0 |
| 24 | N-UI-ROLE-WAKE-CARD-REDO | 醒来卡按原型重做 | 齐（爸已认可） | 0 |
| 25 | N-APPROVAL-ARGS-PASSWORD-REDACT-FU1 | 日志掩码 password | 齐 | 0 |
| 26 | N-TELEMETRY-TURN-SOURCE-COLUMN | 遥测缺列修复 | 齐（云侧 followup） | 0 |
| 27 | N-DELIVERABLE-DEDUP-VERIFY | 产出卡去重 | 齐 | 0 |
| 28 | N-DELIVERABLE-DEDUP-VERIFY-FU1 | 路径拼写也去重 | 齐 | 0 |
| 29 | N-CRON-WEBHOOK-CLOUD-HOOK | webhook 触发任务（Neo 侧） | 缺（收益等中继+拍板） | 2（runsOn 拍板+中继排期） |
| 30 | N-DOGFOOD-TARGETED | 定向 dogfood 运行器 | 齐（⑦复盘未到期） | 1（席位修订知悉） |

**给爸的一句话**：30 张里 24 张证据齐、0 项必看（其中 1 张你已经亲认可过）；真正需要你的是 4 处拍板——#2 Claude 侧补不补跑、#3/#7 两张无交付母单怎么处置、#29 runsOn 直跑+中继排期；另有 #9 一处真机顺手看一眼、#30 席位修订知悉。


---

## 返修轮（2026-11-06 第二轮）

**队列退回原因**：上轮台账内容已写完（30 节 + 汇总表），末行 `DONE N-PENDING-ACCEPT-DIGEST 64ba8ef30`，但分支 mq/pending-accept-digest 比 origin/main 多 0 个提交、工作树干净——队列门按「没交活」退回，要求提交并重写 DONE 行。

**本轮处置**（调用记录修正）：
1. 上轮判定调用 #4「无需提交」被队列门推翻。处置照同批只读单先例（N-HUMAN-HOLD-PRECHECK-A/B：各在自家分支提交证据档快照，只 commit 不 push 不合并）：把本证据档快照落仓为 `N-PENDING-ACCEPT-DIGEST.md` 提交到本分支。仓内副本口径：绝对家目录路径一律写 `~/`（AGENTS.md §5.8）；上轮正文判定调用 #4 一行已同步改写、指向本节。
2. 内容复核（本轮重查，非照抄上轮）：30 节顺序与 `pending-accept-1106.txt` 30 行逐一对上；23 处台账引用的截图/证据路径逐一在盘核对全部存在；fleet JSON 复核关键断言——#3 N-PY-RUNTIME、#7 N-AUDIOCAPTURE-RETENTION 确无分支无 PR，#2 N-PLANEXIT-K5 确无 PR 且验收条①②③原文相符，#1 PR#2831、#29 PR#2551 及 #22 验收条原文相符。上轮 30 节判定原样有效，实质结论未改。
3. 本单全程只读维持不变：仓库除本证据档快照这一个新文件外零改动；未动任何队列/状态/台账文件，未 push、未合并。

收活 DONE 行：见台账 `~/work/evidence/N-PENDING-ACCEPT-DIGEST.md` 最后一行 = 本提交（分支 mq/pending-accept-digest）。
