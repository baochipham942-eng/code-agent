// ============================================================================
// Placeholder marker 词表 —— 三处共用的单一真源（N-ARTIFACT-PLACEHOLDER-GATE）
//
// 「扫什么」只在这里定义一次；三处消费方只决定「怎么扫」：
//   · dashboard htmlProbes 的 no_lorem_ipsum 探针（正则 source，i 标志）；
//   · toolArtifactRepairPolicy 的补丁占位判据（整段判词 / 标识符 marker）；
//   · deliverableDiskCheck 的交付物正文扫描（逐行 i 匹配 + 定位回显）。
// 本刀之前 htmlProbes 与 toolArtifactRepairPolicy 各自维护一份字面量正则；
// 交付物正文扫描是第三个消费方，不许再抄第三份——统一引用本模块。
//
// ai-review PR#2079 Round 2 起词表拆成三个形态层（裸单词不再 substring 生效）：
//   · PLACEHOLDER_TEXT_PATTERN_SOURCE —— 全量 substring 词族（office/html 等无歧义面）；
//   · PLACEHOLDER_UNAMBIGUOUS_TEXT_SOURCE —— 无歧义子集（md/txt 行扫直接用）；
//   · PLACEHOLDER_BARE_WORD_SOURCE + PLACEHOLDER_WHOLE_VALUE_WORD_SOURCE ——
//     裸英文单词（todo/tbd/placeholder）只在脚手架形态（括号包住/标记独行/整值）才算，
//     由消费方按形态编译。
// ============================================================================

/**
 * 无歧义正文占位词族（substring 即命中，配 i 标志）：lorem/示例数据等脚手架专名
 * 与 CJK 标记。CJK 词不需要 \b（汉字皆非 \w 字符，边界天然存在）；「待补」覆盖
 * 「待补充/待补全」等前缀延伸，不再重复列（PR#2079 Round 2 Nit 去冗余）；「占位」
 * 会连带命中「占位符」，技术文档讲解占位符语法属可接受的误伤面（与 htmlProbes
 * 既有立场一致），用户明确要模板/占位交付物时由 deliverableDiskCheck 侧豁免兜住。
 */
const UNAMBIGUOUS_TEXT_ALTERNATIVES = [
  'lorem ipsum',
  'coming soon',
  '占位',
  '待填写',
  '此处填写',
  '待补',
  '示例数据',
  '样例数据',
  '\\[\\s*insert[^\\]]*\\]',
  '\\bx{3,}\\b',
];

/**
 * 裸英文占位词（md/txt/csv 里 substring 命中会是误报重灾区——README 的 TODO 章节、
 * CSV 的 TBD 状态列、i18n 值里的 placeholder 文案——只允许脚手架形态命中：
 * 括号/花括号包住、全大写标记独行跟冒号、整值等于标记。todo/tbd 配 \b 使用，
 * "todomvc"、base64 长串中间的 xxx 不算命中；bare "insert" 是常用英文词不单列）。
 */
export const PLACEHOLDER_BARE_WORD_SOURCE = 'todo|tbd|placeholder';

/**
 * 正文占位词族全量（配 i 标志使用；= 无歧义子集 + 裸单词的 \b 形态）。
 * 词表 = 仓内既有两份（htmlProbes.no_lorem_ipsum、toolArtifactRepairPolicy 整段
 * 判词）取并集，再补任务书点名的 [insert…] / TBD / XXX 连串 / 示例数据。
 * 消费方：htmlProbes 探针、deliverablePlaceholderScan 的 office/html 段扫描。
 */
export const PLACEHOLDER_TEXT_PATTERN_SOURCE = [
  ...UNAMBIGUOUS_TEXT_ALTERNATIVES,
  '\\bTODO\\b',
  '\\bTBD\\b',
  'placeholder',
].join('|');

/**
 * 无歧义词族单独导出：md/txt 行扫描用它做 substring 匹配，裸英文单词走脚手架
 * 形态判据（PR#2079 Round 2 Important：宁可漏拦，不可误伤）。
 */
export const PLACEHOLDER_UNAMBIGUOUS_TEXT_SOURCE = UNAMBIGUOUS_TEXT_ALTERNATIVES.join('|');

/**
 * 「整值/整格即占位」的等值词族（JSON 字符串值、CSV 单元格用，锚定 ^…$ + i）：
 * substring 语义不适用——equality 要穷举，待补/待补充必须分列。
 */
export const PLACEHOLDER_WHOLE_VALUE_WORD_SOURCE = [
  'coming soon',
  'todo',
  'tbd',
  'placeholder',
  '占位符?',
  '待补充',
  '待补',
  '待填写',
  '此处填写',
  '示例数据',
  '样例数据',
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
