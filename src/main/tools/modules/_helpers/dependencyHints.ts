export function formatToolDependencyHint(options: {
  tool: string;
  missing: string;
  why: string;
  acceptedConfig: string[];
  alternatives?: string[];
}): string {
  const lines = [
    `${options.tool} 现在还不能运行：缺少 ${options.missing}。`,
    options.why,
    '',
    '当前版本可识别的配置：',
    ...options.acceptedConfig.map((item) => `- ${item}`),
  ];
  if (options.alternatives && options.alternatives.length > 0) {
    lines.push('', '可选替代：', ...options.alternatives.map((item) => `- ${item}`));
  }
  return lines.join('\n');
}

export const TOOL_DEPENDENCY_HINTS = {
  readPdfOpenRouter: formatToolDependencyHint({
    tool: 'read_pdf',
    missing: '支持 PDF/文件输入的视觉模型配置',
    why: 'PDF 解析需要模型能直接读取 PDF 或文件输入；普通文本模型 key 不等于 PDF 解析能力。',
    acceptedConfig: [
      '当前 read_pdf 实现暂只识别 OpenRouter 路径：模型设置里的 OpenRouter key，或环境变量 OPENROUTER_API_KEY。',
      '如果已经配置了其他支持 PDF 的视觉模型，当前版本还不会自动复用，这是工具实现限制。',
    ],
  }),
  visualEditZhipu: formatToolDependencyHint({
    tool: 'visual_edit',
    missing: '支持截图理解的视觉模型配置',
    why: 'visual_edit 需要模型同时理解截图和代码上下文；普通文本模型 key 不具备这个能力。',
    acceptedConfig: [
      '当前 visual_edit 实现暂只识别智谱视觉路径：模型设置里的智谱 key，或环境变量 ZHIPU_API_KEY。',
      '如果已经配置了其他支持截图理解的视觉模型，当前版本还不会自动复用，这是工具实现限制。',
    ],
  }),
  guiAgentVolcengine: formatToolDependencyHint({
    tool: 'gui_agent',
    missing: '支持屏幕观察和 GUI 操作规划的视觉模型配置',
    why: 'gui_agent 需要视觉模型观察屏幕并生成可执行的 GUI 操作计划。',
    acceptedConfig: [
      '当前 gui_agent 实现暂只识别火山/豆包路径：环境变量 VOLCENGINE_API_KEY，或兼容环境变量 DOUBAO_API_KEY。',
      '如果已经配置了其他可做 GUI 操作规划的视觉模型，当前版本还不会自动复用，这是工具实现限制。',
    ],
  }),
  textToSpeechZhipu: formatToolDependencyHint({
    tool: 'text_to_speech',
    missing: '语音合成模型配置',
    why: 'text_to_speech 需要能返回音频的语音合成模型；普通文本模型 key 不能合成音频。',
    acceptedConfig: [
      '当前 text_to_speech 实现暂只识别智谱 TTS 路径：模型设置里的智谱 key，或环境变量 ZHIPU_API_KEY。',
      '如果已经配置了其他 TTS 服务，当前版本还不会自动复用，这是工具实现限制。',
    ],
  }),
  videoGenerateZhipuOfficial: formatToolDependencyHint({
    tool: 'video_generate',
    missing: '视频生成模型配置',
    why: 'video_generate 需要能创建视频任务并轮询结果的后端；普通文本/图像模型 key 不等于视频生成能力。',
    acceptedConfig: [
      '当前 video_generate 实现暂只识别智谱官方视频路径：环境变量 ZHIPU_OFFICIAL_API_KEY。',
      '0ki/普通智谱代理不支持这个视频生成接口。',
    ],
    alternatives: [
      '只需要图片生成时，可以改用已配置的图像生成工具。',
    ],
  }),
  youtubeTranscriptSupadata: formatToolDependencyHint({
    tool: 'youtube_transcript',
    missing: '稳定字幕服务配置',
    why: 'YouTube 字幕提取依赖外部字幕接口；公共 fallback 可能被限流，也可能不支持目标视频。',
    acceptedConfig: [
      '当前 youtube_transcript 实现暂只识别 Supadata 路径：环境变量 SUPADATA_API_KEY。',
      '没有这个 key 时会继续尝试公共 fallback，但成功率不可保证。',
    ],
    alternatives: [
      '如果视频本身没有字幕，配置 API key 也无法生成原始字幕，只能改用音频转写工具。',
    ],
  }),
} as const;
