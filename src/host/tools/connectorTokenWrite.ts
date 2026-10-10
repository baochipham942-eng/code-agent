// ============================================================================
// http_request 连接器令牌写确认（N-HTTPREQ-CONNECTOR-TOKEN-CONFIRM）
// ----------------------------------------------------------------------------
// http_request 向已连接 OAuth 连接器的主机发起 POST/PUT/PATCH/DELETE 时，工具会
// 注入该连接器的 Authorization 头（providerRegistry.getOAuthAuthorizationHeader）——
// 这是以用户已连接应用身份进行的对外写副作用，必须逐次强确认（ask + trustBoundary
// → forceConfirm），classifier/LLM approve、autoApprove 档位、skill 预授权与权限
// 记忆都不得顺带放行。判定与注入共用 findConnectedOAuthProviderForHost，两边永不打架。
//
// 本模块同时收拢既有 C1 规则（工具名判连接器写回）的确定性 ask 构造与审批卡
// default 分支的连接器请求构造——permissionClassifier.ts / toolExecutor.ts 都已超
// max-lines=1000，只允许净行数下降，逻辑整块下放到这里。
// ============================================================================

import type { ClassificationResult } from './permissionClassifier';
import { createTraceStep } from '../security/decisionTraceBuilder';
import { findConnectedOAuthProviderForHost } from '../connectors/oauth/providerRegistry';
import {
  connectorExternalWriteReason,
  findConnectorToolMetadata,
  isConnectorToolName,
} from '../../shared/contract/workbenchTools';
import { permissionRequestTypeForLevel } from './permissionRequestType';
import type { PermissionRequestData } from './types';

const CONNECTOR_TOKEN_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** http_request 写调用命中已连接 OAuth 连接器时的身份信息（审批卡透传用）。 */
export interface ConnectorTokenWriteMatch {
  connectorId: string;
  connectorName: string;
  connectorNameEn: string;
}

/**
 * 判定一次工具调用是否会以「携带已连接 OAuth 连接器令牌」的方式发起写请求。
 * 纯函数：非 http_request、action=guide（只读回指南，不注入令牌）、非写方法、
 * URL 不合法、主机未连接时返回 undefined，任何输入都不抛。
 */
export function findConnectorTokenWrite(
  toolName: string,
  args: Record<string, unknown>,
): ConnectorTokenWriteMatch | undefined {
  if (toolName !== 'http_request') return undefined;
  if (args.action !== undefined && args.action !== 'request') return undefined;
  const method = (typeof args.method === 'string' ? args.method : 'GET').toUpperCase();
  if (!CONNECTOR_TOKEN_WRITE_METHODS.has(method)) return undefined;
  if (typeof args.url !== 'string' || args.url.length === 0) return undefined;
  let hostname: string;
  try {
    hostname = new URL(args.url).hostname;
  } catch {
    return undefined;
  }
  const provider = findConnectedOAuthProviderForHost(hostname);
  if (!provider) return undefined;
  return {
    connectorId: provider.id,
    connectorName: provider.displayName,
    // OAuth ProviderDescriptor 只有单一 displayName（zh），英文侧复用同一名称。
    connectorNameEn: provider.displayName,
  };
}

/** 审批卡文案：点名连接器，并说明用户授权会附在本次请求上（zh/en 成对）。 */
function connectorTokenWriteReason(
  match: ConnectorTokenWriteMatch,
  language: 'zh' | 'en' = 'zh',
): string {
  return language === 'en'
    ? `A write request to ${match.connectorNameEn} will attach your authorization to this request; confirmation required`
    : `要向 ${match.connectorName} 发起写入请求，你的授权将附加到本次请求上，需要你确认`;
}

/**
 * C1/C1b：连接器写回（工具名判据 + schema 写权限）与 http_request 令牌写的确定性
 * ask 构造。供 classifyByRules 在一切 approve 规则与 LLM 档之前调用。
 */
export function connectorWriteAskClassification(
  toolName: string,
  args: Record<string, unknown>,
  permissionLevel: string | undefined,
  startTime: number,
): ClassificationResult | undefined {
  // C1: 连接器写回会在外部系统产生真实副作用，必须确定性逐次确认。
  // 工具归属来自连接器描述符，写权限来自工具 schema 传入的 context，避免按名字猜动作。
  if (permissionLevel === 'write' && isConnectorToolName(toolName)) {
    const reason = connectorExternalWriteReason(toolName);
    if (reason) {
      return {
        decision: 'ask',
        reason,
        confidence: 1.0,
        cached: false,
        traceStep: createTraceStep(
          'permission_classifier',
          'C1: connector_external_write',
          'ask',
          reason,
          startTime,
        ),
        trustBoundary: true,
      };
    }
  }
  // C1b: http_request 写方法 + 已连接 OAuth 连接器主机 = 注入用户令牌的对外写。
  const tokenMatch = findConnectorTokenWrite(toolName, args);
  if (tokenMatch) {
    const reason = connectorTokenWriteReason(tokenMatch);
    return {
      decision: 'ask',
      reason,
      confidence: 1.0,
      cached: false,
      traceStep: createTraceStep(
        'permission_classifier',
        'C1b: connector_token_write',
        'ask',
        reason,
        startTime,
      ),
      trustBoundary: true,
    };
  }
  return undefined;
}

/**
 * 审批卡 default 分支的连接器请求构造：既有连接器写回（工具名判据）与新增
 * http_request 令牌写共用 connector.external_write 边界；后者额外带结构化
 * details.connectorTokenAttached，便于测试与 UI 区分「本次会附带授权」。
 */
export function connectorWritePermissionRequest(
  tool: { name: string; permissionLevel: string },
  params: Record<string, unknown>,
): PermissionRequestData | undefined {
  const connector = findConnectorToolMetadata(tool.name);
  const externalWriteReason = tool.permissionLevel === 'write'
    ? connectorExternalWriteReason(tool.name)
    : undefined;
  if (connector && externalWriteReason) {
    return {
      type: 'file_write',
      tool: tool.name,
      details: { ...params },
      reason: externalWriteReason,
      boundary: {
        id: 'connector.external_write',
        reason: externalWriteReason,
        reasonEn: connectorExternalWriteReason(tool.name, 'en'),
        connectorName: connector.connectorName,
        connectorNameEn: connector.connectorNameEn,
      },
    };
  }
  const tokenMatch = findConnectorTokenWrite(tool.name, params);
  if (!tokenMatch) return undefined;
  return {
    type: permissionRequestTypeForLevel(tool.permissionLevel),
    tool: tool.name,
    details: { ...params, connectorTokenAttached: true },
    reason: connectorTokenWriteReason(tokenMatch),
    boundary: {
      id: 'connector.external_write',
      reason: connectorTokenWriteReason(tokenMatch),
      reasonEn: connectorTokenWriteReason(tokenMatch, 'en'),
      connectorName: tokenMatch.connectorName,
      connectorNameEn: tokenMatch.connectorNameEn,
    },
  };
}
