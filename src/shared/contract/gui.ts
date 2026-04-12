// ============================================================================
// GUI Agent Types (Computer Use)
// ============================================================================

export interface ScreenCapture {
  width: number;
  height: number;
  data: string; // base64 encoded
  timestamp: number;
}

export interface ComputerAction {
  type: 'click' | 'type' | 'scroll' | 'screenshot' | 'key' | 'move';
  coordinate?: [number, number];
  text?: string;
  key?: string;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export interface GUIAgentConfig {
  displayWidth: number;
  displayHeight: number;
  screenshotQuality?: number;
}
