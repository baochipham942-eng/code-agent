// ============================================================================
// ConnectorWriteDisclosure - 连接器令牌写调用的请求披露（N-HTTPREQ-CONNECTOR-CARD-DISCLOSE）
// ----------------------------------------------------------------------------
// http_request 携带已连接 OAuth 连接器令牌发起写调用时，问句已点名「以你的{connector}
// 身份写入」；本组件补上具体写了什么：一行 METHOD /path（只显路径，不带 query），
// 加一个可展开的「请求内容」摘要（凭据脱敏，~500 字截断）。与 BoundaryDisclosure
// （隐私边界说明）一起挂在 RequestDetails 的 URL 行旁。
// ============================================================================

import React, { useState } from 'react';
import { Button } from '../primitives/Button';
import { redactCredentialText } from '@shared/security/secretPatterns';
import { useI18n } from '../../hooks/useI18n';

/** 请求内容摘要上限：审批卡不是 body 查看器，超长截断提示「还有更多」。 */
const BODY_SUMMARY_MAX_CHARS = 500;

interface ConnectorWriteDisclosureProps {
  method?: string;
  url?: string;
  body?: string;
}

export function ConnectorWriteDisclosure({ method, url, body }: ConnectorWriteDisclosureProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  // 只显路径不带 query：query 里常见 token/receive_id 之类的敏感参数，URL 详情行另有脱敏展示。
  let path = url;
  if (url) {
    try {
      path = new URL(url).pathname;
    } catch {
      path = redactCredentialText(url);
    }
  }

  const redactedBody = body ? redactCredentialText(body) : '';
  const bodySummary = redactedBody.length > BODY_SUMMARY_MAX_CHARS
    ? `${redactedBody.slice(0, BODY_SUMMARY_MAX_CHARS)}…`
    : redactedBody;

  // 非 http_request 的连接器写回（MCP 工具名判据）同挂该边界，但参数里没有 method/body
  // 可披露——没有内容就不出空壳。
  if (!method && !body) return null;

  return (
    <div className="space-y-2" data-testid="connector-write-disclosure">
      {method && path && (
        <div
          className="p-2 rounded font-mono text-xs break-all bg-zinc-800 border border-zinc-700/60"
          data-testid="connector-write-method-path"
        >
          <span className="font-semibold text-badge-warning">{method.toUpperCase()}</span>
          {' '}
          <span className="text-badge-info">{path}</span>
        </div>
      )}
      {body && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {t.decisionCard.permission.connectorWriteContent}
          </Button>
          {expanded && (
            <pre
              className="mt-1.5 text-xs p-2 rounded bg-zinc-700 border border-zinc-700 text-zinc-400 overflow-x-auto max-h-32 whitespace-pre-wrap break-all"
              data-testid="connector-write-body"
            >
              {bodySummary}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
