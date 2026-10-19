// ============================================================================
// Settings namespace translations (en/ExternalImport) — Import from other AI apps
// (N-EXTHISTORY-IMPORT-K1A; enSettingsWork is at the max-lines cap, so this is a
// standalone module mirroring zhSettingsExternalImport)
// ============================================================================

export const enSettingsExternalImport = {
    externalImport: {
      title: 'Import from other AI apps',
      description: 'Bring your instructions, memories, and skills from other AI tools into Neo. Local files only; you confirm after preview.',
      unaffectedLine: 'Existing settings are not affected; files in the original app are never modified.',
      detecting: 'Detecting…',
      refresh: 'Detect again',
      detectFailed: 'Failed to detect import sources',
      homeHint: 'Detection home: {homeDir}',
      noSources: 'No importable sources detected.',
      noNewMemories: 'No new memories to import (already-imported ones show up as duplicates and are skipped).',
      emptySelection: 'Tick at least one category.',
      categories: {
        instructions: 'Instructions',
        memories: 'Memories',
        skills: 'Skills',
      },
      sourceNames: {
        'claude-code': 'Claude Code',
        codex: 'Codex',
        cursor: 'Cursor',
        'grok-build': 'Grok Build',
        'qwen-code': 'Qwen Code',
        'gemini-cli': 'Gemini CLI',
      },
      skillsReadOnlySuffix: ' (used in place, not copied)',
      claudeSkills: {
        title: 'Claude skills: {count} already in use',
        hint: 'Neo reads ~/.claude/skills in place — nothing is copied or modified. Turn off to stop reading.',
        toggleLabel: 'Read Claude skills',
      },
      previewCta: 'Preview what will be imported',
      previewTitle: 'Import preview',
      backToSelect: 'Back to selection',
      previewFailed: 'Failed to build preview',
      memorySectionTitle: 'Memories ({count})',
      skillsSectionTitle: 'Skills ({count})',
      instructionsTitle: 'Instructions ({count})',
      instructionCompareOnly: 'Comparison only, not imported',
      confirmDirective: 'Confirm',
      confirmingDirective: 'Waiting for confirmation…',
      directiveImported: 'Confirmed and imported',
      directiveDialogTitle: 'Confirm importing this instruction',
      directiveDialogConfirm: 'Import it',
      directiveDialogCancel: 'Not now',
      directiveNotImported: 'Not confirmed; nothing was written',
      directiveFailed: 'Confirmation failed',
      candidateReasonLabels: {
        'new-content': 'New content',
        'duplicate-content-hash': 'Duplicates existing memory',
      },
      skillReasonLabels: {
        'new-skill': 'Will be copied',
        'target-name-exists': 'A skill with this name already exists in Neo; skipped',
      },
      skillActionLabels: {
        copied: 'Copied',
        skipped: 'Skipped',
      },
      applyCta: 'Start import',
      applyFailed: 'Import failed',
      resultsTitle: 'Import finished',
      resultsMemory: 'Memories: imported {imported}, skipped {skipped}',
      resultsSkills: 'Skills: copied {copied}, skipped {skipped} (target: {targetDir})',
      resultsDirectives: 'Instructions: {imported} confirmed and imported',
      resultsAgain: 'Import again (already-imported items are skipped)',
      memoryLink: {
        title: 'Import from other AI apps',
        description: 'When data from other AI tools is detected (instructions / memories / skills), import it here; original app files are never modified.',
        button: 'Open import page',
      },
    },
};
