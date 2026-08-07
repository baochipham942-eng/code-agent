// ============================================================================
// 产物角色轴登记表（deliverable / material / receipt，2026-08-07）
//
// 「什么算产物」以前是反推式的：把工具调用的副作用全当候选产物，再用规则
// 往外剔，其中最关键的一道是写死 14 个工具名的 READ_ONLY 拒绝清单。反推
// 路线必然漏——已核实的三处：memoryWrite 写记忆被当成交付物（memory_write
// 不在清单里）、youtubeTranscript / mcpUnified 的来源 url 和 jira 新建 issue
// 走同一条 url 分支；同一个 web_fetch 抓的网页，聊天流判 link 降级进「来源」、
// 概览却转成 web_snapshot 摆进产物列表——同一个决策漏了一处实现。
//
// 根因：kind（text/image/document/web…）是媒体类型轴，被当成产物判据在用。
// 本表补上正交的角色轴：
// - deliverable：交付物，用户会带走的东西（产物列表只放这类）；
// - material：过程材料，来源、检索结果、读取内容、命令输出（进「来源」区）；
// - receipt：动作回执，发了邮件、建了日程、开了 issue（本期不上屏，只标语义）。
//
// kind → role 的默认登记在写入侧（产出点）可用 role 字段显式覆盖；消费端
// 一律过 isDeliverableArtifact 判，不许各判各的。satisfies 是牙齿：
// ToolArtifactKind 加了新 kind 而没在本表补 role ⇒ 编译期报错，不是静默漏。
// 未登记的 kind 字符串（normalize 出来的脏数据）fail-closed 归 material。
// ============================================================================

import type { ToolArtifactKind } from './artifactBlob';

export type ArtifactRole =
  | 'deliverable' // 交付物：用户会带走的东西
  | 'material'    // 过程材料：来源、检索结果、读取内容、命令输出
  | 'receipt';    // 动作回执：发了邮件、建了日程、开了 issue

/** kind → role 默认登记表（单一真源）。新增 kind 必须在这里补 role，否则编译期报错。 */
export const ARTIFACT_KIND_ROLE_REGISTRY = {
  document: 'deliverable',
  spreadsheet: 'deliverable',
  image: 'deliverable',
  audio: 'deliverable',
  video: 'deliverable',
  web: 'material',
  search: 'material',
  'process-output': 'material',
  'process-log': 'material',
  text: 'material',       // 含混轴：fail-closed 默认不进产物，确属交付物的产出点用 role 显式覆盖
  binary: 'deliverable',  // 二进制落盘物（zip 导出包、下载物）用户会带走；不存在「读出来的二进制」这种形态
} as const satisfies Record<ToolArtifactKind, ArtifactRole>;

function isArtifactRole(value: string | undefined): value is ArtifactRole {
  return value === 'deliverable' || value === 'material' || value === 'receipt';
}

/**
 * 解析产物的角色：产出点的显式 role 覆盖优先，否则查 kind 登记表。
 *
 * **未登记的 kind 归 deliverable，不是 material**——这条容易想反，理由：
 * 四个 material 类型（process-output / process-log / web / search）**全都显式登记在表里**，
 * 所以一个没登记的 kind 按定义就不可能是过程材料。反过来兜 material 的代价是
 * 「产物静默消失」：`normalizeToolArtifactCandidate` 在 kind 缺失时会填 `'artifact'`，
 * 任何没写 kind 的真产物都会因此从产物区蒸发（实测抓到：`kind: 'html'` 的 Write 产物消失）。
 * 丢用户的交付物，比多摆一条杂项严重得多。
 *
 * fail-closed 的意图由 `text: 'material'` 这条承担（含混轴不进产物），
 * 不靠惩罚未知 kind 来实现。
 */
export function resolveArtifactRole(artifact: { kind: string; role?: string }): ArtifactRole {
  if (isArtifactRole(artifact.role)) {
    return artifact.role;
  }
  return ARTIFACT_KIND_ROLE_REGISTRY[artifact.kind as ToolArtifactKind] ?? 'deliverable';
}

/** 单一判据：只有 deliverable 才进产物列表。聊天流与概览两条通路都调它，不许各判各的。 */
export function isDeliverableArtifact(artifact: { kind: string; role?: string }): boolean {
  return resolveArtifactRole(artifact) === 'deliverable';
}
