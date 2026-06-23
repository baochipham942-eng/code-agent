// ============================================================================
// rmFlagPattern — 危险 rm 命令的共享 flag 前缀正则片段
// ----------------------------------------------------------------------------
// 三个独立的危险命令检测器（commandSafety.validateCommand / planning 的
// matchDangerousBash / permissionClassifier）各自有一份 rm 正则。早期实现用
// `(-[rRf]+\s+)*` 只能吃短 flag 簇（-rf / -fr / -r -f），漏掉等价的长选项写法
// `rm --recursive --force /`、`rm -r --force /` —— 三道防线全旁路。
//
// 把"rm 后面那串可选 flag"抽成单一真源，三处复用，杜绝漂移（漂移=安全洞）。
// 覆盖：短簇(-rf)、长选项(--recursive/--force)、`--` 分隔符，任意顺序、任意个数。
// ============================================================================

/**
 * 匹配 `rm` 与目标路径之间「零个或多个 flag token」的正则片段（字符串形式，
 * 供 `new RegExp` 拼接）。每个 token 形如 `-rf` / `--recursive` / `--`，后随空白。
 *
 * 注意：这里故意不限定 flag 必须是 recursive/force —— 既有行为是「任何指向
 * 绝对路径 / ~ 的 rm 都要确认」，flag 前缀只是可选装饰；放宽 flag 形态只会让
 * 更多等价写法落入同一分级，偏向「多确认」是安全的。
 */
// 单个 flag token：短簇 `-rf`、长选项 `--recursive`（含 `--interactive=never` 这类
// 带 `=值` 的形态）、`--` 分隔符。`=\S+` 让带值长选项不会断开整串 flag。
const RM_FLAG_TOKEN = String.raw`(?:-[A-Za-z]+|--[A-Za-z][\w-]*(?:=\S+)?|--)`;

export const RM_FLAGS = String.raw`(?:${RM_FLAG_TOKEN}\s+)*`;

/**
 * 同 {@link RM_FLAGS}，但要求「至少一个」flag token。
 * 用于通配符 / 当前目录删除这类「裸 `rm *` 不算危险、但带任意 flag 就危险」的场景，
 * 保留原 `-rf?` 的「需带 flag」语义，同时不再漏掉 `-fr` / `--recursive` / `--force`。
 */
export const RM_FLAGS_REQUIRED = String.raw`(?:${RM_FLAG_TOKEN}\s+)+`;

/**
 * `rm` 命令头：左侧负向后顾排除单词字符/连字符，避免把 `confirm /`、`foo-rm /`
 * 这类把 `rm` 当子串的命令误判；同时仍能命中 `/bin/rm`、`\rm`、`;rm`、行首 `rm`。
 */
export const RM_HEAD = String.raw`(?<![\w-])rm\s+`;
