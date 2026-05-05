// ============================================================================
// Vision Level 1 schema alignment with legacy
// 一次性自检：确认 7 个 schema.ts 的 name/description/inputSchema 与 legacy
// 逐字对齐（非临时性脚本，永久驻留作为 regression guard）。
// ============================================================================

import { describe, it, expect } from 'vitest';

import { browserSchema } from '../../../../../src/main/tools/modules/vision/browser.schema';
import { computerSchema } from '../../../../../src/main/tools/modules/vision/computer.schema';
import { browserActionSchema } from '../../../../../src/main/tools/modules/vision/browserAction.schema';
import { browserNavigateSchema } from '../../../../../src/main/tools/modules/vision/browserNavigate.schema';
import { computerUseSchema } from '../../../../../src/main/tools/modules/vision/computerUse.schema';
import { screenshotSchema } from '../../../../../src/main/tools/modules/vision/screenshot.schema';
import { guiAgentSchema } from '../../../../../src/main/tools/modules/vision/guiAgent.schema';

import { BrowserTool } from '../../../../../src/main/tools/vision/BrowserTool';
import { ComputerTool } from '../../../../../src/main/tools/vision/ComputerTool';
import { browserActionTool } from '../../../../../src/main/tools/vision/browserAction';
import { browserNavigateTool } from '../../../../../src/main/tools/vision/browserNavigate';
import { computerUseTool } from '../../../../../src/main/tools/vision/computerUse';
import { screenshotTool } from '../../../../../src/main/tools/vision/screenshot';
import { guiAgentTool } from '../../../../../src/main/tools/vision/guiAgent';

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
