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
      instructionsTitle: '说明类内容（{count} 条）',
      instructionCompareOnly: '只供对照，不写入',
      // 注：旧的整文件「逐条确认」钮与「已确认并写入」文案随 K1A-FU1 规则拆条下线，
      // 现行文案在 instructionRules 组里（导入这一条 / 已导入）。
      instructionRules: {
        rulesFound: '找到 {count} 条规则',
        expand: '展开',
        collapse: '收起',
        capHint: '新会话每次最多携带 {max} 条规则（约 {chars} 字），优先导入最重要的。',
        overCap: '超出新会话上限，暂不会生效',
        importThis: '导入这一条',
        importedState: '已导入',
        alreadyImported: '已导入过',
        noRules: '没有可导入的单条规则',
        headless: '请在应用里完成这条的确认',
      },
      confirmingDirective: '等待确认…',
      directiveDialogTitle: '确认导入这条说明',
      directiveDialogConfirm: '确认导入',
      directiveDialogCancel: '暂不导入',
      directiveNotImported: '未获确认，没有写入',
      directiveFailed: '确认失败',
      candidateReasonLabels: {
        'new-content': '新内容',
        'duplicate-content-hash': '内容与现有记忆重复',
      },
      skillReasonLabels: {
        'new-skill': '将复制',
        'target-name-exists': 'Neo 已有同名技能，跳过',
        'copy-failed': '复制失败，已跳过',
      },
      skillActionLabels: {
        copied: '已复制',
        skipped: '已跳过',
      },
      applyCta: '开始导入',
      applyFailed: '导入失败',
      // 最近聊天一键导入卡（N-EXTHISTORY-IMPORT-CHATS-HOST-FU1）：独立于三步流，
      // 一键批量导入最近 30 天 Claude Code / Codex CLI 会话；reason 是宿主日志用的
      // 原始诊断串（含路径），页面只按 status 出文案，绝不渲染 reason。
      chatsImport: {
        title: '最近聊天',
        description: '批量导入最近 30 天的 Claude Code / Codex CLI 聊天，最多 50 条，原对话不会被修改。',
        cta: '导入最近的聊天',
        running: '正在导入…',
        summary: '已导入 {imported} · 已在 Neo {already} · 目录不存在 {folderMissing} · 失败 {failed}',
        empty: '最近 30 天没有发现 Claude Code 或 Codex 聊天',
        failed: '导入最近的聊天失败',
        engineNames: {
          claude_code: 'Claude Code',
          codex_cli: 'Codex',
        },
        statusLabels: {
          imported: '已导入',
          already_imported: '已在 Neo',
          folder_missing: '原目录已不存在，恢复目录后重新点击即可导入',
          failed: '这一条没能导入',
        },
      },
      resultsTitle: '导入完成',
      resultsMemory: '记忆：导入 {imported} 条，跳过 {skipped} 条',
      resultsSkills: '技能：复制 {copied} 个，跳过 {skipped} 个，已放进 Neo 技能库',
      resultsDirectives: '说明类：已确认写入 {imported} 条',
      resultsAgain: '再导一次（已有的内容不会重复导入）',
      viewSkillsCta: '查看技能',
      memoryLink: {
        title: '从其他 AI 应用导入',
        description: '检测到其他 AI 工具的数据（说明 / 记忆 / 技能）时，可在这里一并导入；原应用文件不会被修改。',
        button: '打开导入页',
      },
    },
};
