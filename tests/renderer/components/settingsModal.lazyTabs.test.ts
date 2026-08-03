import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

const appearanceModuleEvaluation = vi.hoisted(() => ({ count: 0 }));

vi.mock(
  "../../../src/renderer/components/features/settings/tabs/AppearanceSettings",
  () => {
    appearanceModuleEvaluation.count += 1;
    return { AppearanceSettings: () => null };
  },
);

const SETTINGS_MODAL_SOURCE = path.resolve(
  __dirname,
  "../../../src/renderer/components/features/settings/SettingsModal.tsx",
);
const SETTINGS_ENTRY_SOURCE = path.resolve(
  __dirname,
  "../../../src/renderer/components/SettingsModal.tsx",
);
const SETTINGS_FEATURE_INDEX_SOURCE = path.resolve(
  __dirname,
  "../../../src/renderer/components/features/settings/index.ts",
);

const SETTINGS_TAB_MODULES = [
  ["GeneralSettings", "general"],
  ["ConversationSettings", "conversation"],
  ["VoiceInputSettings", "voiceInput"],
  ["VoiceLiveSettings", "voiceLive"],
  ["VoiceModelSettings", "voiceModel"],
  ["KeybindingsSettings", "keybindings"],
  ["WorkspaceSettings", "workspace"],
  ["AppshotsSettings", "appshots"],
  ["ModelSettings", "model"],
  ["VisualModelsSettings", "visualModels"],
  ["SearchSettings", "search"],
  ["AgentEngineSettings", "agentEngine"],
  ["AppearanceSettings", "appearance"],
  ["SoulSettings", "soul"],
  ["DataSettings", "cache"],
  ["UpdateSettings", "update"],
  ["MemoryTab", "memory"],
  ["ChannelsSettings", "channels"],
  ["HooksSettings", "hooks"],
  ["AboutSettings", "about"],
  ["ScreenMemorySettings", "openchronicle"],
  ["PrivacySettings", "privacy"],
  ["DoctorSettings", "doctor"],
] as const;

const SETTINGS_TAB_SMOKE_LOADERS = [
  ["GeneralSettings", () => import("../../../src/renderer/components/features/settings/tabs/GeneralSettings"), "GeneralSettings"],
  ["ConversationSettings", () => import("../../../src/renderer/components/features/settings/tabs/ConversationSettings"), "ConversationSettings"],
  ["VoiceInputSettings", () => import("../../../src/renderer/components/features/settings/tabs/VoiceInputSettings"), "VoiceInputSettings"],
  ["VoiceLiveSettings", () => import("../../../src/renderer/components/features/settings/tabs/VoiceLiveSettings"), "VoiceLiveSettings"],
  ["VoiceModelSettings", () => import("../../../src/renderer/components/features/settings/tabs/VoiceModelSettings"), "VoiceModelSettings"],
  ["KeybindingsSettings", () => import("../../../src/renderer/components/features/settings/tabs/KeybindingsSettings"), "KeybindingsSettings"],
  ["WorkspaceSettings", () => import("../../../src/renderer/components/features/settings/tabs/WorkspaceSettings"), "WorkspaceSettings"],
  ["AppshotsSettings", () => import("../../../src/renderer/components/features/settings/tabs/AppshotsSettings"), "default"],
  ["ModelSettings", () => import("../../../src/renderer/components/features/settings/tabs/ModelSettings"), "ModelSettings"],
  ["VisualModelsSettings", () => import("../../../src/renderer/components/features/settings/tabs/VisualModelsSettings"), "default"],
  ["SearchSettings", () => import("../../../src/renderer/components/features/settings/tabs/SearchSettings"), "SearchSettings"],
  ["AgentEngineSettings", () => import("../../../src/renderer/components/features/settings/tabs/AgentEngineSettings"), "AgentEngineSettings"],
  ["AppearanceSettings", () => import("../../../src/renderer/components/features/settings/tabs/AppearanceSettings"), "AppearanceSettings"],
  ["SoulSettings", () => import("../../../src/renderer/components/features/settings/tabs/SoulSettings"), "SoulSettings"],
  ["DataSettings", () => import("../../../src/renderer/components/features/settings/tabs/DataSettings"), "DataSettings"],
  ["UpdateSettings", () => import("../../../src/renderer/components/features/settings/tabs/UpdateSettings"), "UpdateSettings"],
  ["MemoryTab", () => import("../../../src/renderer/components/features/settings/tabs/MemoryTab"), "MemoryTab"],
  ["ChannelsSettings", () => import("../../../src/renderer/components/features/settings/tabs/ChannelsSettings"), "ChannelsSettings"],
  ["HooksSettings", () => import("../../../src/renderer/components/features/settings/tabs/HooksSettings"), "HooksSettings"],
  ["AboutSettings", () => import("../../../src/renderer/components/features/settings/tabs/AboutSettings"), "AboutSettings"],
  ["ScreenMemorySettings", () => import("../../../src/renderer/components/features/settings/tabs/ScreenMemorySettings"), "ScreenMemorySettings"],
  ["PrivacySettings", () => import("../../../src/renderer/components/features/settings/tabs/PrivacySettings"), "default"],
  ["DoctorSettings", () => import("../../../src/renderer/components/features/settings/tabs/DoctorSettings"), "DoctorSettings"],
] as const;

describe("SettingsModal tab loading contract", () => {
  const source = fs.readFileSync(SETTINGS_MODAL_SOURCE, "utf8");

  it("wraps all 23 tab modules in React.lazy without static tab imports", () => {
    expect(source).not.toMatch(
      /^\s*import(?:\s+type)?\b[^;\n]*from ['"]\.\/tabs\//m,
    );

    const lazyWrappers = source.match(/React\.lazy\(/g) ?? [];
    const lazyImports =
      source.match(/import\(['"]\.\/tabs\/[^'"]+['"]\)/g) ?? [];
    expect(lazyWrappers).toHaveLength(SETTINGS_TAB_MODULES.length);
    expect(lazyImports).toHaveLength(SETTINGS_TAB_MODULES.length);

    for (const [moduleName, tabId] of SETTINGS_TAB_MODULES) {
      expect(source).toMatch(
        new RegExp(`import\\([\\"']\\.\\/tabs\\/${moduleName}[\\"']\\)`),
      );
      expect(source).toMatch(new RegExp(`activeTab === [\\"']${tabId}[\\"']`));
    }
  });

  it("uses a sized Suspense fallback and does not evaluate an inactive tab at shell load", async () => {
    expect(source).toContain(
      "<React.Suspense fallback={<SettingsTabSkeleton />}>",
    );
    expect(source).toContain('className="min-h-[540px] space-y-5"');
    expect(source).toContain("openSettingsTab(tab);");
    expect(source).toContain("settingsInitialTab ?? DEFAULT_SETTINGS_TAB");

    appearanceModuleEvaluation.count = 0;
    await import("../../../src/renderer/components/features/settings/SettingsModal");
    expect(appearanceModuleEvaluation.count).toBe(0);
  });

  it("resolves every tab target used by the lazy loaders", async () => {
    for (const [moduleName, load, exportName] of SETTINGS_TAB_SMOKE_LOADERS) {
      const moduleExports = (await load()) as unknown as Record<string, unknown>;
      expect(moduleExports[exportName], moduleName).toBeTypeOf("function");
    }
  });

  it("keeps the app entry from eagerly traversing the settings barrel", () => {
    const entrySource = fs.readFileSync(SETTINGS_ENTRY_SOURCE, "utf8");
    const featureIndexSource = fs.readFileSync(
      SETTINGS_FEATURE_INDEX_SOURCE,
      "utf8",
    );
    expect(entrySource).toContain("from './features/settings';");
    expect(entrySource).not.toContain(
      "from './features/settings/SettingsModal';",
    );
    expect(featureIndexSource).not.toMatch(
      /^\s*export\s+\{[^}]+\}\s+from ['"]\.\/tabs\//m,
    );
    expect(featureIndexSource.match(/React\.lazy\(/g) ?? []).toHaveLength(5);
  });
});
