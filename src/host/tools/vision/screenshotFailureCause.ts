type ScreenshotFailureCauseKind =
  | 'ssh_session_no_gui'
  | 'screen_recording_permission'
  | 'no_display_server'
  | 'unknown';

const CAUSE_TEXT: Record<ScreenshotFailureCauseKind, string> = {
  ssh_session_no_gui: 'SSH session without a graphical session',
  screen_recording_permission: 'screen recording permission denied',
  no_display_server: 'no display server detected',
  unknown: 'unknown',
};

export function detectScreenshotFailureCause(args: {
  platform: string;
  env: Record<string, string | undefined>;
  message?: string;
  stderr?: string;
}): { kind: ScreenshotFailureCauseKind; text: string } {
  const combinedOutput = `${args.message ?? ''}\n${args.stderr ?? ''}`;

  if (
    args.platform === 'darwin'
    && Boolean(args.env.SSH_CONNECTION || args.env.SSH_TTY || args.env.SSH_CLIENT)
  ) {
    return { kind: 'ssh_session_no_gui', text: CAUSE_TEXT.ssh_session_no_gui };
  }

  if (
    args.platform === 'darwin'
    && /screen recording|not authorized/i.test(combinedOutput)
  ) {
    return { kind: 'screen_recording_permission', text: CAUSE_TEXT.screen_recording_permission };
  }

  if (
    args.platform === 'linux'
    && !args.env.DISPLAY
    && !args.env.WAYLAND_DISPLAY
  ) {
    return { kind: 'no_display_server', text: CAUSE_TEXT.no_display_server };
  }

  return { kind: 'unknown', text: CAUSE_TEXT.unknown };
}
