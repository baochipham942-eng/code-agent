// ============================================================================

import { HostReasonCode } from '@shared/contract';

export const hostReasonZh = {
  [HostReasonCode.PermissionClassifierAllowed]: { summary: '安全检查已通过' },
  [HostReasonCode.PermissionClassifierConfirmationRequired]: { summary: '{toolName}需要你的确认' },
  [HostReasonCode.PermissionClassifierDenied]: { summary: '{toolName}未通过安全检查' },
  [HostReasonCode.PermissionHighRiskActionBlocked]: { summary: '高风险的浏览器或电脑操作已被拦截' },
  [HostReasonCode.PermissionUnregisteredActionBlocked]: { summary: '这个浏览器或电脑操作尚未登记，已按安全规则拦截' },
  [HostReasonCode.PermissionPolicyConfirmationRequired]: { summary: '{toolName}按当前权限策略需要确认' },
  [HostReasonCode.PermissionSkillBoundaryConfirmationRequired]: { summary: '{toolName}超出当前 skill 的操作范围，需要确认' },
  [HostReasonCode.PermissionFileOutsideWorkspaceConfirmationRequired]: { summary: '写入 {path} 需要你的确认' },
  [HostReasonCode.PermissionReadOnlyConfirmationRequired]: { summary: '只读探索模式下，{toolName}需要确认' },
  [HostReasonCode.PermissionCommandAnalysisFailed]: { summary: '这条命令无法可靠检查，已按安全规则拦截' },
  [HostReasonCode.PermissionClassifierFailed]: { summary: '安全检查暂时不可用，这次操作需要人工确认' },
  [HostReasonCode.PermissionDeniedByUser]: { summary: '你拒绝了{toolName}' },
  [HostReasonCode.PermissionDeniedNoApprovalUi]: { summary: '当前运行环境无法显示审批，{toolName}已按安全规则拒绝' },
  [HostReasonCode.PermissionDeniedTimeout]: { summary: '等待{toolName}审批超时，已按安全规则拒绝' },
  [HostReasonCode.PermissionDeniedCancelled]: { summary: '本次运行已取消，{toolName}没有执行' },
  [HostReasonCode.PermissionDeniedFailClosed]: { summary: '审批链路暂时不可用，{toolName}已按安全规则拒绝' },
  [HostReasonCode.PermissionDeniedScripted]: { summary: '评测策略拒绝了{toolName}' },
  [HostReasonCode.DecisionPolicy]: { summary: '权限策略完成检查' },
  [HostReasonCode.DecisionGuard]: { summary: '运行安全规则完成检查' },
  [HostReasonCode.DecisionClassifier]: { summary: '工具安全分类完成检查' },
  [HostReasonCode.DecisionApproval]: { summary: '审批步骤已完成' },
  [HostReasonCode.DecisionHook]: { summary: '扩展规则完成检查' },
  [HostReasonCode.RoutingMatched]: { summary: '已路由到 {agentName}' },
  [HostReasonCode.RoutingNoMatchFallback]: { summary: '没有匹配到专用 agent，已继续默认执行' },
  [HostReasonCode.RoutingRequestedUnavailable]: { summary: '指定的 {requestedAgentName} 不可用，已由 {agentName} 继续执行' },
  [HostReasonCode.RoutingExternalEngineUnsupported]: { summary: '{engineName} 会话不支持 agent 选择，已直接执行' },
} satisfies Record<HostReasonCode, { summary: string; detail?: string }>;

export const hostReasonEn: typeof hostReasonZh = {
  [HostReasonCode.PermissionClassifierAllowed]: { summary: 'Safety check passed' },
  [HostReasonCode.PermissionClassifierConfirmationRequired]: { summary: '{toolName} needs your confirmation' },
  [HostReasonCode.PermissionClassifierDenied]: { summary: '{toolName} did not pass the safety check' },
  [HostReasonCode.PermissionHighRiskActionBlocked]: { summary: 'A high-risk browser or computer action was blocked' },
  [HostReasonCode.PermissionUnregisteredActionBlocked]: { summary: 'This browser or computer action is not registered and was blocked by the safety policy' },
  [HostReasonCode.PermissionPolicyConfirmationRequired]: { summary: '{toolName} requires confirmation under the current permission policy' },
  [HostReasonCode.PermissionSkillBoundaryConfirmationRequired]: { summary: '{toolName} is outside the current skill scope and needs confirmation' },
  [HostReasonCode.PermissionFileOutsideWorkspaceConfirmationRequired]: { summary: 'Writing {path} needs your confirmation' },
  [HostReasonCode.PermissionReadOnlyConfirmationRequired]: { summary: '{toolName} needs confirmation in read-only exploration mode' },
  [HostReasonCode.PermissionCommandAnalysisFailed]: { summary: 'This command could not be checked reliably and was blocked by the safety policy' },
  [HostReasonCode.PermissionClassifierFailed]: { summary: 'The safety check is temporarily unavailable, so this action needs manual confirmation' },
  [HostReasonCode.PermissionDeniedByUser]: { summary: 'You declined {toolName}' },
  [HostReasonCode.PermissionDeniedNoApprovalUi]: { summary: 'This environment cannot show approvals, so {toolName} was denied by the safety policy' },
  [HostReasonCode.PermissionDeniedTimeout]: { summary: 'Approval for {toolName} timed out and was denied by the safety policy' },
  [HostReasonCode.PermissionDeniedCancelled]: { summary: 'This run was cancelled, so {toolName} did not run' },
  [HostReasonCode.PermissionDeniedFailClosed]: { summary: 'The approval path is unavailable, so {toolName} was denied by the safety policy' },
  [HostReasonCode.PermissionDeniedScripted]: { summary: 'The evaluation policy denied {toolName}' },
  [HostReasonCode.DecisionPolicy]: { summary: 'Permission policy check completed' },
  [HostReasonCode.DecisionGuard]: { summary: 'Runtime safety check completed' },
  [HostReasonCode.DecisionClassifier]: { summary: 'Tool safety classification completed' },
  [HostReasonCode.DecisionApproval]: { summary: 'Approval step completed' },
  [HostReasonCode.DecisionHook]: { summary: 'Extension rule check completed' },
  [HostReasonCode.RoutingMatched]: { summary: 'Routed to {agentName}' },
  [HostReasonCode.RoutingNoMatchFallback]: { summary: 'No specialized agent matched; continuing with the default agent' },
  [HostReasonCode.RoutingRequestedUnavailable]: { summary: '{requestedAgentName} is unavailable; {agentName} is continuing instead' },
  [HostReasonCode.RoutingExternalEngineUnsupported]: { summary: '{engineName} sessions do not support agent selection; continuing directly' },
};
// agentError 域词条（AgentErrorCard 会话区错误卡片）—— zh/en 同文件相邻维护。
// 卡片文案按 category 表驱动：title 一句话说发生了什么，suggestion 给建议动作，
// 具体动作做成按钮（重试/切换模型/新开会话/复制错误报告）。
// ============================================================================

export const agentErrorZh = {
  agentError: {
    ariaLabel: '运行失败',
    rateLimitedInline: '模型服务商限流，稍后重试',
    hostReasons: hostReasonZh,
    categories: {
      auth: {
        // 401 只能证明「没通过授权」，区分不出是密钥不对还是额度耗尽（Codex 验证 2026-08-01）。
        // 把两个互斥原因并列写成确定结论，用户会照着错的那个去排查。
        title: '这个模型暂时用不了：账号没通过授权',
        suggestion: '可能是密钥填错、过期，或这个账号已经没有额度了。换一个模型继续，或去设置里检查这个模型的账号配置。重试无效。',
      },
      insufficient_balance: {
        title: '这个账号余额不足',
        suggestion: '去供应商后台充值后即可继续',
      },
      model_not_found: {
        title: '模型接口或模型名称不匹配',
        suggestion: '当前模型供应商返回 404/Not Found。请检查自定义模型的 Base URL、路径是否包含 /v1、模型 ID 是否正确；也可以先切换到其他模型后重试。',
      },
      forbidden: {
        title: '模型服务拒绝了这次请求',
        suggestion: '当前模型供应商返回 403/Forbidden。请检查 API Key 是否有效、账号是否有该模型权限、额度是否可用；也可以先切换到其他模型后重试。',
      },
      rate_limited: {
        title: '模型服务暂时限流',
        suggestion: '当前模型供应商返回限流。请稍后重试，或先切换到其他可用模型。',
      },
      concurrency: {
        title: '模型账号并发已满',
        suggestion: '当前模型服务返回并发限制。请稍后重试，或先切换到其他可用模型。',
      },
      network: {
        title: '暂时连不上模型服务',
        suggestion: '当前模型请求没有成功到达供应商。请检查网络、代理或自定义模型 Base URL，稍后再重试。',
      },
      context_length: {
        title: '对话长度超出模型上下文限制',
        suggestion: '当前对话长度约 {requestedK}K tokens，超出模型限制 {maxK}K tokens。建议新开一个会话继续对话。',
      },
      image_payload: {
        title: '图片太多或文件太大，模型无法接收',
        suggestion: '请新开会话，只带这次需要的图片；图片较多时分批发送，单张过大时先压缩后再发。',
      },
      generic: {
        title: '运行失败',
        suggestion: '请重试一次；若反复失败，可新开会话继续，或复制错误报告反馈。',
      },
    },
    details: {
      model: '实际使用',
      provider: '服务商',
      code: '错误码',
      httpStatus: 'HTTP',
      traceId: 'Trace ID',
      technical: '查看技术详情',
    },
    actions: {
      retry: '重试',
      retryRunning: '会话运行中，稍后再试',
      switchModel: '切换模型',
      checkAccount: '检查账号设置',
      newSession: '新开会话',
      copyReport: '复制错误报告',
      copied: '错误报告已复制',
      copyFailed: '复制失败，请手动复制',
    },
    report: {
      title: 'Neo 错误报告',
      message: '错误',
      suggestion: '建议',
      category: '分类',
      code: '错误码',
      httpStatus: 'HTTP 状态',
      traceId: 'Trace ID',
      sessionId: '会话 ID',
      model: '模型',
      timestamp: '时间',
      raw: '原始信息',
    },
  },
};

export const agentErrorEn: typeof agentErrorZh = {
  agentError: {
    ariaLabel: 'Run failed',
    rateLimitedInline: 'Model provider rate limit reached. Retry in a moment',
    hostReasons: hostReasonEn,
    categories: {
      auth: {
        title: 'This model is unavailable: the account was not authorized',
        suggestion: 'The key may be wrong or expired, or the account may be out of quota. Switch to another model, or check this model account in Settings. Retrying will not help.',
      },
      insufficient_balance: {
        title: 'This account has insufficient balance',
        suggestion: 'Top up the account in the provider console to continue.',
      },
      model_not_found: {
        title: 'Model endpoint or model name mismatch',
        suggestion: 'The model provider returned 404/Not Found. Check the custom model Base URL, whether the path includes /v1, and whether the model ID is correct — or switch to another model and retry.',
      },
      forbidden: {
        title: 'The model service rejected this request',
        suggestion: 'The model provider returned 403/Forbidden. Check that the API Key is valid, the account has access to this model, and quota is available — or switch to another model and retry.',
      },
      rate_limited: {
        title: 'Model service is rate limited',
        suggestion: 'The model provider is throttling requests. Retry in a moment, or switch to another available model.',
      },
      concurrency: {
        title: 'Model account concurrency is full',
        suggestion: 'The model service hit its concurrency limit. Retry later, or switch to another available model first.',
      },
      network: {
        title: 'Cannot reach the model service',
        suggestion: 'The request never reached the provider. Check your network, proxy, or custom model Base URL, then retry.',
      },
      context_length: {
        title: 'Conversation exceeds the model context limit',
        suggestion: 'This conversation is about {requestedK}K tokens, over the model limit of {maxK}K tokens. Start a new session to continue.',
      },
      image_payload: {
        title: 'There are too many images or the image files are too large',
        suggestion: 'Start a new session with only the images needed for this request. Send large sets in smaller batches, and compress oversized images before sending them.',
      },
      generic: {
        title: 'Run failed',
        suggestion: 'Try again. If it keeps failing, start a new session, or copy the error report and send it to us.',
      },
    },
    details: {
      model: 'Ran on',
      provider: 'Provider',
      code: 'Code',
      httpStatus: 'HTTP',
      traceId: 'Trace ID',
      technical: 'Technical details',
    },
    actions: {
      retry: 'Retry',
      retryRunning: 'Session is running, try again later',
      switchModel: 'Switch model',
      checkAccount: 'Check account settings',
      newSession: 'New session',
      copyReport: 'Copy error report',
      copied: 'Error report copied',
      copyFailed: 'Copy failed — please copy manually',
    },
    report: {
      title: 'Neo Error Report',
      message: 'Error',
      suggestion: 'Suggestion',
      category: 'Category',
      code: 'Error code',
      httpStatus: 'HTTP status',
      traceId: 'Trace ID',
      sessionId: 'Session ID',
      model: 'Model',
      timestamp: 'Timestamp',
      raw: 'Raw message',
    },
  },
};
