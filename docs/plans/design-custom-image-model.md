# 实施计划 · 自定义生图模型端点

> 来源：竞品借鉴(Alma)真借鉴项①（yetone 推文被点赞的"Image Generation 模型自定义"）。架构师蓝图 + 艾克斯对抗审计修订。
> 定位：Agent Neo = cowork 人机协作产品。设计画布产物 surface 让用户接自己的生图模型。
> 生成日期：2026-06-23　状态：待实施（建议第二刀，⑤ 之后）

## 范围
第一刀**只做文生图(t2i)**。mask edit/expand/annotEdit/region-lock 继续绑已知 provider，等能力配置 + 安全守卫成熟再开放。

## 架构决策：运行时叠加层（Option C）
- 静态 `IMAGE_MODELS`（visualModels.ts:19，readonly const）只存内置，永不改。
- 自定义模型存 `customImageModelRegistry`（主进程落盘 JSON + key 走 SecureStorage），在 list/generate 路由处与静态表合并。
- 类型层：`ImageEngineId` 加 `'openai-compat'`，`VisualProviderId` 加 `'custom'`，caps 固定 `['t2i']` 硬编码。

## 关键文件
新建：ssrfGuard.ts / customImageModelRegistry.ts / CustomImageModelManager.tsx + 3 测试。
修改：visualModels.ts(扩类型) / imageGenerationService.ts(新增 generateImageOpenAICompat，不改 generateImage 主签名) / workspace.ipc.ts(handleGenerateDesignImage 加分支 + handleListVisualImageModels 合并 + 3 case) / ImageModelPicker.tsx + DesignWorkspace.tsx(+按钮) / i18n。

## 数据流
填表 → saveCustomImageModel → validateCustomBaseUrl(SSRF) → 连通性探测(真实 256x256 出图) → 落盘 + setCustomModelApiKey。
出图 → 先查 listCustomImageModels 命中 → getCustomModelApiKey → 再 validateCustomBaseUrl → generateImageOpenAICompat → isImageUrl ? download(过 isSafeImageUrl) : b64 → 写盘(assertWithinDesignDir) → 返回{path,actualModel,costCny}。

## 🔴 艾克斯对抗审计修订（必须并入实现）
1. **[HIGH] 能力守门又一漏网入口**（workspace.ipc.ts:88）：`referenceImageDataUrl`（参考图垫图）分支**完全绕过 payload.model**，固定进 generateImageFromReference，无 cap/provider/custom 判断。蓝图只盯 mask/expand/annotEdit 静态表守门，**漏了参考图垫图这个仍挂在 generateDesignImage 下的编辑入口**——自定义模型撞进来须显式拦截或定义行为。
2. **[HIGH] 已有裸下载入口**（workspace.ipc.ts:622/1124）：`downloadFile` 是 IPC 暴露的裸 fetch(payload.url) 任意 URL 下载攻击面。蓝图只补自定义 baseUrl + 返回图下载，**这个已有入口要一并纳入 SSRF 守卫**（独立小修，归到本计划的安全收口）。
3. **[MED-HIGH] 静态 helper 兼容边界**（visualModels.ts:30）：imageEngineForModel() 假设所有模型映射静态 ImageEngineId。**必须把"所有旧 helper 仍只认静态表"列成硬边界**——任何路径误用 imageEngineForModel(custom-id) 就抛未知模型异常。出图路由对 custom 走独立分支，不进 imageEngineForModel。
4. **[MED-HIGH] 付费探测护栏**（workspace.ipc.ts:79）：256x256 保存探测**必须补**显式确认 + 频率限制 + 重复保存去重 + 超时取消账单提示（对齐项目"付费 API 默认提示 + 只跑一次"规矩）。否则配置保存变成可反复触发的小额扣费口。
5. **[MED] 返回契约向后兼容**（workspace.ipc.ts:936）：listVisualImageModels 现只回 id/label/provider/available。塞 custom provider + 每模型独立 key 后，须补契约版本/cap 字段/custom 可用性来源/旧 renderer 对未知 provider 的展示，防"列表可见但状态错"。

## 能力声明
caps 固定 ['t2i']。mask/expand 按钮用 imageModelsWithCap('maskEdit') 只查静态表自然不可用；annotEdit 守门 imageModelById 查静态表返回 undefined → 抛错。**外加修订 1：参考图垫图入口须显式拦自定义模型。**

## 成本
estimateImageCostCny 对自定义模型走 default 0.14；用户可选填 costCnyPerImage 绕开价表。pricing.ts 不改。

## 分步（TDD）
- Phase1 基础设施(visualModels 扩类型 + ssrfGuard + customImageModelRegistry + 测试)S(~1h)
- Phase2 路由(generateImageOpenAICompat + workspace.ipc 分支/合并/3 case + 修订1参考图拦截 + 修订3边界)S(~1.5h)
- Phase3 UI(CustomImageModelManager + 入口 + i18n)M(~3h)
- Phase4 打磨(付费探测护栏[修订4] + 裸下载收口[修订2] + 返回契约[修订5] + 对抗审计)S(~1.5h)

## 风险
OpenAI 兼容端点返回格式不一(b64_json/url/data[0].url)出图要兼容；SecureStorage 在 CLI 模式不可用须防御返 undefined 不崩；不支持单字段修改(删除重建)。
