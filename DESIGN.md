---
version: alpha
name: Agent Neo Product Design Contract
description: Agent-facing design contract for the Agent Neo desktop shell, web container, session workbench, design canvas, settings, and runtime states.
colors:
  primary: "#0F766E"
  on-primary: "#FFFFFF"
  canvas: "#101012"
  surface: "#18181B"
  surface-elevated: "#1F1F23"
  text: "#F4F4F5"
  text-muted: "#A1A1AA"
  border: "rgba(255, 255, 255, 0.08)"
  focus: "rgba(255, 255, 255, 0.22)"
  success: "#4ADE80"
  warning: "#FBBF24"
  danger: "#F87171"
  info: "#60A5FA"
typography:
  body:
    fontFamily: Inter, Source Han Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.01em
  label:
    fontFamily: Inter, Source Han Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: -0.01em
  heading:
    fontFamily: Inter, Source Han Sans, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: -0.01em
  code:
    fontFamily: JetBrains Mono, SF Mono, Fira Code, Menlo, Monaco, Courier New, monospace
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
rounded:
  sm: 2px
  md: 4px
  lg: 6px
  xl: 8px
  xxl: 12px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  section: 32px
components:
  workbench-canvas:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: 8px
    height: 36px
  field-default:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 36px
  metadata-text:
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  focus-indicator:
    backgroundColor: "{colors.focus}"
    size: 2px
  status-success:
    textColor: "{colors.success}"
    typography: "{typography.label}"
  status-warning:
    textColor: "{colors.warning}"
    typography: "{typography.label}"
  status-info:
    textColor: "{colors.info}"
    typography: "{typography.label}"
  status-danger:
    textColor: "{colors.danger}"
    typography: "{typography.label}"
---

# Agent Neo Product Design Contract

## Overview

This file governs the authenticated Agent Neo product workspace at source baseline `codex/repository-structure@57c0489cea89cfb6b40ea0ffcea3c5b635f18eed`. It covers five related but distinct surfaces:

1. **Desktop shell**: the current native shell is Tauri 2.x. Legacy Electron bridge names and `electronMock` are compatibility infrastructure, not the current product shell.
2. **Web container**: the bundled Node web server serves the same React renderer and owns active, built-in, or static renderer selection. Browser delivery must preserve information architecture while explaining unavailable native capabilities.
3. **Agent session workbench**: session history, turn-based conversation, composer, tool activity, task/runtime rails, and the optional right workbench.
4. **Design mode and canvas**: a conversation-connected design surface with prototype preview, infinite canvas, selection, layers, variants, review gates, and export.
5. **Settings and runtime state**: full-screen settings, capability availability, diagnostics, updates, permissions, and run state.

The public marketing surface and `admin-console/` are outside this contract. Generated artifacts inside prototype iframes or canvas nodes may have their own design direction; they must not silently redefine the Agent Neo application chrome.

The source of truth is, in order: executable renderer and theme code at the pinned commit; stable architecture documents; repeated component behavior and tests; then screenshots. Existing screenshots are historical evidence and lose when they conflict with current executable code.

### Classification and reuse boundary

| Classification | Owns | Must not own |
| --- | --- | --- |
| **Shared foundation** | Semantic theme roles, typography, spacing, radii, elevation, focus, overlays, base controls, empty/loading/error/disabled behavior, responsive helpers | Agent, repo, session, tool, shell, or canvas domain semantics |
| **Product-family pattern** | Conversation turns, composer capability selection, tool activity, run evidence, artifact disclosure, approval-in-flow, editor/canvas selection patterns | Agent Neo routes, native bridge calls, release/update logic, local storage paths |
| **Project-specific rule** | Agent Neo shell composition, Tauri/Web capability gating, sidebar/session semantics, exact workbench tabs, design-run persistence, canvas operations, release and diagnostics language | Portable tokens or generic primitive behavior |

Recommended package boundary:

- **Shared foundation, planned**: `@linchen/ui-foundation` should own semantic tokens and theme adapters, typography/spacing/radius/elevation scales, accessible `Button`, `IconButton`, fields, `Modal`, `Badge`, `EmptyState`, focus/overlay contracts, and responsive utilities. It must not import Agent Neo contracts.
- **Product-family pattern, planned**: `@linchen/agent-workbench` should consume `@linchen/ui-foundation` and own presentational contracts for turn groups, tool activity, run/status rails, composer capability choices, approvals, artifacts, and evidence disclosure. It must accept domain DTOs or adapters and must not call Tauri, Electron, IPC, or filesystem APIs.
- **Project-specific rule, live locally**: Agent Neo keeps shell chrome, platform detection, IPC facades, session/repo wording, task and workbench composition, design canvas persistence, model operations, and settings policy. Repo Insight and Person Agent may consume the two shared layers while retaining their own navigation and domain language.

Neither shared package exists at this baseline. Extraction starts only after a local contract is stable, visually accepted in at least two products, and free of Agent Neo-specific imports.

### Borrowing map

The linked community `DESIGN.md` files are **unofficial analyses of public product interfaces**, not official company design systems. They are capability references only.

| Reference | Borrowed capability | Local adaptation | Excluded identity |
| --- | --- | --- | --- |
| [Linear, unofficial community analysis](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/linear.app/DESIGN.md) | Dense hierarchy, restrained surfaces, keyboard-oriented workbench | Quiet zinc surface ladder, compact labels, collapsible panels, persistent navigation | Brand colors, logos, assets, typography identity, complete visual system |
| [Cursor, unofficial community analysis](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/cursor/DESIGN.md) | Context-bound AI work, compact tool and diff states | Tool calls expose action, target, status, result, and recoverability inside the conversation turn | Editor chrome, brand colors, icons, proprietary assets, complete visual identity |
| [Claude, unofficial community analysis](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/claude/DESIGN.md) | Readable AI output, trust through restrained disclosure, calm running feedback | Assistant text remains primary; reasoning and tool detail reveal progressively; escalated failures stay visible | Warm brand palette, type identity, logos, conversational copy identity |
| [Figma, unofficial community analysis](https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/figma/DESIGN.md) | Canvas camera, selection, layers, compact contextual controls | Media-agnostic canvas, synchronized layer selection, proposal ghosts, human review before mutation | Brand colors, toolbar cloning, proprietary icons/assets, full property inspector, complete editor identity |

### Implementation status

| Surface or contract | Status | Evidence and boundary |
| --- | --- | --- |
| Dark and light semantic themes | **Live** | `src/renderer/styles/themes/{dark,light}.css`, `src/renderer/hooks/useTheme.ts` |
| High-contrast token files | **Planned / unresolved** | Token files and contrast checks exist, but `useTheme` exposes only dark, light, and system, and `global.css` imports only dark/light |
| Shared spacing, radii, type, motion tokens | **Live** | `src/renderer/styles/global.css`, mapped by `tailwind.config.js` |
| Primitive controls and display states | **Live with migration debt** | `src/renderer/components/primitives/`; the design-system ratchet still records legacy bare buttons and hand-built modals |
| Tauri desktop shell + bundled web server | **Live** | `docs/architecture/desktop-shell.md`, `src-tauri/`, `src/web/webServer.ts` |
| Legacy Electron compatibility | **Live compatibility only** | `src/web/electronMock.ts`, bridge aliases in renderer services; do not design new Electron-only UI |
| Browser/Web fallback | **Live, capability-limited** | `src/renderer/utils/platform.ts`, `WebModeBanner`, disabled native actions in settings |
| Session workbench and turn-based trace | **Live** | `App.tsx`, `ChatView.tsx`, `TurnCard.tsx`, `ToolCallDisplay/`, `docs/architecture/workbench.md` |
| Design workspace, canvas, selection, layers, review gates | **Live** | `DesignWorkspace.tsx`, `DesignCanvas.tsx`, `DesignLayerPanel.tsx`, `docs/architecture/design-mode.md` |
| Narrow desktop collapse | **Live, partial** | Sidebar auto-collapses below 1180px; side workbench becomes unavailable below 900px and selected content may replace chat |
| Touch/mobile application layout | **Unresolved** | A 768px CSS token collapse exists, but no complete mobile navigation, settings, canvas, or touch contract is implemented |
| Focus management and keyboard accessibility | **Partial / unresolved** | Global focus styles, ARIA labels, Escape handling, and canvas shortcuts exist; several controls suppress outlines and the base modal focuses its container without a complete focus loop |
| `@linchen/ui-foundation` and `@linchen/agent-workbench` | **Planned** | No package or import exists at the pinned baseline |

## Colors

### Shared foundation

- Use semantic roles, never zinc or brand names, at the cross-project boundary: `canvas`, `surface`, `surface-elevated`, `text`, `text-muted`, `border`, `focus`, `success`, `warning`, `danger`, and `info`.
- The frontmatter records the live default dark theme. Runtime theme adapters map those roles to CSS variables such as `--bg-void`, `--bg-surface`, `--text-primary`, and `--border-default`.
- Dark and light themes must preserve meaning, not literal color. The live light mapping uses `#FFFFFF` canvas, `#F4F4F5` surface, `#18181B` primary text, and the same `#0F766E` primary action anchor.
- Status color is never the only carrier of meaning. Pair it with text, an icon or symbol, and persistent status language.
- Success means completed or healthy; warning means degraded, blocked, pending review, or recoverable risk; danger means destructive action or user-relevant failure; info means neutral guidance or active context.
- Keep application chrome predominantly neutral. Brand color indicates primary action, selection, focus, or a small active anchor; it does not decorate whole panels.
- Theme contrast is a release property. Keep the existing `check-design-system --contrast` scenarios at or above WCAG AA for their actual foreground/background use.

### Product-family pattern

- Conversation content uses neutral text hierarchy. Tool success dots and run rails may use semantic color at low visual weight; an assistant answer remains visually dominant.
- Exploratory tool failures stay neutral when the agent can recover. Authentication, quota, permission, destructive, or user-action-required failures use warning/danger treatment and a recovery statement.
- Approval and proposed-change surfaces use a preview color distinct from committed selection. On the canvas, ghost proposals must not look already applied.

### Project-specific rule

- Agent Neo may retain local accents such as fuchsia for design mode, emerald for Neo identity/chosen output, and terminal-style `--cc-*` tokens. These accents do not enter shared foundations without cross-product validation.
- Generated artifacts may use their own palette inside the iframe or node. Their palette must not leak into shell navigation, settings, or runtime status.
- High-contrast files remain non-normative until users can select them and representative workbench, settings, and canvas screens are visually verified.

## Typography

### Shared foundation

- The application stack is `Inter`, `Source Han Sans`, platform UI fonts, then generic sans-serif. Never require a proprietary font for core operation.
- Body text is 14px/1.5 by default. Compact metadata and labels use 12–13px; headings use 18–24px with 600 weight. Do not create oversized landing-page headings inside operational workspaces.
- Use the monospace stack only for code, commands, paths, identifiers, tool output, coordinates, and duration data. Product explanations and statuses stay in the UI font.
- Chinese and English must fit the same hierarchy. Avoid fixed-width labels that only work in one language; truncate navigation and paths with a tooltip or accessible full value when the complete text matters.
- Keep reading content selectable. Shell chrome is non-selectable by default, while chat prose, code, inputs, and editable content opt back into text selection.

### Product-family pattern

- Assistant output owns the reading rhythm: comfortable line height, selectable prose, code blocks, and a constrained readable width where possible.
- Tool activity is compact and monospace-led. The primary line answers what happened; secondary metadata answers where, how long, and with what result.
- Runtime labels describe user-observable state. Internal SDK, adapter, or pipeline names appear only in developer detail.

### Project-specific rule

- Agent Neo session, repo, model, branch, path, token, cost, and run identifiers may use monospace or tabular numerals where scanning benefits.
- Settings page titles use the current 20–24px workbench scale; settings sections use 14px headings and 12–13px explanations.

## Layout

### Shared foundation

- Use a 4px spacing base. Prefer 4, 8, 12, 16, 20, 24, 32, 40, and 48px values already present in `global.css`.
- Every screen has one scroll owner per axis. Sticky headers, composers, status rails, and review bars must not create nested scrolling traps.
- Operational pages use the full viewport; reading and form content inside them uses a controlled maximum width. Avoid centering every workspace in a card.
- At narrow widths, preserve the current task and primary action before secondary navigation. Collapse, replace, or move secondary panels; never squeeze chat, canvas, and inspector into unusable columns.
- Touch/mobile behavior is not inferred from desktop collapse. Any future mobile surface requires explicit navigation, minimum target sizes, safe areas, keyboard behavior, and canvas gestures.

### Product-family pattern

- Agent workbench composition is conversation-first: navigation/history on the left when space permits, the complete conversation and composer in the primary pane, and task/files/preview/evidence in one optional right host.
- The right workbench is one tabbed region, not several panels competing for width. Opening a high-value preview on a narrow viewport may temporarily replace chat, but the return path must remain obvious and preserve draft/run state.
- Run status appears close to the conversation it explains. It should appear only when background, queued, approval, team, workflow, or goal state exists.
- Approvals belong in the flow near the action they gate. Side panels may summarize but do not become the only place to approve or understand a run.

### Project-specific rule

- Agent Neo desktop uses a 240px sidebar and a shared 44px header contract. The right panel defaults to roughly 32% and stays between 15% and 45% when visible.
- Below 1180px, default the sidebar closed. Below 900px, do not render a simultaneous right workbench; preview/audit/project surfaces may take the primary pane. Below 768px, current CSS only removes reserved sidebar/task widths and must not be presented as complete mobile support.
- Settings are a full-screen route-like surface with a 280px navigation rail and content widths of roughly `max-w-4xl` or `max-w-6xl`. A compact settings navigation is unresolved and must be designed before claiming narrow-screen support.
- Design mode has two placements: a workbench canvas tab connected to conversation, and an explicit full-screen design workspace. The full-screen workspace separates composer/brief controls from preview/canvas and must preserve an obvious exit back to the session.
- Prototype preview may offer desktop, tablet (768px), and mobile (375px) frames. Those frames validate the generated artifact, not Agent Neo's own application responsiveness.

## Elevation & Depth

### Shared foundation

- Build depth in this order: background step, 1px semantic border, then shadow. Do not use shadow as the only boundary in a dense dark workspace.
- Base canvas, surface, and elevated surface are the stable three-layer hierarchy. Hover and active colors are transient states, not new permanent surfaces.
- Use overlays for modal focus, drag targets, full-screen preview, or temporary review. Backdrops must retain enough context to explain what is being blocked.
- Z-order is governed centrally. New arbitrary z-index values require a documented layer role and the repository allowlist; do not solve collisions by escalating numbers.
- Blur is optional support for temporary overlays and floating canvas tools. Glass is not a general panel style.

### Product-family pattern

- Tool details expand within their turn instead of floating above the conversation. Result summaries may reveal on hover or expansion but must remain reachable by keyboard.
- Running, queued, and approval rails stay visually lighter than the final answer. Escalated errors and required decisions may rise one layer.
- Evidence, artifacts, and previews may occupy the right workbench but retain a visible link to the originating turn.

### Project-specific rule

- Canvas layers, contextual editors, proposal bars, and autonomy bars float above the Konva stage. Busy overlays block stage mutation only during actual application of a proposal, while approval controls remain operable.
- Desktop title bar, native permission prompts, updater UI, and system windows are shell-owned. The React renderer must not imitate native elevation when a native surface already owns the action.

## Shapes

### Shared foundation

- Use the live radius scale: 2px for code chips and tiny badges, 4px for fields and compact controls, 6–8px for panels and normal buttons, 12px for large dialogs or high-emphasis containers.
- Pills and circles are reserved for avatars, status dots, compact badges, toggles, and genuinely continuous controls. Do not turn every label or button into a pill.
- Icons use Lucide's line geometry by default. Icon-only controls require an accessible name and a tooltip where meaning is not universal.
- A compact desktop control may remain below mobile touch size. Any touch/mobile surface must define and verify its own target-size contract rather than enlarging the whole desktop UI.

### Product-family pattern

- Conversation and tool activity should read as a continuous trace, not a stack of unrelated rounded cards. Use cards only for approvals, artifacts, bounded evidence, and meaningful grouped state.
- Selected, focused, and proposed are distinct shapes/strokes: selected is committed, focused is keyboard/camera attention, proposed is a ghost or dashed preview.

### Project-specific rule

- Canvas nodes retain media geometry; layer rows and inspector controls are compact. Do not clone Figma's complete property panel or toolbar geometry.
- Hard delete and soft discard must look different. Soft-discarded nodes remain recoverable and visually de-emphasized; hard delete uses destructive language and treatment.

## Components

### Shared foundation

- New controls use the shared primitives in `src/renderer/components/primitives/` or their future `@linchen/ui-foundation` equivalents. Local variants are allowed only when the shared contract cannot express a verified product need.
- Every interactive component defines default, hover, active, focus-visible, disabled, loading, error, selected, and destructive behavior as applicable. Disabled controls keep their reason discoverable; loading controls preserve their label or accessible name.
- Focus-visible must be perceivable on every keyboard-reachable control. Do not combine `focus:outline-hidden` with no replacement ring. Modal/dialog focus must enter the dialog, remain within it while open, close on Escape when safe, and return to the trigger.
- Prefer semantic `Button`, `IconButton`, fields, `Modal`, `Badge`, and `EmptyState`. Do not add a fifth empty-state shape until the four existing roles fail a real use case.
- Use skeleton/shimmer only where the layout is known. Use a quiet progress indicator for indeterminate agent work, a clear empty state for no data, an inline recovery path for errors, and explicit selected/disabled states.

### Product-family pattern: session workbench

- A turn groups the user's request, run header, optional hook/skill activity, assistant reasoning disclosure, tool groups, artifacts, and final answer. Preserve chronological truth even when details are folded.
- Completed long turns may fold intermediate activity behind a duration summary. The user request and final answer remain visible; expansion restores the full trace.
- The composer is anchored at the bottom of the conversation. Capability, routing, workspace, attachment, queue, and stop controls stay adjacent to the message they affect rather than becoming global hidden settings.
- New-session guidance is a workbench welcome state, not a marketing hero. Show project inheritance only when a workspace actually exists; avoid decorative capability cards that compete with the composer.
- Runtime state distinguishes waiting, thinking, streaming, tool-running, queued, interrupted, completed, degraded, and failed. Never collapse all active states into one spinner.

### Product-family pattern: tool calls and evidence

- A collapsed tool row answers status plus user-readable action. When available, show target context and semantic short description before raw tool name and parameters.
- Pending tools may auto-expand for live output. Successful tools collapse after completion unless the user chose otherwise. Exploratory failures remain compact; user-action-required failures retain a visible warning and recovery hint.
- Raw command, full path, arguments, output, rationale, and timing are progressive detail. Never hide the final outcome, permission decision, destructive scope, or recovery action inside hover-only content.
- Tool groups and evidence surfaces remain associated with their originating turn and session. File artifacts open in the shared preview workbench rather than inventing a separate report page.

### Project-specific rule: shell and Web fallback

- The Tauri shell owns native window lifecycle, tray/global shortcut behavior, updater boundary, permissions, bundled resources, and native diagnostics. Renderer components call typed facades, not raw native command names.
- The web server owns renderer selection and serves active, built-in, or static bundles. An active bundle replaces built-in UI only after metadata, compatibility, and resource checks pass.
- Web mode preserves navigation, conversation, reading, and supported configuration. Native-only actions are disabled or replaced with an explanatory banner; never render a control that appears successful while no native bridge exists.
- Legacy Electron API aliases are compatibility seams. New product behavior targets the platform facade and must work in Tauri or degrade explicitly in Web.

### Project-specific rule: design canvas, selection, and layers

- `canvas.json` on disk is the visual truth source. Persist the selected run pointer, then reload nodes and camera from disk; do not create a second durable state in local storage.
- Canvas selection and layer selection are one state. Clicking a layer selects the node; focusing a layer recenters the camera; canvas selection updates the layer inspector.
- Space-drag or middle-drag pans; wheel intent distinguishes pan and zoom; zoom remains clamped. Delete/Backspace removes selected nodes only when focus is not inside an editable control.
- Multi-select is additive with Shift or platform modifier. Two selected comparable nodes may expose A/B comparison; selection context may enter the next design request.
- Agent-proposed operations render as ghosts and require apply/reject review unless an explicit, budgeted autonomy envelope is active. Manual edits must not be lost when a proposal completes.
- Layer UI exposes identity, media kind, reference/output role, chosen/discarded state, bounds, cost, parent, focus, rename, choose, discard, and delete through progressive disclosure. It does not become a full layout/property editor.
- Prototype preview keeps injected selection/edit scripts separate from canonical HTML. Editing writes the canonical artifact; preview-only theme or device framing never contaminates exported source.

### Project-specific rule: settings and runtime state

- Settings are task-grouped, searchable, and permission-aware. Put durable preferences in settings; keep message-level routing and capability choices at the composer.
- Model/provider configuration uses master-detail structure when density requires it. Connection, credential, health, and default status remain distinguishable.
- Desktop-only settings such as update, screen memory, native desktop, and local integration disclose their platform requirement. Web mode must not silently save unsupported changes.
- Diagnostics present stable stages, issue severity, last-known state, and low-risk repair actions without exposing secrets, raw tokens, cookies, or signing material.

## Do's and Don'ts

### Do

- **Shared foundation**: map design decisions to semantic CSS variables and primitives; run token integrity, contrast, and design-system ratchet checks when foundations change.
- **Shared foundation**: preserve keyboard focus, reduced-motion fallbacks, text selection in content, accessible names, and status text alongside color.
- **Product-family pattern**: keep the session conversation as the narrative spine and reveal tools, evidence, approvals, and artifacts in context.
- **Product-family pattern**: use progressive disclosure so routine successful work is compact while decisions, escalated failures, and final outcomes stay visible.
- **Project-specific rule**: keep desktop shell, Web container, session workbench, and design canvas boundaries explicit in code and UI copy.
- **Project-specific rule**: validate both desktop widths and the named narrow thresholds. Treat mobile/touch as unresolved until its own navigation and interaction contract is implemented.
- **Project-specific rule**: keep canvas proposals reversible, selection synchronized, destructive actions explicit, and disk persistence authoritative.
- Update this contract only after a rule is verified against executable product behavior. Record planned or unresolved states instead of describing intent as live.

### Don't

- Do not infer the whole system from `global.css`, a single polished screen, or an old screenshot.
- Do not describe the current desktop app as Electron; the pinned source uses Tauri, with legacy Electron compatibility seams.
- Do not copy Linear, Cursor, Claude, or Figma brand colors, assets, trademarks, typography identity, or complete visual systems.
- Do not add generic purple-blue gradients, glass panels, nested cards, oversized landing-page headings, decorative status color, or unapproved fonts to operational surfaces.
- Do not spread the existing primary-button gradient into panels or shared foundations. The coexistence of solid `.btn-primary` and gradient `Button` is migration drift to resolve through visual acceptance.
- Do not add raw hex values outside theme definitions, isolated visualizations/canvas rendering, or sandboxed artifact HTML with a documented exemption.
- Do not add bare buttons, hand-built modal backdrops, arbitrary pixel radii, arbitrary z-index, or local `Badge`/`EmptyState` clones when a primitive applies.
- Do not hide required permission, destructive scope, escalated failure, final outcome, or recovery action in hover-only or collapsed detail.
- Do not claim high-contrast themes, full modal focus trapping, or mobile application support as live until the corresponding runtime wiring and representative visual/keyboard tests exist.
- Do not move Agent Neo routes, native calls, release state, design-run paths, or domain copy into `@linchen/ui-foundation` or `@linchen/agent-workbench`.

### Governance and verification

- Normative token source: `src/renderer/styles/global.css`, `src/renderer/styles/themes/*.css`, and `tailwind.config.js`.
- Executable component source: `src/renderer/components/primitives/` plus representative workbench, chat, settings, and design components.
- Design-system ratchet: `node scripts/check-design-system.mjs`.
- Token completeness: `node scripts/check-token-integrity.mjs`.
- Contrast scenarios: `node scripts/check-design-system.mjs --contrast`.
- DESIGN.md schema: `npx @google/design.md lint DESIGN.md`; record the tool version because the format is pre-stable.
- A shared extraction is accepted only after the local visual behavior is live, keyboard and state behavior are verified, and at least one additional product consumes the same contract without Agent Neo-specific adapters leaking into the foundation.
