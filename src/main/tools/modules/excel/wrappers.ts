// ============================================================================
// excel/ batch — 1 工具
// ============================================================================

import { ExcelAutomateTool } from '../../excel/excelAutomate';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

export const excelAutomateModule = wrapLegacyTool(ExcelAutomateTool, {
  category: 'excel',
  permissionLevel: 'write',
});
