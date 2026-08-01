// ============================================================================
// agentError 域词条（AgentErrorCard 会话区错误卡片）—— zh/en 同文件相邻维护。
// 卡片文案按 category 表驱动：title 一句话说发生了什么，suggestion 给建议动作，
// 具体动作做成按钮（重试/切换模型/新开会话/复制错误报告）。
// ============================================================================

export const agentErrorZh = {
  agentError: {
    ariaLabel: '运行失败',
    categories: {
      auth: {
        title: '这个模型用不了：密钥无效或额度已用尽',
        suggestion: '换一个模型继续，或去能力中心检查该供应商的 API Key 与余额。重试无效。',
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
      generic: {
        title: '运行失败',
        suggestion: '请重试一次；若反复失败，可新开会话继续，或复制错误报告反馈。',
      },
    },
    details: {
      model: '实际使用',
      code: '错误码',
      httpStatus: 'HTTP',
      traceId: 'Trace ID',
    },
    actions: {
      retry: '重试',
      retryRunning: '会话运行中，稍后再试',
      switchModel: '切换模型',
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
    categories: {
      auth: {
        title: 'This model is unavailable: invalid key or quota exhausted',
        suggestion: 'Switch to another model, or check the provider API key and balance. Retrying will not help.',
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
      generic: {
        title: 'Run failed',
        suggestion: 'Try again. If it keeps failing, start a new session, or copy the error report and send it to us.',
      },
    },
    details: {
      model: 'Ran on',
      code: 'Code',
      httpStatus: 'HTTP',
      traceId: 'Trace ID',
    },
    actions: {
      retry: 'Retry',
      retryRunning: 'Session is running, try again later',
      switchModel: 'Switch model',
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
