export const turnCheckoutChatZh = {
  inputRedirectReceipt: { title: '已按你的纠正改了方向：', viewOriginal: '查看原话', hideOriginal: '收起原话', stoppedAt: '上一轮写到 {count} 字处停下', stoppedBeforeOutput: '上一轮还没写出内容就停下', workingOn: '当时正在处理 {names}' },
  turnRedoAction: '反悔',
  rewindConversationOnlyAction: '仅回退对话，文件保持不变',
  turnCheckoutSuccess: '文件和对话已一起回去。',
  turnCheckoutPartial: '只完成了一部分，请查看恢复记录。',
  turnCheckoutExternalEffects: '外部命令造成的改动不会回滚。',
  turnCheckoutNoteRedoSuccess: '已反悔，文件和对话已一起恢复。',
  turnCheckoutNoteRedoPartial: '反悔只完成了一部分。',
  turnCheckoutNoteChanged: '工作区处理了 {count} 个文件。',
  turnCheckoutNoteHumanEdit: '{file} 检测到人工编辑，未覆盖。',
  turnCheckoutNoteLegacyDigest: '{file} 缺少写后校验信息，未覆盖。',
  turnCheckoutNoteSnapshotFailed: '{file} 无法安全保存反悔快照，未覆盖。',
};

export const turnCheckoutChatEn: typeof turnCheckoutChatZh = {
  inputRedirectReceipt: { title: 'Changed direction based on your correction: ', viewOriginal: 'View original', hideOriginal: 'Hide original', stoppedAt: 'The previous reply stopped at {count} characters', stoppedBeforeOutput: 'The previous reply stopped before producing text', workingOn: 'It was working on {names}' },
  turnRedoAction: 'Undo',
  rewindConversationOnlyAction: 'Rewind conversation only; keep files unchanged',
  turnCheckoutSuccess: 'Files and conversation went back together.',
  turnCheckoutPartial: 'Only part of the checkout completed; review the restore record.',
  turnCheckoutExternalEffects: 'Changes caused by external commands are not rolled back.',
  turnCheckoutNoteRedoSuccess: 'Undo completed; files and conversation were restored together.',
  turnCheckoutNoteRedoPartial: 'Only part of the undo completed.',
  turnCheckoutNoteChanged: '{count} workspace files were processed.',
  turnCheckoutNoteHumanEdit: '{file} has manual edits and was not overwritten.',
  turnCheckoutNoteLegacyDigest: '{file} lacks a post-write digest and was not overwritten.',
  turnCheckoutNoteSnapshotFailed: '{file} could not be snapshotted safely and was not overwritten.',
};
