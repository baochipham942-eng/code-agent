// ============================================================================
// CLI: openchronicle on/off/status — 屏幕记忆开关（外部 OpenChronicle daemon）
// ============================================================================

import { Command } from 'commander';
import {
  setEnabled,
  getStatus,
  loadSettings,
} from '../../main/services/external/openchronicleSupervisor';

export const openchronicleCommand = new Command('openchronicle')
  .description('屏幕记忆（OpenChronicle daemon）开关')
  .addCommand(
    new Command('on')
      .description('启用屏幕记忆 — 启动 OpenChronicle daemon 并注册 MCP server')
      .action(async () => {
        const result = await setEnabled(true);
        if (result.ok) {
          console.log('✅ 屏幕记忆已开启');
        } else {
          console.error('❌ 启动失败:', result.error);
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('off')
      .description('关闭屏幕记忆 — 注销 MCP server 并停止 OpenChronicle daemon')
      .action(async () => {
        const result = await setEnabled(false);
        if (result.ok) {
          console.log('✅ 屏幕记忆已关闭');
        } else {
          console.error('❌ 关闭失败:', result.error);
          process.exit(1);
        }
      }),
  )
  .addCommand(
    new Command('status')
      .description('查看屏幕记忆状态')
      .action(async () => {
        const settings = await loadSettings();
        const status = await getStatus();
        console.log(`Toggle:        ${settings.enabled ? 'ON' : 'OFF'}`);
        console.log(`Daemon state:  ${status.state}`);
        if (status.pid) console.log(`PID:           ${status.pid}`);
        console.log(`MCP healthy:   ${status.mcpHealthy ? 'yes' : 'no'}`);
        if (status.bufferFiles !== undefined) console.log(`Buffer files:  ${status.bufferFiles}`);
        if (status.memoryEntries !== undefined) console.log(`Memory:        ${status.memoryEntries} entries`);
        if (status.lastError) console.log(`Last error:    ${status.lastError}`);
      }),
  );
