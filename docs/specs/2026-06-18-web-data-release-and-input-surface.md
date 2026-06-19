# 2026-06-18 Neo Web Data, Release Verification and Input Surface Spec

> Status: as-built on current repository state
> Time window: 2026-06-18 CST
> Evidence range: `c15e1fb94` through `128afa358`
> Related architecture: [overview.md](../architecture/overview.md), [tool-system.md](../architecture/tool-system.md), [frontend.md](../architecture/frontend.md), [hot-update.md](../architecture/hot-update.md)

This batch makes the default research path more useful out of the box, reduces composer noise, and strengthens release completion checks. The main movement is that basic web data no longer depends on the user having a premium search key configured: Firecrawl becomes the primary search/scrape layer, with native fetch and other configured sources still available as explicit fallbacks or supplements.

## Product Contract

| Area | Contract |
|------|----------|
| Default web data provider | `WebSearch` and `WebFetch` prefer Firecrawl for public web search/scrape. Firecrawl works in keyless mode for basic use and can be disabled with `CODE_AGENT_DISABLE_FIRECRAWL_DEFAULT=1` or `CODE_AGENT_WEB_DATA_PRIMARY/PROVIDER=native`. |
| Native fetch boundary | Local, private-network, `.local`, `.internal`, and raw data URLs such as JSON/CSV/XML/YAML stay on the native fetch path. Firecrawl is a public web extraction layer, not a local network proxy. |
| Search source routing | Intelligent routing starts from `firecrawl` and adds Perplexity, Tavily, Exa, Brave, or OpenAI according to query type, mode, availability, and explicit `sources`. User-specified `sources` still wins. |
| Configured-source discoverability | When premium sources are configured but the router did not use them, `WebSearch` appends a short hint showing the unused sources and an example `sources` override. Firecrawl/cloud infrastructure sources are not included in this hint. |
| Rate-limit and cost transparency | Firecrawl results carry `firecrawl` or `firecrawl-keyless` source labels. Keyless 429/rate-limit errors are annotated with a concrete `FIRECRAWL_API_KEY` setup hint; authenticated failures do not tell the user to configure a key they already have. |
| Firecrawl health gate | Three consecutive Firecrawl transport/HTTP failures put Firecrawl into a 60 second cooldown. During cooldown, search skips Firecrawl and fetch falls back to the native path. A later healthy call automatically clears the failure counter. |
| WebFetch scrape fallback | `fetchDocument()` first tries Firecrawl scrape for public pages, caches successful markdown by original and final URL, then falls back to native fetch with `fallbackReason` recorded when Firecrawl is unavailable. |
| Input recommendation density | Composer recommendations are capped to two skill recommendations and three capability suggestions. Already-shown skill recommendations are filtered from capability chips so the same skill is not displayed twice. |
| Search model guidance | A model with tool-calling capability is treated as search-capable because it can use `WebSearch`. The composer should only suggest switching for search when the model lacks both native search and tool capability. |
| Non-streaming tool-call order | OpenAI-compatible and Claude non-streaming wrappers preserve text preamble and build `contentParts` for tool-call responses, aligning non-streaming rendering with the streaming path and preventing tool blocks from appearing below the answer. |
| Post-publish verification | `release:post-publish` checks app update metadata, release notes, download redirects, `/code-agent/` version slot, renderer rollout envelope, OSS renderer manifest, `release-record.json`, rollback state, and optional Vercel server logs. |
| Runtime diagnostics | `CODE_AGENT_LOG_DIR` can override the default log directory, and Tauri injects this path into the Node webServer runtime so packaged diagnostics and exported logs read the same file sink. |

## Architecture Map

| Layer | Files / Modules | Notes |
|------|------------------|-------|
| Firecrawl client | `src/main/tools/web/firecrawlClient.ts`, `SEARCH_API_ENDPOINTS.firecrawlSearch/firecrawlScrape` | Centralizes keyless/authenticated headers, timeout, rate-limit annotation, URL eligibility, and health cooldown. |
| Search routing | `src/main/tools/web/search/searchStrategies.ts`, `src/main/tools/web/webSearch.ts` | Adds Firecrawl as priority 1, routes by query type, and appends unused premium source hints after successful output. |
| Fetch extraction | `src/main/tools/web/fetchDocument.ts`, `src/main/tools/modules/network/webFetchUnified.ts` | Adds Firecrawl scrape before native fetch while keeping native fallback and cache semantics. |
| MCP/catalog visibility | `src/shared/constants/mcpCatalog.ts`, `src/main/services/cloud/builtinConfig.ts`, `src/main/mcp/mcpDefaultServers.ts` | Firecrawl is visible as the default web data capability and can be enabled from the capability/MCP discovery surfaces. |
| Composer suggestions | `CapabilitySuggestionStrip.tsx`, `useSkillRecommendations.ts`, `modelStrategyRecommendation.ts` | Caps recommendation count, dedupes skill/capability chips, and avoids false search-incapable advice when tool use is available. |
| Provider wrappers | `openaiWrapper.ts`, `anthropicWrapper.ts`, `AssistantMessage.tsx` | Non-streaming tool-use responses now carry ordered `contentParts`; renderer continues to render text/tool interleaving from the shared contract. |
| Release verifier | `scripts/release-post-publish-verify.mjs`, `scripts/release-neo.sh`, `tests/scripts/releasePostPublishVerify.test.ts` | Adds the read-only production verification mode behind `release:post-publish` and `release:neo --post-publish-verify`. |
| Runtime logging | `src/main/services/infra/logger.ts`, `src-tauri/src/main.rs`, `tests/unit/services/infra/logger.logDir.test.ts` | Log location is explicit and overridable, with packaged shell and Node runtime sharing the same directory. |

## Verification Evidence

| Scope | Evidence |
|------|----------|
| Firecrawl routing | `tests/unit/tools/network/searchStrategies.firecrawl.test.ts`, `tests/unit/tools/modules/network/webSearch.test.ts` |
| Firecrawl fetch/scrape | `tests/unit/tools/web/fetchDocument.firecrawl.test.ts` |
| Firecrawl rate-limit and health | `tests/unit/tools/web/firecrawlUsage.test.ts`, `tests/unit/tools/web/firecrawlHealth.test.ts` |
| Unused source hints | `tests/unit/tools/network/unusedSourcesHint.test.ts` |
| Composer recommendation density | `tests/renderer/components/chatInput.modelStrategyRecommendation.test.ts`, `tests/renderer/components/capabilitySuggestionStrip.test.ts` |
| Non-streaming content order | `tests/wrappers/openaiWrapper.test.ts`, `tests/wrappers/anthropicWrapper.test.ts`, renderer message ordering tests |
| Release post-publish verification | `tests/scripts/releasePostPublishVerify.test.ts`, `tests/scripts/releaseMacosGates.test.ts` |
| Logging path | `tests/unit/services/infra/logger.logDir.test.ts` |

## Boundaries

- Firecrawl default does not remove native fetch. Native remains the correct path for local/private/raw data URLs and as fallback when Firecrawl fails.
- Keyless Firecrawl is a convenience path with quota limits. Production stability still depends on a configured `FIRECRAWL_API_KEY`.
- Search hints are advisory. They should not override a user-specified `sources` list or force premium sources into every query.
- The Firecrawl health gate is process-local and short-lived. It is meant to avoid repeated timeout tax, not to persist long-term provider health.
- `release:post-publish` is read-only. It proves live metadata alignment after CI/publish; it does not create tags, upload artifacts, or replace `release:neo --publish`.
- Server log audit only runs when a Vercel log file is provided. Without logs, the verifier still checks public production endpoints but cannot prove the absence of server-side errors.
