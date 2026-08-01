// ============================================================================
// 退出前关闭所有指向主库的 SQLite 连接
// ----------------------------------------------------------------------------
// SQLite 只在**最后一个**连接调用 sqlite3_close 时才 checkpoint 并删掉
// -wal / -shm。少关一个连接，这两个文件就会留在数据目录里 —— 下次启动如果
// 恰好赶上一次大写入（如全库 VACUUM），陈旧 -shm 会被越界映射，直接 SIGBUS
// 崩掉 webServer（2026-07-31 生产事故）。
//
// 所以这里必须列全「持有主库连接的服务」，不是只关 databaseService：
//   - databaseService  —— 主连接
//   - folderTrustService —— 独立 new Database(getUserConfigDir()/code-agent.db)
//
// ⚠️ 新增任何自己 `new Database()` 打开主库的服务时，必须同时在这里登记，
// 否则 -wal/-shm 会重新开始残留，而且这个失败是**静默的**（要到下次启动
// 撞上大写入才炸）。判据：正常退出后数据目录里不该剩 code-agent.db-wal /
// code-agent.db-shm，剩了就是有连接没关。
// ============================================================================

/** 关闭所有主库连接。best-effort：单个失败不阻断其余，也不阻断退出。 */
export async function closeAllDatabaseConnections(): Promise<void> {
  try {
    const { getDatabase } = await import('../host/services/core/databaseService');
    getDatabase().close();
  } catch (error) {
    console.warn('[shutdown] databaseService close failed:', error);
  }
  try {
    const { closeFolderTrustService } = await import('../host/security/folderTrustService');
    closeFolderTrustService();
  } catch (error) {
    console.warn('[shutdown] folderTrustService close failed:', error);
  }
}
