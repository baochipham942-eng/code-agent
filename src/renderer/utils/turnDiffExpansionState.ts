// ============================================================================
// turnDiffExpansionState - TurnDiffSummary 文件行展开态的组件外存放（X5.5-B2）
//
// 根因：消息流是 Virtuoso 虚拟列表，执行中 followOutput 自动滚动会把离开视口的
// TurnCard 整个卸载，滚回来再重挂载；展开态原本是组件内 useState，重挂载即重置
// 为全收起——用户手动展开的文件在执行中反复「自己合上」。
//
// 稳定规则（工单拍板）：
// - 执行中默认收起、不自动弹开；终态后一次性定型（外部状态只被用户手势改写）。
// - 用户手动展开/收起的状态活过重挂载：按 sessionId:turnId 键控存到模块级 Map，
//   组件每次挂载用它做 useState 初值，toggle 时写回。
// - 不进持久化：刷新/重启后回到默认收起；Map 设上限 FIFO 逐出，防长会话内存涨。
// ============================================================================

const MAX_TURN_ENTRIES = 100;

// Map 迭代序即插入序：每次写入 delete+set 把 key 挪到最新，超帽从最老开始逐出。
const expansionByTurn = new Map<string, Set<string>>();

export function readTurnDiffExpansion(key: string): Set<string> {
  return new Set(expansionByTurn.get(key) ?? []);
}

export function writeTurnDiffExpansion(key: string, expanded: Set<string>): void {
  expansionByTurn.delete(key);
  expansionByTurn.set(key, new Set(expanded));
  while (expansionByTurn.size > MAX_TURN_ENTRIES) {
    const oldest = expansionByTurn.keys().next().value;
    if (oldest === undefined) break;
    expansionByTurn.delete(oldest);
  }
}

/** 测试专用：模块级状态跨用例隔离 */
export function clearTurnDiffExpansionForTests(): void {
  expansionByTurn.clear();
}
