// ============================================================================
// Settings namespace translations (zh/ExternalImport) — 设置页「从其他 AI 应用导入」
// （N-EXTHISTORY-IMPORT-K1A；zhSettingsWork 已贴 max-lines 上限，文案独立成档）
// ============================================================================

export const zhSettingsExternalImport = {
    externalImport: {
      title: '从其他 AI 应用导入',
      description: '把你在其他 AI 工具里的说明、记忆和技能带进 Neo。只读取本机文件，预览后由你确认。',
      unaffectedLine: '现有设置不受影响，原应用的文件不会被修改。',
      detecting: '正在检测…',
      refresh: '重新检测',
      detectFailed: '检测导入来源失败',
      homeHint: '检测目录：{homeDir}',
      noSources: '未检测到可导入的来源。',
      noNewMemories: '没有新的可导入记忆（已导入过的会显示为重复并跳过）。',
      emptySelection: '请至少勾选一个类别。',
      categories: {
        instructions: '说明',
        memories: '记忆',
        skills: '技能',
      },
      sourceNames: {
        'claude-code': 'Claude Code',
        codex: 'Codex',
        cursor: 'Cursor',
        'grok-build': 'Grok Build',
        'qwen-code': 'Qwen Code',
        'gemini-cli': 'Gemini CLI',
      },
      skillsReadOnlySuffix: '（原位使用，不复制）',
      claudeSkills: {
        title: 'Claude 技能：已在原位使用 {count} 个',
        hint: 'Neo 直接读取 ~/.claude/skills，不复制、不改动。关闭后不再读取。',
        toggleLabel: '读取 Claude 技能',
      },
      previewCta: '预览要导入的内容',
      previewTitle: '导入预览',
      backToSelect: '返回重选',
      previewFailed: '生成预览失败',
      memorySectionTitle: '记忆（{count}）',
      skillsSectionTitle: '技能（{count}）',
      instructionsTitle: '说明类内容需逐条确认（{count} 条）',
      confirmDirective: '逐条确认',
      confirmingDirective: '等待确认…',
      directiveImported: '已确认并写入',
      directiveNotImported: '未获确认，没有写入',
      directiveFailed: '确认失败',
      candidateReasonLabels: {
        'new-content': '新内容',
        'duplicate-content-hash': '内容与现有记忆重复',
      },
      skillReasonLabels: {
        'new-skill': '将复制',
        'target-name-exists': 'Neo 已有同名技能，跳过',
      },
      applyCta: '开始导入',
      applyFailed: '导入失败',
      resultsTitle: '导入完成',
      resultsMemory: '记忆：导入 {imported} 条，跳过 {skipped} 条',
      resultsSkills: '技能：复制 {copied} 个，跳过 {skipped} 个（目标目录：{targetDir}）',
      resultsDirectives: '说明类：已确认写入 {imported} 条',
      resultsAgain: '再导一次（已有的内容不会重复导入）',
      memoryLink: {
        title: '从其他 AI 应用导入',
        description: '检测到其他 AI 工具的数据（说明 / 记忆 / 技能）时，可在这里一并导入；原应用文件不会被修改。',
        button: '打开导入页',
      },
    },
};
