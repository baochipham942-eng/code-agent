// ============================================================================
// Voice and Transcription Boundary Contract
// ============================================================================

export type VoiceTranscriptionPathId =
  | 'chat_voice'
  | 'voice_paste'
  | 'desktop_audio'
  | 'channel_audio';

export interface VoiceTranscriptionPath {
  id: VoiceTranscriptionPathId;
  title: string;
  trigger: string;
  providers: string[];
  cloud: string;
  temporaryStorage: string;
  postProcessing: string;
  logPolicy: string;
  cleanupPolicy: string;
  settingsEntry: string;
}

export const VOICE_TRANSCRIPTION_PATHS: Record<VoiceTranscriptionPathId, VoiceTranscriptionPath> = {
  chat_voice: {
    id: 'chat_voice',
    title: '聊天语音输入',
    trigger: '按住或点击聊天输入框里的语音按钮。',
    providers: ['Groq Whisper'],
    cloud: '当前实现走 Groq Whisper，音频会发送到外部服务。',
    temporaryStorage: '主进程在系统临时目录写入音频文件，转写完成后删除。',
    postProcessing: '无额外文本后处理。',
    logPolicy: '日志只记录 size、mimeType、duration、错误码，不记录转写正文。',
    cleanupPolicy: '成功、失败和异常路径都清理临时音频文件。',
    settingsEntry: '隐私防线 / 模型供应商',
  },
  voice_paste: {
    id: 'voice_paste',
    title: 'Voice Paste',
    trigger: '触发全局 voice paste 录音并把转写结果粘贴到当前应用。',
    providers: ['本地 whisper-cpp', 'Groq Whisper', '智谱/Kimi 后处理'],
    cloud: '优先本地 whisper-cpp；本地不可用时回落 Groq，后处理可能调用智谱或 Kimi。',
    temporaryStorage: '录音写入系统临时目录，转写或粘贴完成后清理。',
    postProcessing: '可用智谱/Kimi 清理口头禅、标点和同音字。',
    logPolicy: '日志只记录 provider、字符数、duration、错误码，不记录正文片段。',
    cleanupPolicy: '录音、转换后的 wav 和失败残留都应尽力删除。',
    settingsEntry: '隐私防线 / 语音转写边界',
  },
  desktop_audio: {
    id: 'desktop_audio',
    title: '桌面或会议音频',
    trigger: '启用桌面音频、会议转写或 Native Desktop 音频能力。',
    providers: ['whisper-cpp', 'qwen3-asr', 'none'],
    cloud: '取决于当前 Native Desktop ASR engine；本地 engine 不出云端。',
    temporaryStorage: '音频片段应只在本地临时目录或桌面采集缓存中短期存在。',
    postProcessing: '取决于桌面音频 pipeline。',
    logPolicy: '日志记录 engine、duration、音频段数量和错误码，不记录转写正文。',
    cleanupPolicy: '停止采集或任务结束后清理临时音频片段。',
    settingsEntry: '应用截图 / Native Desktop',
  },
  channel_audio: {
    id: 'channel_audio',
    title: '通道语音消息',
    trigger: '飞书、Telegram、HTTP API 等通道收到语音或音频附件。',
    providers: ['通道 adapter 配置的 ASR provider'],
    cloud: '独立于桌面 Whisper 设置；是否出云端由通道 ASR 配置决定。',
    temporaryStorage: '下载的音频附件应只在本机临时保存并按消息处理周期清理。',
    postProcessing: '按通道 adapter 策略处理，不继承桌面语音设置。',
    logPolicy: '日志只记录 channel、provider、duration、错误码，不记录正文。',
    cleanupPolicy: '消息处理完成后清理下载文件和中间音频。',
    settingsEntry: '通道 / 隐私策略',
  },
};

export const VOICE_TRANSCRIPTION_PATH_IDS = Object.keys(VOICE_TRANSCRIPTION_PATHS) as VoiceTranscriptionPathId[];

export function getVoiceTranscriptionPath(id: VoiceTranscriptionPathId): VoiceTranscriptionPath {
  return VOICE_TRANSCRIPTION_PATHS[id];
}

export function listVoiceTranscriptionPaths(): VoiceTranscriptionPath[] {
  return VOICE_TRANSCRIPTION_PATH_IDS.map((id) => VOICE_TRANSCRIPTION_PATHS[id]);
}
