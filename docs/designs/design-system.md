# Neo 设计系统规范(人读层)

> 状态: 生效中 · 2026-08-02 补建(此前被 `docs/architecture/frontend.md` 与
> `scripts/check-design-system.mjs` 引用但文件缺失)。
> 读者: 设计师、工程师、以及改 UI 的 agent。
> 定位: 这是"人读层"契约;机器可校验的那一半在 `scripts/check-design-system.mjs`(见 §5)。
> 来源: 品牌对齐稿 `neo-brand-design-language.html` 的成文结论 + 仓内代码里的"拍板"注释;
> 每条规则附出处,以代码为准。

Neo 的视觉身份是**深空新栖地**:界面是一艘飞船的舷窗,品牌表达集中在少数"橱窗",
工作区维持 Linear 式克制。本文回答三个问题:既定事实是什么(§1 六条 DNA)、
新主题怎么翻译进来(§2 四条原则)、落地用哪些 token / 资产 / 词库(§3/§4/§6)。

---

## §1 设计 DNA(六条既定事实)

这些不是审美偏好,是已经在代码里拍板的事实。任何新 UI 必须长在它们上面。

### DNA-1 亮度阶梯,不靠描边

暗色主题下层级靠**亮度 + 投影**表达,不靠堆 border:背景五层(`--bg-void` → `--bg-hover`/
`--bg-active`),另有一组 elevation token(`--elevation-l0..l3` + `--shadow-l2/l3/composer`),
消费方是 `global.css` 的 `.elevation-l2/.elevation-l3/.composer-elevated`。

- 理由: 2026-07-28"品质感打磨"拍板——暗色下描边堆层级显廉价,亮度阶梯才是精致感的根基。
- 出处: `src/renderer/styles/themes/dark.css`(elevation 拍板注释)、`src/renderer/styles/global.css`。

### DNA-2 单点品牌色,极度克制

品牌 teal(`--brand-primary: #0F766E`,teal-700 系)只出现在关键叙事位:AI 消息左缘 2px 竖条
(`.ai-message-indicator`)、streaming 呼吸光标(`.streaming-caret`)、欢迎页首张建议卡、发送键。
其余界面全部 zinc 灰阶。

- 理由: 品牌色是"标点符号",不是涂料;越少越贵。`#0F766E` 是 2026-07-02 产品负责人拍板的
  方案 A——白色前景下对比度 ≥4.5:1,由守卫脚本硬断言(见 §5)。
- 出处: `themes/dark.css`(`--brand-primary` 注释)、`global.css`(`ai-message-indicator` / `streaming-caret`)、`NewSessionWelcome.tsx`(首卡品牌青拍板注释)。

### DNA-3 终端混血美学(`--cc-*`)

工具调用行走 Claude Code 终端风:braille spinner(⠋⠙⠹)、`⎿` 结果符、"Worked for 1m0s"
折叠条,配一套独立的 `--cc-*` 橙色 token(`--cc-brand: #e87a35` 等),与 teal 主品牌并存。

- 理由: 这是工程师血统的证明,传递"严肃工具"的信任感;与星球美学是**双品牌分工**(§2-③)。
- 出处: `src/renderer/styles/global.css`(`--cc-*` 定义)、`src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/`。

### DNA-4 功能型动效为主,表现型走 PlanetSphere

`global.css` 里约 18 个 `@keyframes` 几乎全是**功能型**(fadeIn/slideUp/shimmer/pulse/typing……)。
品牌级表现型动效只有一个真源:`PlanetSphere` 组件及其 fx 档位(见 §4)。曾经的
`voice-presence-orb` 整套死 CSS(8 态呼吸球,无 TSX 消费)已在 2026-08-02 语音条星球化时删除。

- 理由: 表现型动效各处手搓会迅速失控;收敛到单一资产组件,动效语言才可维护、可审计。
- 出处: `src/renderer/styles/global.css`(keyframes 清单)、`src/renderer/components/brand/PlanetSphere.tsx`。

### DNA-5 拟人口吻,但"平静不吓人"

文案有明确人格:等待态具名(在等谁就说谁)、专家系统口语化("请 TA 来")、异常文案刻意平静。
拍板细则:不用警告色和惊悚措辞;**不放计时器制造焦虑**(回合总耗时不显示;长任务秒表是
"陈述一切正常",不是催促);中断会话降级为安静的"未完成",而不是红色"出错"。

- 理由: 情绪稳定是这个品牌的底色;用户凝视这个工具以小时计,焦虑型文案不可持续。
- 出处: `StreamingIndicator.tsx`(文件头与多处拍板注释)、`src/renderer/utils/sessionPresentation.ts`("别让历史会话全顶红吓人")、`i18n/voice.ts`(口语化错误文案)。词库见 §6。

### DNA-6 空态/图标体系:Lucide + EmptyState 原语 + 可选 planet

全 App 不用插画资产;图标统一 Lucide。空态收敛在 `EmptyState` 原语的 4 个变体里:
`box`(虚线卡片纯文本)/ `panel`(虚线面板+图标)/ `plain`(无边框居中)/ `inline`(单行浅字)。
2026-08-02 起原语新增**可选 `planet` 属性**:传了就在图标位渲染 34px 慢转星球(20s/周)。

- 理由: `planet` 是图标位的可选内容,**不是第 5 种变体**——4 变体的结构/排版一律不动;
  出现新形态先想能不能归并进这 4 种。`box`/`inline` 没有图标位,`planet` 对它们不生效。
- 出处: `src/renderer/components/primitives/EmptyState.tsx`(变体与 planet 约定注释)。

---

## §2 "新栖地"主题的四条转译原则

不是换皮,是把星球叙事翻译进 §1 的 DNA。四条原则决定每个触点"能动多少"。

### ① 舷窗原则 —— 界面是舷窗,不是海报

星球、星点、辉光只允许以**低亮度、小面积、慢节奏**存在。已落地的刻度:语音状态栏星球 22px、
空态星球 34px、欢迎页主视觉地球 42px(24s/周);空态统一 20s/周,比主视觉更慢一档不抢戏。

- 理由: Neo 是生产力工具,用户凝视它以小时计——看一眼觉得安静,看一小时不觉得吵。
- 出处: `VoiceChrome.tsx`(`size={22}`)、`EmptyState.tsx`(34px / 20s 注释)、`NewSessionWelcome.tsx`(42px / 24s 拍板注释)。

### ② 信号色原则 —— teal 是 Neo 的信号,不是装饰

品牌 teal 在新体系里有叙事身份:它是 **Neo 发出的信号光**(streaming 光标 = 正在传输、
左缘竖条 = Neo 在说话、语音"表达中"的太阳辉光 = teal)。语义色(成功/警告/错误)维持现状不动,
与信号色严格分层;`--cc-*` 橙色终端系保留为"工程舱"配色(见 ③)。

- 理由: 品牌色有叙事身份才不沦为装饰;语义色是功能语言,混层会同时毁掉两者。
- 出处: `themes/dark.css`(brand 与 semantic 两组 token 分列)、`VoiceChrome.tsx`(speaking 辉光 `rgba(45,212,191,.6)`)。

### ③ 双美学分工 —— 星球讲状态,终端讲过程

把隐性双品牌变成显性规则:**星球语言负责"状态与情感"**(语音七态、空态、欢迎页、等待);
**终端语言负责"执行过程"**(工具行、braille spinner、workedFor、折叠条)。一个是仪表盘的
氛围灯,一个是引擎舱的机械仪表——不混用、不互相替换。

- 理由: 用星球动画替换终端风工具行会丧失"严肃工具"的信任感;用终端字符表达情感又太冷。
- 出处: `PlanetSphere.tsx` + `VoiceChrome.tsx`(状态侧)、`ToolCallDisplay` + `--cc-*`(过程侧)。

### ④ 橱窗集中原则 —— 品牌表达集中在四个橱窗

升级火力集中在用户"停下来看"的时刻,四个橱窗已全部落地:

| 橱窗 | 落地形态 | 出处 |
|------|----------|------|
| 新会话欢迎页 | 42px 慢转地球主视觉 + NeoBrandMark 伴随小标 | `NewSessionWelcome.tsx` |
| 空状态 | EmptyState 可选 `planet` 属性(如侧栏会话空 = 地球) | `EmptyState.tsx`、`SidebarSessionList.tsx` |
| 实时语音 | 22px 星球七态状态栏 | `VoiceChrome.tsx` |
| 通话摘要 | "勘测报告 · 近地轨道"摘要卡 | `VoiceCallSummaryCard.tsx` |

工作区(消息流、设置、列表)维持 Linear 式克制,最多只换文案口吻。**90% 的界面不变,
变的 10% 全是记忆点。** 欢迎页建议卡维持原样(用户否掉"航线"包装),整页不加星点纹理。

---

## §3 token 体系速览

### 主题文件 × 4

| 文件 | `data-theme` | 现状 |
|------|--------------|------|
| `styles/themes/dark.css` | `dark` | 默认主题,active |
| `styles/themes/light.css` | `light` | active |
| `styles/themes/high-contrast-dark.css` | `high-contrast-dark` | **文件存在但未激活**:`useTheme.ts` 只 resolve `light`/`dark`,UI 无入口 |
| `styles/themes/high-contrast-light.css` | `high-contrast-light` | 同上 |

注意:守卫脚本的对比度断言**覆盖全部四套主题**(见 §5),改任何一套的相关 token 都会过门,
别以为 hc 未激活就能逃检。

**accent-accessible 拆分(2026-08-02 已落地)。** `--brand-primary` 恢复为**四主题恒等值
`#0F766E`**,只承担品牌表达(logo、品牌装饰、深色底填充按钮等白字搭配场景),由守卫脚本的
`brand-identity` 硬断言锁死;两套 hc 主题的可读性职责移交 `--accent-accessible`
(hc-dark `#00FFFF` 压 `--bg-void`、hc-light `#0000CC` 压白底,focus 描边/selection/链接等
交互 token 指向它)。dark/light 下 `--accent-accessible` 回退为 `var(--brand-primary)`,
保证相关 utility 在四主题下都有定义。**可读性场景一律用 `--accent-accessible`,
不许再靠改 brand 值解决。**

- 出处: `src/renderer/styles/themes/`、`src/renderer/hooks/useTheme.ts`、`scripts/check-design-system.mjs`(`CONTRAST_SCENARIOS`)。

### 尺寸 / 圆角 / 字号 / 时长缓动

全部定义在 `src/renderer/styles/global.css` 的 `:root`:

- 间距 `--space-0..12`(4px 基栅);圆角 `--radius-sm..2xl` + `--radius-full`;
- 字号 `--font-size-xs..3xl`(12–24px);时长 `--duration-fast/normal/slow`(150/200/300ms);
  缓动 `--ease-out` / `--ease-in-out`;
- 终端系 `--cc-*`(见 DNA-3)。

新代码一律消费这些 token;裸 px 圆角、裸 z-index、裸 `!important` 都会被守卫脚本拦(见 §5)。

### z-index 单一真源

全屏浮层层级统一从 `src/renderer/styles/zLayers.ts` 的 `Z_LAYERS` 取值
(modal 50 → criticalOverlay 3000,档间距是重新分配过的,历史魔法数字不是设计)。

- 用法: `style={{ zIndex: Z_LAYERS.toast }}`,**不要**用 Tailwind 任意值 class——JIT 扫不到
  运行时拼出的类名会静默不生效(zLayers.ts 文件头有踩坑记录)。
- 守卫: 裸字面值与 allowlist(`design-system-zindex-allowlist.json`)**双向核对**——用法不在
  表内即红,表项在代码里消失也红(防积压)。

---

## §4 品牌资产用法

### PlanetSphere(程序化星球,唯一表现型动效真源)

`src/renderer/components/brand/PlanetSphere.tsx`。Canvas 程序化生成 512×256 横向无缝贴图
(每种星球全局只生成一次并缓存),CSS `background-position-x` 位移模拟自转;地球多一层
透明云层(转速 = 地表 ÷1.9)。纯展示件:状态 → 星球的映射在消费方(如 VoiceChrome)。

Props 速查:

| Prop | 取值 | 说明 |
|------|------|------|
| `kind` | `mercury` / `earth` / `sun` / `jupiter` | 四颗主星,语义固定(见"使用边界") |
| `spinSeconds` | number | 自转周期(秒/周);越大越安静 |
| `fx` | `rms` / `pulse` / `corona` / `sway` / `dark` / `alert` / `none` | 动效档位,语义见下 |
| `glowColor` | rgba 字符串 | 辉光色 = 状态色 |
| `rms` | 0–1 | 已开方的真实电平,驱动辉光/微缩放;不造假动画 |
| `withOrbit` | boolean | 地球外围轨道环 + 3px 卫星点(寓意 Neo 环绕母星) |
| `size` | px,默认 22 | 球径 |

fx 语义:`rms`=真实电平驱动;`pulse`=信号握手脉冲;`corona`=日冕脉动;`sway`=低频起伏;
`dark`=暗面去饱和;`alert`=停转染红(异常态保留出错前那颗星球)。

**已接入场景:**

- 语音七态(`VoiceChrome.tsx` `PLANET_BY_VISUAL`):连接/重连=水星(pulse, 3.2s)、
  聆听=地球(rms, 16s,带轨道环)、表达=太阳(corona, 12s)、思考=木星(sway, 7s)、
  静音=地球暗面(dark, 40s)、异常=当前星球停转染红(alert)。
- 欢迎页主视觉(`NewSessionWelcome.tsx`):地球 42px / 24s / 静态。
- 空态(`EmptyState.tsx`):可选 `planet` 属性,34px / 20s。

### 可达性登记(哪些形态用户真的走得到)

"接进去了"不等于"用户走得到"。星球升级批的空态里有两处触发条件很窄,不登记的话后人会
把它们当常见状态去调,或者反过来当死代码删掉。**改这几处前先看这里。**

| 形态 | 触发条件 | 用户实际能不能遇到 |
|------|---------|------------------|
| 侧栏空态 · 地球 | 会话列表为空(`SidebarSessionList.tsx`) | **几乎遇不到**——见下 |
| 侧栏搜索无结果 · 水星 | 搜索/筛选无匹配 | 随时可达,正常状态 |
| 语音七态 | 通话生命周期 | 通话中全部可达 |
| 欢迎页地球 42px | 新会话欢迎页 | 常见 |
| Knowledge/Memory 审计空态 · 木星 | `KnowledgeMemoryPanel` 右栏无记忆且无搜索词 | **不可达**——见下 |

**侧栏地球空态是装饰性兜底,不是常见状态。** `sessionStore.ts` 的 `initializeSessionStore`
是三选一分支:已有 `currentSessionId` 就保持,`sessions.length > 0` 走 `switchSession`,
**只有列表真空才 `createSession('新对话')`**。所以首次启动(或用户手动清空全部会话)之后
列表就再不为空,这个空态从此不出现;全仓也没有自动清理空会话的逻辑,那条空壳会一直留着,
不会被清掉又重建。**全生命周期只会自动建这一条,不是每次启动建一条。**

- 2026-08-02 产品负责人拍板:**承认它是装饰性兜底,不为了让它可见去改 boot 行为**。
  改 boot 影响每个用户的每次启动(首屏从"有一条会话"变成空列表,输入框/工作目录/会话 id
  都要能在无会话状态下工作),而收益只有"少一条空壳 + 让一个装饰空态可见",不划算。
- 如果将来仍要改成懒建,**用它自己的理由单独立单**("启动要不要自动建空会话"是独立的产品
  问题),不要拿这个空态当动机——那是让尾巴摇狗。

**木星空态当前不可达**:它唯一的宿主 `KnowledgeMemoryPanel` 的入口
`setShowKnowledgeMemoryPanel(true)` 零产品调用方(资料库「记忆」tab 2026-07-27 已撤)。
去留见工单 `2026-08-02-KnowledgeMemoryPanel-并入设置记忆.md`(拍板:三块内容并入设置 →
记忆,整窗页壳子退役)。**注意木星这颗星球本身是活的**——语音思考态在用,别连它一起删。

### NeoBrandMark 与 assets/brand 三变体

`src/renderer/components/features/sidebar/NeoBrandMark.tsx`:N2 星芒标——深空渐变圆角砖 +
直笔 N(青渐变描边)+ 收笔右上四点星芒 + 静态轨道环。Props:`size`(默认 22)、
`showWordmark`、`animatedOrbit`(轨道卫星点 6s/圈)。静态资产在 `src/renderer/assets/brand/`:
`agent-neo-color.svg` / `agent-neo-inverse.svg` / `agent-neo-monochrome.svg`,
与 `src-tauri/icons/agent-neo.svg` 同源(48×48 viewBox)。

- 拍板: 品牌标的色是**固定字面色**,不随 `--brand-primary` 派生(深空砖在任何主题下都是
  深色底)——这是与旧版 color-mix 派生的有意差异,守卫脚本里以 `ds-allow` 区块豁免登记。

### 使用边界(克制清单)

- **不扩张星球语义**:主星只有 4 颗,语义固定——地球=用户/母星、太阳=Neo 表达、
  木星=思考/执行、水星=连接/信号。不做"功能星座",不让每颗星球对应一个功能入口。
- **不给阅读区加背景纹理**:消息流、代码区、设置页不加星点/星球背景——任何背景纹理都是
  干扰,违反舷窗原则(欢迎页整页不加星点纹理就是这条的落地)。
- **不用星球替换终端风工具行**(§2-③);**不做 3D 全景 / WebGL 首页**(性能预算留给模型推理)。
- **reduced-motion 约定**:`prefers-reduced-motion` 下 PlanetSphere 内建 CSS 关闭全部
  自转/呼吸/卫星动画,保留静态星球 + 颜色;NeoBrandMark 卫星点同样自动停转
  (`global.css .neo-orbit-satellite`)。消费方**零处理**,不要自己再写一套。

---

## §5 守卫机制(machine-checkable 的一半)

`scripts/check-design-system.mjs` 是静态门,本文档是它注释里指的"契约"。
**七条规则**(扫描 `src/renderer`,测试文件除外):

1. `hardcoded-hex` — 禁硬编码 `#rrggbb`,走 token。
2. `bare-button` — 禁裸 `<button>`,走 `primitives/` 的 Button/IconButton。
3. `handrolled-modal` — 禁手搓 `fixed inset-0` 遮罩,走 `primitives/Modal.tsx`。
4. `bare-px-radius` — 禁裸 px 圆角,走 `--radius-*`。
5. `bare-z-index` — 禁裸 z-index,走 `Z_LAYERS` + 双向 allowlist 核对(见 §3)。
6. `important-unjustified` — 禁无登记的 `!important`。
7. `local-display-primitive` — 禁在 `primitives/` 之外新增本地 EmptyState/Badge 定义。

另有两条**硬断言**(非棘轮,任何回退直接红):

- `brand-contrast` — 四套主题按各自真实用法场景核对 WCAG ≥4.5:1:dark/light 的
  `--brand-primary` 对白色前景;hc 两套的 `--accent-accessible` 按用法核对
  (hc-dark 前景压 `--bg-void`、hc-light 前景压白底)。
- `brand-identity` — 四套主题 `--brand-primary` 必须等于品牌恒等值 `#0F766E`;
  可读性需求走 `--accent-accessible`,不许再靠改 brand 值解决(见 §3)。

**豁免写法**(必须显式、必须带理由):

- 行内: `// ds-allow:<kind> 理由`(kind = `viz`/`button`/`modal`/`radius`/`z`/`important`/`primitive`/`brand`);裸 `ds-allow` 放行任意规则,是给特殊场景留的口子,慎用。
- 区块: `// ds-allow:start 理由` … `// ds-allow:end` 之间整段跳过(品牌贴图调色板、品牌图标字面色用这个)。
- 自动豁免: 数据可视化目录(脚本内 `VIZ_EXEMPT` 清单)与模板字符串内 hex(注入 iframe 的自包含 HTML,CSS 变量级联不进去)。

**Baseline ratchet(棘轮)**:历史违规不清零,记在 `scripts/design-system-baseline.json`;
门只拦"超出基线的新增",收口一批后跑 `--update` 降基线(只降不升)。
其他模式: `--report` 只看分布,`--contrast` 只测对比度明细。

---

## §6 文案词库

### 三种等待信号(`src/renderer/i18n/chatTranscript.ts`)

| 信号 | 场景 | 文案 |
|------|------|------|
| 回响信号 | 等模型响应 | "信号传输中,正在等待模型回响…" |
| 编队信号 | 等子任务 | "编队作业中,子舰并行中" / "编队作业中,{count} 艘子舰并行" |
| 巡航信号 | 长任务 ≥45s | "深空巡航中 · 已航行 {elapsed} · 链路正常" |

- 编队信号的 `{count}` 必须来自当前回合仍在运行的真实子任务数;单个子任务或计数不可用时
  用无数字版,**不造数**(`StreamingIndicator.tsx` 注释拍板)。
- 巡航秒表是中性陈述"一切正常",不是催促;这是长任务唯一值得浮现的状态。

### 勘测报告(语音闭环)

通话摘要卡对外叙事名"**勘测报告 · 近地轨道**"(`VoiceCallSummaryCard.tsx`,`i18n/voice.ts`
`call.surveyTitle`),产出物总计为"本次带回 {n} 件宝藏"——`{n}` 是展开区真实列出的字幕条数,
数据模型没有的字段(稀有度/类型)不造标签。侧栏会话空态文案"还没有勘测记录"(`i18n/sidebar.ts`)与之一脉。

### 语音星球词(`i18n/voice.ts` `planet.*`)

状态词七态:连接中/重连中/聆听中/表达中/思考中/已静音/连接异常;
星球 hint:`EARTH · 环绕母星`、`SOL · 发光回应`、`JUPITER · 风暴搅动`、`MERCURY · 信号握手`。

### "平静不吓人"原则与反例(DNA-5 的文案侧)

**要做**:中性、具名、信息性("正在等待模型回响…");异常降级为安静的"未完成";
错误文案口语化、给下一步("连不上语音服务,稍后再试")。

**不要做**(反例):惊悚措辞 + 警告色("出错了!""连接已崩溃");等待计时器制造焦虑
(回合总耗时不放计时器);把中断/历史会话顶成红色"出错" chip(降级为"未完成");
编造数据(没有真实计数就用无数字版文案)。

---

## 附:改动这份文档的约定

- 规则以代码为准:本文与代码注释冲突时,先信代码,再回来修文档。
- 新增一条规则 = 一句话规则 + 一句理由 + 代码出处路径;不贴大段代码。
- §5 的规则清单与 `check-design-system.mjs` 文件头保持同步,改一边必须改另一边。
