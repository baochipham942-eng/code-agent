// ============================================================================
// Placeholder marker 词表 —— 三处共用的单一真源（N-ARTIFACT-PLACEHOLDER-GATE）
//
// 「扫什么」只在这里定义一次；三处消费方只决定「怎么扫」：
//   · dashboard htmlProbes 的 no_lorem_ipsum 探针（正则 source，i 标志）；
//   · toolArtifactRepairPolicy 的补丁占位判据（整段判词 / 标识符 marker）；
//   · deliverableDiskCheck 的交付物正文扫描（逐行 i 匹配 + 定位回显）。
// 本刀之前 htmlProbes 与 toolArtifactRepairPolicy 各自维护一份字面量正则；
// 交付物正文扫描是第三个消费方，不许再抄第三份——统一引用本模块。
// ============================================================================

/**
 * 正文占位词族（配 i 标志使用；TODO/TBD/XXX 的 \b 词边界见各 alternation 内）。
 * 词表 = 仓内既有两份（htmlProbes.no_lorem_ipsum、toolArtifactRepairPolicy 整段
 * 判词）取并集，再补任务书点名的 [insert…] / TBD / XXX 连串 / 示例数据。
 * 边界说明：
 * - TODO/TBD/XXX 用 \b 词边界——"todomvc"、base64 长串中间的 xxx 不算命中；
 * - CJK 词不需要 \b（汉字皆非 \w 字符，边界天然存在）；「占位」会连带命中
 *   「占位符」，技术文档讲解占位符语法属可接受的误伤面（与 htmlProbes 既有
 *   立场一致），用户明确要模板/占位交付物时由 deliverableDiskCheck 侧豁免兜住；
 * - [insert…] 用括号形态——bare "insert" 是常用英文词，不能单独当标记。
 */
export const PLACEHOLDER_TEXT_PATTERN_SOURCE = [
  'lorem ipsum',
  'coming soon',
  '\\bTODO\\b',
  '\\bTBD\\b',
  'placeholder',
  '占位',
  '待补充',
  '待填写',
  '此处填写',
  '待补',
  '示例数据',
  '样例数据',
  '\\[\\s*insert[^\\]]*\\]',
  '\\bx{3,}\\b',
].join('|');

/**
 * 「整段内容即占位」判词（补丁判据用）：整段（剥注释、归一空白后）恰等于其中
 * 一词才算占位；内容里只是「提到」这些词不算——那是正文扫描的职责，不是补丁判据的。
 */
export const PLACEHOLDER_EXACT_CONTENT_SOURCE =
  'dummy|test|todo|placeholder|place_holder|read_needed|placeholder_read_needed|tbd|待补|占位';

/** 占位/probe 标识符词族（补丁文本 marker 判据用；消费方自带 \b 锚与 i 标志）。 */
export const PLACEHOLDER_MARKER_IDENTIFIER_SOURCE =
  'probe_[a-z0-9_]*|placeholder_[a-z0-9_]+|place_holder_[a-z0-9_]+|placeholder_read_needed|read_needed|tbd';

/** 注释形态的占位 marker（行注释、块注释、HTML 注释开头后跟 probe/placeholder 系词）。 */
export const PLACEHOLDER_MARKER_COMMENT_SOURCE =
  '(?:\\/\\/|\\/\\*|<!--)\\s*(?:probe|placeholder|place_holder|read_needed|tbd)\\b';
