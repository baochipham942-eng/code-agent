// ============================================================================
// vision/ batch — 7 工具的 wrapper 模式实现
//
// 全部走 wrapper：每个 V2 module 委托给 legacy Tool。vision 类工具大量依赖
// 浏览器 (playwright)、screencapture、GUI agent 等重资产，wrapper 速度最快。
//
// 单文件聚合 7 个 module，减少文件 IO：
// - Browser (facade for browserAction)
// - Computer (facade for computerUse)
// - browser_action (主浏览器交互)
// - browser_navigate (浏览器导航)
// - computer_use (主计算机控制)
// - screenshot (截图)
// - gui_agent (GUI agent 自动化)
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
  ToolCategory,
  PermissionLevel,
} from '../../../protocol/tools';
import type { Tool } from '../../types';
import { browserActionTool } from '../../vision/browserAction';
import { browserNavigateTool } from '../../vision/browserNavigate';
import { BrowserTool } from '../../vision/BrowserTool';
import { ComputerTool } from '../../vision/ComputerTool';
import { computerUseTool } from '../../vision/computerUse';
import { guiAgentTool } from '../../vision/guiAgent';
import { screenshotTool } from '../../vision/screenshot';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';

/**
 * 通用 wrapper 工厂：把 legacy Tool 包成 ToolModule
 * 复制 legacy 的 description / inputSchema，永远只做 4 参数签名 + canUseTool 闸门
 */
function wrapLegacyTool(
  legacyTool: Tool,
  category: ToolCategory,
  permissionLevel: PermissionLevel,
  opts: { readOnly?: boolean; allowInPlanMode?: boolean } = {},
): ToolModule {
  const schema: ToolSchema = {
    name: legacyTool.name,
    description: legacyTool.description,
    inputSchema: legacyTool.inputSchema,
    category,
    permissionLevel,
    readOnly: opts.readOnly ?? false,
    allowInPlanMode: opts.allowInPlanMode ?? false,
  };

  class Handler implements ToolHandler<Record<string, unknown>, string> {
    readonly schema = schema;

    async execute(
      args: Record<string, unknown>,
      ctx: ToolContext,
      canUseTool: CanUseToolFn,
      onProgress?: ToolProgressFn,
    ): Promise<ToolResult<string>> {
      const permit = await canUseTool(schema.name, args);
      if (!permit.allow) {
        return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
      }
      if (ctx.abortSignal.aborted) {
        return { ok: false, error: 'aborted', code: 'ABORTED' };
      }

      onProgress?.({ stage: 'starting', detail: legacyTool.name });
      const legacyResult = await legacyTool.execute(args, buildLegacyCtxFromProtocol(ctx));
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info(`${legacyTool.name} done`, { ok: legacyResult.success });
      return adaptLegacyResult(legacyResult);
    }
  }

  return {
    schema,
    createHandler() {
      return new Handler();
    },
  };
}

// ----------------------------------------------------------------------------
// 7 个 wrapper module 导出
// ----------------------------------------------------------------------------

export const browserModule = wrapLegacyTool(BrowserTool, 'vision', 'execute', {
  readOnly: false,
  allowInPlanMode: false,
});

export const computerModule = wrapLegacyTool(ComputerTool, 'vision', 'execute', {
  readOnly: false,
  allowInPlanMode: false,
});

export const browserActionModule = wrapLegacyTool(browserActionTool, 'vision', 'execute', {
  readOnly: false,
  allowInPlanMode: false,
});

export const browserNavigateModule = wrapLegacyTool(browserNavigateTool, 'vision', 'execute', {
  readOnly: false,
  allowInPlanMode: false,
});

export const computerUseModule = wrapLegacyTool(computerUseTool, 'vision', 'execute', {
  readOnly: false,
  allowInPlanMode: false,
});

export const screenshotModule = wrapLegacyTool(screenshotTool, 'vision', 'read', {
  readOnly: true,
  allowInPlanMode: true,
});

export const guiAgentModule = wrapLegacyTool(guiAgentTool, 'vision', 'execute', {
  readOnly: false,
  allowInPlanMode: false,
});
