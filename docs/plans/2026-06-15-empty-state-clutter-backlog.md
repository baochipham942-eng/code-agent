# 空状态/侧栏/composer 减法 backlog

> 来源：2026-06-15 dogfood 新会话空状态截图，用户一眼挑出 15 处"看不懂"。
> 病根与 trace 同源：把引擎内幕(能力计数/MCP·Skill chip/模型能力警告)堆首屏 + 状态语义错乱 + 黑话。
> 按【该删 / 该收 / 该改语义 / 该说人话】四类整理。动手前核对行号。

## 该删（纯噪音，从首屏移除）

| # | 元素 | 位置 | 修法 |
|---|------|------|------|
| 1 | 左上角悬浮的「选择工作目录」气泡卡在窗口边角，像没收掉的 tooltip | `TitleBar.tsx` / `WorkingDirectoryPicker.tsx` | tooltip 定位 bug，修定位或删 |
| 7 | 会话标题下随机挂「MemoryRead」「WebSearch」工具标 | `features/sidebar/SidebarProjectDetail.tsx` | 对用户无意义，删；要留则 hover 才显 |
| 10 | 一排「MCP tavily / Skill apify-actorization / MCP brave-search / Skill browser-clipboard-debug / Skill buddy-change」随机能力 chip | `features/chat/ChatInput/CapabilitySuggestionStrip.tsx` | 空状态不该堆能力 chip；收进 AbilityMenu 按钮后 |

## 该收（引擎内幕，默认折叠/仅相关时显）

| # | 元素 | 位置 | 修法 |
|---|------|------|------|
| 8 | 「联网任务建议搜索模型」黄色警告条**用户还没发消息就跳出来** | `features/chat/ChatInput/ModelStrategyRecommendationStrip.tsx` | 只在用户输入了联网类意图后才提示；空状态不显 |
| 9 | 「Skills 0/131 · MCP 0/16」神秘计数器 | `features/chat/ChatInput/index.tsx` | 0/131 是好是坏没人知道；收进 AbilityMenu，不在首屏裸露原始计数 |

## 该改语义（状态/计数错乱，先修对再谈美）

| # | 元素 | 位置 | 问题 |
|---|------|------|------|
| 5 | **所有历史会话都顶红色「待处理」** | `features/sidebar/SidebarProjectDetail.tsx` / `SidebarProjectDrawer.tsx` | 一周前的对话为什么是 pending？红色=要我做事吗？状态映射错乱，最刺眼 |
| 6 | 「未分类 7 未完成」+「7 待处理」+「50 会话」三个数对不上 | 同上 | 三套计数关系不明，收敛成一个清晰的数 |
| 2 | 「新会话」按钮(左上) 和 大标题「新会话」**同词出现两次** | `Sidebar.tsx` + `ChatView.tsx` | 去重或区分措辞 |
| 3 | 「空白」(顶部) vs「空白会话」(右上) **两个空白** | `ConversationTabs.tsx` / `ChatView.tsx` | 区别不明，合并或改名 |
| 4 | 「选择目录」(按钮) vs 悬浮「选择工作目录」重复 | `TitleBar.tsx` / `ChatView.tsx` | 合并为一个入口 |

## 该说人话（黑话翻译）

| # | 元素 | 位置 | 改 |
|---|------|------|-----|
| 8 | 警告条文案"未标记搜索能力""搜索特化主任务模型""任务:联网检索 需要:搜索" | `ModelStrategyRecommendationStrip.tsx` | 人话："这个任务要联网搜索，当前模型可能不擅长，换个搜索模型更稳" |
| 11 | 「逐次确认」(一把锁图标) | `features/chat/ChatInput/PermissionToggle.tsx` | 说清确认什么（每步操作前问你），或加 tooltip |
| 12 | 「Explorer **\***」星号什么意思 | `features/chat/ChatInput/` | 星号语义不明，去掉或解释 |
| 13 | 绿色脑子图标**无标签** | `features/chat/ChatInput/` | 加标签（思考模式开关？） |
| 14 | 「Neo · MiMo v2.5 Pro · **Think · Low**」 | `StatusBar/ModelSwitcher.tsx` | "Think""Low"是什么？→"思考:低" 之类人话 |

## 优先级（按伤害）
1. **状态语义**：#5 全红「待处理」+ #6 三数对不上 —— 最刺眼、最误导，先修。
2. **首屏降噪**：#8 未发就跳的黑话警告 + #10 随机能力 chip + #9 神秘计数器 —— 把引擎内幕收走。
3. **去重**：#2/#3/#4 重复入口 + #1 悬浮气泡 bug。
4. **说人话**：#8 文案 + #11/#12/#13/#14 底栏图标/标签。

> 全程只读分析；file:line 待动手前核对。
