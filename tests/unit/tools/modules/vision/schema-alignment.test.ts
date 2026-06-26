// ============================================================================
// Vision Level 1 schema alignment with legacy
// 一次性自检：确认 7 个 schema.ts 的 name/description/inputSchema 与 legacy
// 逐字对齐（非临时性脚本，永久驻留作为 regression guard）。
// ============================================================================

import { describe, it, expect } from 'vitest';

import { browserSchema } from '../../../../../src/host/plugins/builtin/browserControl/browser.schema';
import { computerSchema } from '../../../../../src/host/plugins/builtin/computerUse/computer.schema';
import { browserActionSchema } from '../../../../../src/host/plugins/builtin/browserControl/browserAction.schema';
import { browserNavigateSchema } from '../../../../../src/host/plugins/builtin/browserControl/browserNavigate.schema';
import { computerUseSchema } from '../../../../../src/host/plugins/builtin/computerUse/computerUse.schema';
import { screenshotSchema } from '../../../../../src/host/plugins/builtin/computerUse/screenshot.schema';
import { guiAgentSchema } from '../../../../../src/host/plugins/builtin/computerUse/guiAgent.schema';

import { BrowserTool } from '../../../../../src/host/tools/vision/BrowserTool';
import { ComputerTool } from '../../../../../src/host/tools/vision/ComputerTool';
import { browserActionTool } from '../../../../../src/host/tools/vision/browserAction';
import { browserNavigateTool } from '../../../../../src/host/tools/vision/browserNavigate';
import { computerUseTool } from '../../../../../src/host/tools/vision/computerUse';
import { screenshotTool } from '../../../../../src/host/tools/vision/screenshot';
import { guiAgentTool } from '../../../../../src/host/tools/vision/guiAgent';

const pairs = [
  ['Browser', browserSchema, BrowserTool] as const,
  ['Computer', computerSchema, ComputerTool] as const,
  ['browser_action', browserActionSchema, browserActionTool] as const,
  ['browser_navigate', browserNavigateSchema, browserNavigateTool] as const,
  ['computer_use', computerUseSchema, computerUseTool] as const,
  ['screenshot', screenshotSchema, screenshotTool] as const,
  ['gui_agent', guiAgentSchema, guiAgentTool] as const,
];

describe('vision Level 1 schemas literally aligned with legacy', () => {
  for (const [label, schema, legacy] of pairs) {
    describe(label, () => {
      it('name matches', () => {
        expect(schema.name).toBe(legacy.name);
      });
      it('description matches verbatim', () => {
        expect(schema.description).toBe(legacy.description);
      });
      it('inputSchema deep-equal', () => {
        expect(schema.inputSchema).toEqual(legacy.inputSchema);
      });
    });
  }
});
