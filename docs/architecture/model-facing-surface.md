# Model-facing surface

This page records the surface that reaches the model, its request cost, and its cache behavior. Use one `##` entry per tool, skill, or plugin surface. Keep the four `###` sections in the order shown below and name the repository source files that decide the behavior.

# Template

For a new entry, copy the shape `## Surface name` followed by `### What the model sees`, `### Token impact`, `### KV-cache impact`, and `### Known limits`. Write `not measured` when code does not provide a token count.

## Bash core tool

Source files: `src/host/services/toolSearch/deferredTools.ts`, `src/host/tools/modules/shell/bash.schema.ts`, `src/host/tools/modules/shell/bash.ts`, `src/host/tools/dispatch/toolDefinitions.ts`.

### What the model sees

`Bash` is in `CORE_TOOLS` in `src/host/services/toolSearch/deferredTools.ts`, so `getCoreToolDefinitions` in `src/host/tools/dispatch/toolDefinitions.ts` includes its complete tool definition in the core tool list. The name, long command-use description, output schema, and input schema come from `bashSchema` in `src/host/tools/modules/shell/bash.schema.ts`; `command` is required and the other fields describe timeout, working directory, background execution, PTY, dimensions, waiting, and a user-facing description. The handler in `src/host/tools/modules/shell/bash.ts` returns command output to the model and puts a successful foreground result's generated description in result metadata; that metadata is not another request schema.

### Token impact

The complete Bash schema is paid on each request that carries the core tool list. The provider-normalized token count for this schema is `not measured`; no count is inferred from source characters here. `readDeferredToolInjectionSchemas` in `src/host/tools/dispatch/toolDefinitions.ts` is the code path that can measure a sent schema when a tool is deferred, but Bash is not deferred.

### KV-cache impact

The Bash definition is in the **stable prefix** while `CORE_TOOLS` and `getCoreToolDefinitions` select it and `bashSchema` has no dynamic description function; `generateBashDescription` in `src/host/tools/modules/shell/bash.ts` runs after execution and is stored in result metadata, so it does not change that request-prefix text mid-session.

### Known limits

The schema does not describe every runtime policy. `bash.ts` applies permission checks, shell safety, sandbox decisions, output truncation, timeout handling, and foreground/background or PTY behavior after the call arrives. A model therefore cannot derive those runtime outcomes from the static schema alone.

## Skill meta tool

Source files: `src/host/services/toolSearch/deferredTools.ts`, `src/host/tools/modules/skill/skill.schema.ts`, `src/host/tools/modules/skill/skill.ts`, `src/host/services/skills/skillDiscoveryService.ts`, `src/host/tools/dispatch/toolDefinitions.ts`.

### What the model sees

`Skill` is in `CORE_TOOLS`, so its static schema is present in the core tool list. `skillSchema` supplies the name, the description `执行已注册的 skill`, a string output schema, and an input schema with required `command` plus optional `args`. `toolDefinitions.ts` resolves a tool description as cloud override, dynamic description, then static schema description; the current `skillSchema` supplies no dynamic description function. Available enabled skill names are registered separately by `skillDiscoveryService.registerSkillsToToolSearch`, where each name becomes `skill:<name>` metadata for `ToolSearch`. When `executeSkill` in `skill.ts` runs, it discovers the selected skill and emits status plus rendered skill content as new messages; an unknown command uses the enabled skill set to build close-name suggestions.

### Token impact

The static Skill schema is paid on every request that carries the core tool list. The provider-normalized token count for that schema is `not measured`. A selected skill's rendered content is added only after invocation by `executeSkill`; its size is content-dependent and is also `not measured` here.

### KV-cache impact

The static Skill schema is in the **stable prefix** because `CORE_TOOLS` and `getCoreToolDefinitions` assemble it, while available-skill metadata and rendered skill messages **vary** when `skillDiscoveryService` refreshes or filters enabled skills and `executeSkill` adds content mid-session.

### Known limits

The core tool definition does not enumerate every skill. A skill can be disabled, scoped out, unavailable until discovery initializes, or changed on disk; the execution path checks those conditions and may return an error even though the `Skill` schema remains visible.

## Plugin manifest.json

Source files: `src/host/plugins/types.ts`, `src/host/plugins/pluginLoader.ts`, `src/host/plugins/pluginValidator.ts`, `src/host/plugins/pluginRegistry.ts`, `src/host/tools/dispatch/toolDefinitions.ts`.

### What the model sees

`manifest.json` is host metadata, not a tool definition sent directly to the model. `pluginLoader.ts` reads the first available `plugin.json`, `manifest.json`, or `package.json`, normalizes the manifest, and `pluginValidator.ts` validates fields such as the identifier, version, safe relative entry point, permissions, surfaces, and optional UI or internal-feature declarations. `PluginManifest` in `types.ts` describes the same metadata. After activation, `pluginRegistry.ts` registers the plugin's tools or tool modules into the protocol registry (third-party names receive the plugin-id prefix by default); `toolDefinitions.ts` then exposes those registered schemas through the core or deferred tool paths. The model therefore sees each registered tool's name, description, and input schema, not the manifest object itself.

### Token impact

A manifest has no direct request-token charge because it is not sent as a model tool definition. Token cost comes from the schemas of tools that activation registers; the provider-normalized token count for those schemas is `not measured` here. Whether a registered tool is in the core list or deferred is decided by `CORE_TOOLS` and the deferred metadata, not by the manifest's description field.

### KV-cache impact

The manifest object is outside the request prefix, registered tool schemas are in the **stable prefix** when `pluginRegistry.ts` activation and `toolDefinitions.ts` core selection reuse the same registry, and plugin load, activation, reload, or tool registration can **vary** the available schemas for later requests.

### Known limits

Manifest validation does not measure or summarize a plugin's model-facing schema. It also does not guarantee that a declared permission or platform field makes a tool available: activation, registration, capability dependencies, and the core/deferred selection still determine what the model can call.
