// ============================================================================
// document/ batch — 1 工具
// ============================================================================

import { DocEditTool } from '../../document/docEditTool';
import { wrapLegacyTool } from '../_helpers/legacyAdapter';

export const docEditModule = wrapLegacyTool(DocEditTool, {
  category: 'document',
  permissionLevel: 'write',
});
