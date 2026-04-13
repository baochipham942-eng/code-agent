// ============================================================================
// vision/ batch — 7 工具的 wrapper 模式实现
//
// 全部走 wrapper：每个 V2 module 委托给 legacy Tool。复用通用 wrapLegacyTool
// factory（_helpers/legacyAdapter.ts）。
// ============================================================================

import { browserActionTool } from '../../vision/browserAction';
import { browserNavigateTool } from '../../vision/browserNavigate';
import { BrowserTool } from '../../vision/BrowserTool';
import { ComputerTool } from '../../vision/ComputerTool';
import { computerUseTool } from '../../vision/computerUse';
import { guiAgentTool } from '../../vision/guiAgent';
import { screenshotTool } from '../../vision/screenshot';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

const VISION_EXECUTE = { category: 'vision' as const, permissionLevel: 'execute' as const };
const VISION_READ = {
  category: 'vision' as const,
  permissionLevel: 'read' as const,
  readOnly: true,
  allowInPlanMode: true,
};

export const browserModule = wrapLegacyTool(BrowserTool, VISION_EXECUTE);
export const computerModule = wrapLegacyTool(ComputerTool, VISION_EXECUTE);
export const browserActionModule = wrapLegacyTool(browserActionTool, VISION_EXECUTE);
export const browserNavigateModule = wrapLegacyTool(browserNavigateTool, VISION_EXECUTE);
export const computerUseModule = wrapLegacyTool(computerUseTool, VISION_EXECUTE);
export const screenshotModule = wrapLegacyTool(screenshotTool, VISION_READ);
export const guiAgentModule = wrapLegacyTool(guiAgentTool, VISION_EXECUTE);
