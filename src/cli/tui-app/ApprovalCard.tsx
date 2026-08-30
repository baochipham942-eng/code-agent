// ============================================================================
// 权限审批卡：占据 prompt 区域的 blocking card（键盘被它接管）
// 数据逻辑在 approval.ts；这里只渲染。
// P1：写入类变更摘要 + 可展开 inline diff（Tab）+ No 附反馈输入行。
// ============================================================================

import { Box, Text } from 'ink';
import type { PermissionRequestData } from '../../host/tools/types';
import { approvalOptions, approvalTarget, editDiffPreview, writeChangeSummary } from './approval';

export function ApprovalCard({ request, selected, feedback, diffExpanded }: {
  request: PermissionRequestData;
  selected: number;
  /** 非 null = No 附反馈输入模式（值为当前输入缓冲） */
  feedback: string | null;
  /** inline diff 是否展开（edit 类审批，Tab 切换） */
  diffExpanded: boolean;
}) {
  const options = approvalOptions(request);
  const danger = request.dangerLevel === 'danger' || request.type === 'dangerous_command';
  const summary = writeChangeSummary(request);
  const canDiff = editDiffPreview(request) !== null;
  const diff = diffExpanded ? editDiffPreview(request) : null;
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
      {summary ? (
        <Text dimColor>
          {summary}
          {canDiff ? (diffExpanded ? ' · Tab 收起 diff' : ' · Tab 展开 diff') : ''}
        </Text>
      ) : null}
      {diff ? (
        <Box flexDirection="column" paddingLeft={2}>
          {diff.removedLines.map((line, i) => (
            <Text key={`r${i}`} color="red" wrap="truncate-end">- {line}</Text>
          ))}
          {diff.addedLines.map((line, i) => (
            <Text key={`a${i}`} color="green" wrap="truncate-end">+ {line}</Text>
          ))}
          {diff.truncated ? (
            <Text dimColor>… (+{diff.addedTotal - diff.addedLines.length} -{diff.removedTotal - diff.removedLines.length} more)</Text>
          ) : null}
        </Box>
      ) : null}
      {feedback !== null ? (
        <Text>
          <Text color="yellow">附反馈拒绝: </Text>
          <Text>{feedback}</Text>
          <Text dimColor>▏（Enter 提交 · Esc 返回）</Text>
        </Text>
      ) : (
        options.map((option, i) => (
          <Text key={option.choice} inverse={i === selected} dimColor={i !== selected}>
            {`  ${i + 1}. ${option.label}`}
          </Text>
        ))
      )}
    </Box>
  );
}
