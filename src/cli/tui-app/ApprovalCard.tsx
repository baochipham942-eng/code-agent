// ============================================================================
// 权限审批卡：占据 prompt 区域的 blocking card（键盘被它接管）
// 数据逻辑在 approval.ts；这里只渲染。
// ============================================================================

import { Box, Text } from 'ink';
import type { PermissionRequestData } from '../../host/tools/types';
import { approvalOptions, approvalTarget } from './approval';

export function ApprovalCard({ request, selected }: {
  request: PermissionRequestData;
  selected: number;
}) {
  const options = approvalOptions(request);
  const danger = request.dangerLevel === 'danger' || request.type === 'dangerous_command';
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={danger ? 'red' : 'yellow'}>
        {danger ? '⚠ 危险操作需要许可' : '⚠ 需要许可'}
      </Text>
      <Text>
        <Text bold>{request.tool}</Text>
        <Text dimColor>  {approvalTarget(request)}</Text>
      </Text>
      {request.reason ? <Text dimColor wrap="truncate-end">{request.reason}</Text> : null}
      {options.map((option, i) => (
        <Text key={option.choice} inverse={i === selected} dimColor={i !== selected}>
          {`  ${i + 1}. ${option.label}`}
        </Text>
      ))}
    </Box>
  );
}
