export const enAppshotsSettingsBase = {
  enableTitle: 'Enable app screenshots',
  enableDescriptionPrefix: 'Hold',
  enableDescriptionShortcut: ' Left + Right Command ',
  enableDescriptionSuffix: 'to capture the frontmost app window and send its text into the input box.',
  triggerTitle: 'Trigger',
  triggerText: 'Press left and right Command together',
  targetTitle: 'Send target',
  targetDescription: 'Choose which conversation receives screenshots',
  targetOptions: {
    current: {
      label: 'Current conversation',
      description: 'Insert into the active conversation',
    },
    new: {
      label: 'Create a new conversation each time',
      description: 'Start a new conversation for each screenshot',
    },
  },
  permissionsTitle: 'System permissions',
  permissionsDescription: 'App screenshots need Screen Recording to capture windows and Accessibility to read window text. If the shortcut does not respond, grant permissions in System Settings and restart the app.',
  openScreenCapture: 'Open Screen Recording permissions',
  openAccessibility: 'Open Accessibility permissions',
};

export const zhAppshotsSettingsBase = {
  enableTitle: '启用应用截图',
  enableDescriptionPrefix: '按住',
  enableDescriptionShortcut: ' 左 + 右 Command ',
  enableDescriptionSuffix: '抓取当前前台 app 窗口，连同窗口文本一起送进输入框。',
  triggerTitle: '触发方式',
  triggerText: '同时按下左右 Command 键',
  targetTitle: '发送目标',
  targetDescription: '截图发送到哪个会话',
  targetOptions: {
    current: {
      label: '当前会话',
      description: '贴进正在进行的对话',
    },
    new: {
      label: '每次新建会话',
      description: '每张截图开一个新对话',
    },
  },
  permissionsTitle: '系统权限',
  permissionsDescription: '应用截图需要「屏幕录制」截窗、「辅助功能」读取窗口文本。若热键无反应，请在系统设置里授权后重启应用。',
  openScreenCapture: '打开「屏幕录制」权限设置',
  openAccessibility: '打开「辅助功能」权限设置',
};
