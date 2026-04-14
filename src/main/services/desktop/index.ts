// ============================================================================
// Desktop Services - 原生桌面活动 / 视觉 / 音频
// ============================================================================

export {
  NativeDesktopService,
  getNativeDesktopService,
} from './nativeDesktopService';

export {
  startDesktopVisionAnalyzer,
  stopDesktopVisionAnalyzer,
} from './desktopVisionAnalyzer';

export {
  startDesktopAudioCapture,
  stopDesktopAudioCapture,
  getAudioCaptureStatus,
} from './desktopAudioCapture';
