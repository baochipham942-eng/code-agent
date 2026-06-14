// ============================================================================
// Permission and Data Boundary Contract
// ============================================================================

export type PermissionBoundaryId =
  | 'file.project_read'
  | 'file.project_write'
  | 'file.external_read'
  | 'file.external_write'
  | 'command.shell'
  | 'network.web_request'
  | 'mcp.server_tool'
  | 'memory.local'
  | 'desktop.screen_capture'
  | 'desktop.accessibility'
  | 'desktop.audio.microphone'
  | 'desktop.audio.system'
  | 'provider.api_key'
  | 'channel.connector'
  | 'telemetry.diagnostic'
  | 'plugin.extension'
  | 'browser.relay';

export interface PermissionBoundary {
  id: PermissionBoundaryId;
  title: string;
  trigger: string;
  dataAccess: string[];
  storage: string;
  cloud: string;
  redaction: string;
  revoke: string;
  sensitivity: 'low' | 'medium' | 'high';
}

export interface PermissionBoundaryRef {
  id: PermissionBoundaryId;
  reason?: string;
}

export const PERMISSION_BOUNDARY_REGISTRY: Record<PermissionBoundaryId, PermissionBoundary> = {
  'file.project_read': {
    id: 'file.project_read',
    title: '读取当前项目文件',
    trigger: '工具需要读取当前工作区里的文件或目录。',
    dataAccess: ['文件路径', '文件内容', '目录结构'],
    storage: '不额外落盘；内容只进入当前任务上下文和本地会话记录。',
    cloud: '如果当前模型是云端模型，读取内容会随本次任务上下文发给模型供应商。',
    redaction: '日志和诊断导出默认经过敏感信息脱敏。',
    revoke: '拒绝本次权限，或在权限与安全设置里切回更严格的权限模式。',
    sensitivity: 'medium',
  },
  'file.project_write': {
    id: 'file.project_write',
    title: '修改当前项目文件',
    trigger: '工具需要在当前工作区内新增、编辑或删除文件。',
    dataAccess: ['目标路径', '变更内容', 'diff 预览'],
    storage: '变更写入当前工作区；会话记录保留本次工具调用摘要。',
    cloud: '变更摘要可能随当前任务上下文发给模型供应商。',
    redaction: '诊断、通知和日志里的路径、密钥、token 默认脱敏。',
    revoke: '拒绝本次权限，或撤销已保存的会话级/永久授权。',
    sensitivity: 'medium',
  },
  'file.external_read': {
    id: 'file.external_read',
    title: '读取工作区外文件',
    trigger: '工具要读取当前工作区之外的文件。',
    dataAccess: ['外部文件路径', '文件内容或元数据'],
    storage: '不额外复制；内容只进入本次任务上下文和本地会话记录。',
    cloud: '如果当前模型是云端模型，读取内容会随本次任务上下文发给模型供应商。',
    redaction: '外发日志和诊断包默认隐藏 home 路径、密钥和个人信息。',
    revoke: '拒绝本次权限；不要保存为永久授权，除非确认该路径长期可信。',
    sensitivity: 'high',
  },
  'file.external_write': {
    id: 'file.external_write',
    title: '修改工作区外文件',
    trigger: '工具要写入当前工作区之外的位置。',
    dataAccess: ['外部路径', '写入内容', '可能覆盖的现有内容'],
    storage: '变更直接写入目标路径，可能影响其他项目或系统配置。',
    cloud: '变更摘要可能随当前任务上下文发给模型供应商。',
    redaction: '日志和诊断包默认隐藏敏感路径、密钥和 token。',
    revoke: '拒绝本次权限；需要时只允许一次。',
    sensitivity: 'high',
  },
  'command.shell': {
    id: 'command.shell',
    title: '执行 shell 命令',
    trigger: '任务需要运行本地命令、测试、构建或脚本。',
    dataAccess: ['命令文本', '命令输出', '当前工作目录'],
    storage: '命令输出进入本地会话记录；长输出可能落到本地临时文件。',
    cloud: '命令输出可能随当前任务上下文发给模型供应商。',
    redaction: '日志、通知和诊断导出默认脱敏 token、密钥、cookie 和 home 路径。',
    revoke: '拒绝本次命令，或撤销已保存的命令授权。',
    sensitivity: 'high',
  },
  'network.web_request': {
    id: 'network.web_request',
    title: '访问网络资源',
    trigger: '工具需要搜索、抓取网页或访问外部 API。',
    dataAccess: ['目标 URL', '请求参数', '返回内容'],
    storage: '返回内容进入本地会话记录；长结果可能写入本地临时文件。',
    cloud: '请求会发往目标站点；返回内容可能随当前任务上下文发给模型供应商。',
    redaction: 'URL token、Authorization、cookie 和密钥默认在日志/诊断里脱敏。',
    revoke: '拒绝本次网络访问，或在权限模式里要求每次询问。',
    sensitivity: 'high',
  },
  'mcp.server_tool': {
    id: 'mcp.server_tool',
    title: '调用 MCP 服务器工具',
    trigger: '任务需要调用已连接 MCP server 的 tool 或 resource。',
    dataAccess: ['server 名称', 'tool 名称', '工具参数', '工具返回值'],
    storage: '调用摘要进入本地会话记录；超大结果会 spill 到本地文件。',
    cloud: '取决于 MCP server；openWorld 或外部服务工具可能访问第三方网络。',
    redaction: 'MCP 调用日志递归隐藏 token、password、secret、authorization 和 credential。',
    revoke: '在 MCP 设置里禁用 server、撤回 OAuth，或拒绝本次工具调用。',
    sensitivity: 'high',
  },
  'memory.local': {
    id: 'memory.local',
    title: '读取或写入本地记忆',
    trigger: '任务需要查询、更新或压缩本地记忆内容。',
    dataAccess: ['记忆文本', '关联会话', '记忆元数据'],
    storage: '记忆保存在本机数据目录或用户配置的记忆目录。',
    cloud: '用于模型上下文时，相关片段可能发给当前模型供应商。',
    redaction: '导出、遥测和诊断路径默认脱敏；本地原始记忆保留完整语义。',
    revoke: '在记忆设置里关闭、删除或导出后清理。',
    sensitivity: 'high',
  },
  'desktop.screen_capture': {
    id: 'desktop.screen_capture',
    title: '读取桌面截图或窗口内容',
    trigger: '用户触发应用截图、桌面观察或窗口上下文采集。',
    dataAccess: ['屏幕截图', '窗口标题', '可访问的窗口文本'],
    storage: '截图和派生摘要保存在本机缓存或当前会话附件中。',
    cloud: '如果用于云端模型推理，截图或摘要会发给模型供应商。',
    redaction: '诊断导出默认隐藏截图路径；正文仍需按用户动作判断是否发送。',
    revoke: '在 macOS 系统设置里撤回屏幕录制权限，或关闭 Appshots/桌面采集。',
    sensitivity: 'high',
  },
  'desktop.accessibility': {
    id: 'desktop.accessibility',
    title: '控制或读取桌面辅助功能树',
    trigger: '用户触发原生桌面连接器、自动点击、窗口文本读取或 Computer Use。',
    dataAccess: ['前台应用信息', '辅助功能树', '点击/键盘动作目标'],
    storage: '动作摘要进入本地会话记录；不会保存系统级完整权限快照。',
    cloud: '如果动作计划由云端模型生成，界面摘要可能发给模型供应商。',
    redaction: '日志和诊断导出默认隐藏敏感文本、路径和 token。',
    revoke: '在 macOS 系统设置里撤回辅助功能权限，或断开原生连接器。',
    sensitivity: 'high',
  },
  'desktop.audio.microphone': {
    id: 'desktop.audio.microphone',
    title: '使用麦克风录音',
    trigger: '用户按下语音输入、voice paste 或语音转写按钮。',
    dataAccess: ['麦克风音频', '转写文本', '转写 provider 元数据'],
    storage: '临时音频写入系统临时目录，成功或失败后应清理；转写文本进入当前会话或剪贴板动作。',
    cloud: '取决于当前转写路径；Groq 等云端转写会上传音频。',
    redaction: '默认不在日志记录转写正文，只记录长度、provider、耗时和错误码。',
    revoke: '在 macOS 系统设置撤回麦克风权限，或在语音设置中切换/关闭云端转写。',
    sensitivity: 'high',
  },
  'desktop.audio.system': {
    id: 'desktop.audio.system',
    title: '读取系统音频',
    trigger: '用户启用桌面音频、会议音频或系统音频转写。',
    dataAccess: ['系统音频流', 'ASR 转写文本', '音频引擎状态'],
    storage: '音频片段和派生转写应只在本机临时保存，并按任务清理。',
    cloud: '取决于 ASR engine；云端 ASR 会上传音频或片段。',
    redaction: '日志默认只记录 engine、duration、size、错误码，不记录正文。',
    revoke: '在系统设置撤回屏幕与系统音频录制权限，或关闭桌面音频采集。',
    sensitivity: 'high',
  },
  'provider.api_key': {
    id: 'provider.api_key',
    title: '保存模型或服务 API Key',
    trigger: '用户保存 provider、channel、MCP 或插件所需的密钥。',
    dataAccess: ['API key', 'provider 名称', 'base URL 或自定义 header'],
    storage: '优先进入系统 Keychain / secure storage；UI 读取侧只显示 configured/masked。',
    cloud: '密钥用于访问对应外部服务，不应进入模型上下文。',
    redaction: 'IPC、日志、诊断包、设置列表默认不展示完整 key。',
    revoke: '在对应 provider 设置删除 key，或去服务商控制台轮换/撤销。',
    sensitivity: 'high',
  },
  'channel.connector': {
    id: 'channel.connector',
    title: '连接外部消息通道',
    trigger: '用户连接 HTTP API、飞书、Telegram 等外部入口。',
    dataAccess: ['入站消息', 'sender/chat 元数据', '附件信息', 'channel token 或 app secret'],
    storage: '通道配置保存在 secure storage；默认入站内容本地脱敏后再进入会话。',
    cloud: '回复会发回对应通道；模型推理可能使用脱敏后的消息内容。',
    redaction: '默认 local-redact；allow-raw 只用于受控调试，off 只用于本地排障。',
    revoke: '禁用或删除通道账号，或在外部平台撤回 token/app secret。',
    sensitivity: 'high',
  },
  'telemetry.diagnostic': {
    id: 'telemetry.diagnostic',
    title: '上传或导出诊断数据',
    trigger: '用户导出诊断包，或故障诊断流程收集运行信息。',
    dataAccess: ['运行元数据', '错误摘要', 'scrub 后的 raw payload', '版本和环境指纹'],
    storage: '诊断包生成在本机；上传前经过 scrub。',
    cloud: '自动 telemetry 只传 metadata；诊断包上传属于单独边界。',
    redaction: '上传/导出前必须通过 secret detector 和诊断包 scrub。',
    revoke: '关闭遥测上报；诊断包上传保持显式动作。',
    sensitivity: 'high',
  },
  'plugin.extension': {
    id: 'plugin.extension',
    title: '使用插件能力',
    trigger: '用户安装、启用或调用插件里的命令、hook 或 skill。',
    dataAccess: ['插件 manifest', '命令参数', 'hook 触发上下文', '外部服务配置'],
    storage: '插件配置保存在本地插件目录或 secure storage。',
    cloud: '取决于插件声明；未声明不等于无外部访问。',
    redaction: '插件日志和 hook 输出默认走 secret masking。',
    revoke: '禁用或卸载插件，撤回相关 provider/channel/MCP token。',
    sensitivity: 'high',
  },
  'browser.relay': {
    id: 'browser.relay',
    title: '连接浏览器控制通道',
    trigger: '用户启用浏览器 relay、managed browser 或扩展控制。',
    dataAccess: ['浏览器 tab', 'DOM/AX snapshot', '截图', '可能包含登录态的页面上下文'],
    storage: 'relay token 和连接状态保存在本地；采集结果进入当前任务上下文。',
    cloud: '如果云端模型参与浏览器任务，页面摘要或截图可能发给模型供应商。',
    redaction: '日志和诊断包隐藏 token、cookie、authorization 和敏感表单字段。',
    revoke: '关闭 relay、移除浏览器扩展，或轮换 relay token。',
    sensitivity: 'high',
  },
};

export const PERMISSION_BOUNDARY_IDS = Object.keys(PERMISSION_BOUNDARY_REGISTRY) as PermissionBoundaryId[];

export function isPermissionBoundaryId(value: unknown): value is PermissionBoundaryId {
  return typeof value === 'string' && value in PERMISSION_BOUNDARY_REGISTRY;
}

export function getPermissionBoundary(id: PermissionBoundaryId | undefined): PermissionBoundary | undefined {
  return id ? PERMISSION_BOUNDARY_REGISTRY[id] : undefined;
}

export function listPermissionBoundaries(): PermissionBoundary[] {
  return PERMISSION_BOUNDARY_IDS.map((id) => PERMISSION_BOUNDARY_REGISTRY[id]);
}
