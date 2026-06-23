# 实施计划 · 画布 Undo/Redo

> 来源：竞品借鉴(Alma)地基项⑤。架构师蓝图 + 艾克斯(codex)对抗审计修订。
> 定位：Agent Neo = cowork 人机协作产品；设计画布是产物 surface 之一，undo/redo 是直接操作类工具 table-stakes。
> 生成日期：2026-06-23　状态：待实施（建议第一刀）

## 决定性发现
undo/redo 在"生成产物版本层"已存在：`variantHistory.ts` 的 canUndo/canRedo/previousVariantId/nextVariantId 已实现；`DesignCostHistory.tsx` 已渲染 Undo2/Redo2 按钮，回滚=setChosen(previousVariantId)（移 pinned 指针，非破坏）。
**真缺**：① 编辑操作（节点移动/缩放/删除/标注增删）无 undo；② 全局 Cmd+Z/Cmd+Shift+Z 不存在。

## 架构决策：Snapshot 快照栈(Layer1) + 复用现有 spine undo(Layer2) + 键盘层
- Layer1（新建）：编辑操作的 CanvasNode[] **深拷贝**快照栈，max 50。
- Layer2（已有）：生成/编辑产物走 variant spine + pinned 指针。
- 不选 Command Pattern（代码量 3x）；不选 zundo/temporal（引依赖 + 混合瞬时态需 partialize）。

## 关键文件
新建：`src/renderer/components/design/canvasEditHistory.ts`（纯逻辑：pushSnapshot/undoEdit/redoEdit/clearHistory/canEditUndo/canEditRedo，MAX=50）+ `tests/renderer/design/canvasEditHistory.test.ts`。
修改：
- `designCanvasStore.ts`（加 editHistory state + 5 action；updateNode/deleteNode/renameNode 内 set 前 pushEditSnapshot；loadDoc/resetCanvas 调 clearEditHistory；partialize 不序列化 editHistory）。
- `useDesignCanvasGeneration.ts`（生成函数**成功提交后**调 clearEditHistory）。
- `DesignCanvas.tsx`（标注 annotHistory ref；keydown useEffect 组件内注册；input/textarea/IME 跳过；Cmd+Z 标注优先编辑次之）。
- i18n `zh.ts`/`en.ts`（4 键）。

## 🔴 艾克斯对抗审计修订（必须并入实现）
1. **[HIGH] Layer1↔Layer2 事务边界**（designCanvasStore.ts:73/91、variantSpine.ts:79/101）：撤销若只回滚 nodes 会留下 spine pinned；只回滚 spine 会留下画布 chosen/visible 错位。**两层必须同一事务边界**——明确"编辑操作只动 Layer1、生成操作只动 Layer2"，且 undo 一个生成时两者协调（生成不进 Layer1，由 Layer2 setChosen 管，见规则）。
2. **[HIGH] 快照必须深拷贝**（designCanvasStore.ts:55/61/115）：loadDoc 直接吃 doc.nodes，addNode 只换数组，toDoc 直接返回 s.nodes。Layer1 若沿用引用策略，后续 patch/chosen/discarded 变化会污染历史帧。**pushSnapshot 必须 structuredClone/深拷贝**。
3. **[MED-HIGH] clearEditHistory 时机**（DesignCanvas.tsx:414/636/641/642）：必须绑"生成**成功并 commit 之后**"，不能绑发起/进入 generating/取消/错误路径，否则中断时抹掉用户最后一个可恢复画布态。
4. **[MED] 键盘输入边界**（DesignCanvas.tsx:524/781/785/859/961）：已有全局 paste listener + 画布内 text input + 两个 textarea。直接挂 window keydown 会和文字编辑/IME 组合/标注文本 Enter-Esc 抢事件。须 input/textarea return + isComposing 跳过 + 组件内注册（切 tab 自动 cleanup）。
5. **[MED] selectedNode 清空与 annotHistory 同事务**（DesignCanvas.tsx:459/500/560/582）：点空白 setSelected([]) → selectedNode.id 变化清 annotations/draft/annotShapes；撤销若恢复选择却不恢复标注，侧栏/框选/历史帧背离。annotHistory 在 selectedNode 变化时同步清。

## 协调规则
- 规则1：生成操作 addNode 不进 Layer1（回滚由 Layer2 setChosen 管）。
- 规则2：Layer1 在 loadDoc/resetCanvas 清空。
- 规则3：键盘只绑 Layer1；Layer2 undo 在历史面板按钮（已有），无路由冲突。
- 规则4：deleteNode 真删（进 Layer1）vs discardNode spine 软删（不进 Layer1，Layer2 restore）。
- 规则5：clearEditHistory 在生成**成功提交后**（修订 3）。

## 分步（TDD）
- Phase1 canvasEditHistory.ts 纯逻辑 + 单测（含深拷贝断言）S(~2-3h)
- Phase2 接 store（editHistory + 5 action，改 updateNode/deleteNode/renameNode）S(~1-2h)
- Phase3 生成路径 clearEditHistory（绑成功提交后）XS(~30min)
- Phase4 键盘绑定 + 标注栈 + i18n（输入边界全守）S(~1-2h)
- Phase5 持久化 debounce 300ms XS(~30min)
- Phase6 视觉验证（renderToStaticMarkup + 手动 dogfood）S(~1h)

## 未决
- canvas 节点 resize/Transformer 是否已实现（若有需 onTransformEnd 推快照；暂无则 Phase1 不处理）。
