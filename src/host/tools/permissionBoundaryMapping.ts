// ============================================================================
// PermissionRequestData.type → PermissionBoundaryId 映射
// （从 toolExecutor.ts 抽出的纯映射，债务门整块下放）
// ============================================================================

import type { PermissionBoundaryId } from '../../shared/contract/permissionBoundary';
import type { PermissionRequestData } from './types';

export function boundaryIdForRequestType(type: PermissionRequestData['type']): PermissionBoundaryId {
  switch (type) {
    case 'file_write':
    case 'file_edit':
      return 'file.project_write';
    case 'command':
    case 'dangerous_command':
      return 'command.shell';
    case 'network':
      return 'network.web_request';
    case 'file_read':
    default:
      return 'file.project_read';
  }
}
