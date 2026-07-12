# Agent Neo Release Checklist

This checklist defines the current formal release contract. Architecture details live in [hot-update.md](../architecture/hot-update.md) and packaged startup semantics live in [desktop-shell.md](../architecture/desktop-shell.md).

## Authority and boundaries

- GitHub Release tag, notes, and immutable assets are the version authority.
- OSS versioned objects and `stable/latest.json` / `stable/release.json` are the distribution authority for Tauri update, in-app update, and download redirects.
- `/api/update` is read-only and derives metadata from the release manifests. There is no independent Cloud update metadata persistence or publish step.
- Renderer rollout has a separate signed control-plane contract. Its manifest, release record, bundle hash, and target app version must agree.
- Local bundles and local smoke evidence do not replace the tag-triggered GitHub Actions release.

## Order

1. Prepare the version files, `CHANGELOG.md`, and `docs/releases/v<version>.md` on a clean branch based on fresh `origin/main`.
2. Run `npm run release:neo -- --version <version>` and resolve every source gate without bypassing signing, runtime asset, renderer, or security invariants.
3. Commit release preparation on `main`. Only with explicit release authorization, run the publish mode that pushes `main` and the annotated tag.
4. The tag workflow builds macOS arm64, macOS x64, and the optional Windows x64 leg; verifies signing/notarization/updater/runtime resources; and creates the GitHub Release.
5. For a stable tag, upload versioned OSS assets, then promote `stable/latest.json` and `stable/release.json`. Pre-release tags must not change stable.
6. Publish renderer bundle and release record before switching the renderer manifest. Serialize publishers per channel and never cancel a publisher after it starts replacing the object set.
7. Run the read-only post-publish verifier against update check/health, arm64+x64 redirects, distribution page, renderer control-plane, OSS manifest, release record, rollback state, and production logs.
8. Run packaged desktop smoke with an isolated app/data/HOME. The default 120-second gate must reach `window-navigated`, `webHealth=ok`, boot-token match, and zero missing required resources. Remote plugins, skills, and MCP initialize in the background; `onnxruntime-vad` and `playwright-browser-runtime` remain optional warnings.

## Completion evidence

A release is complete only when commit, peeled tag, GitHub Release, OSS stable manifests, renderer rollout, install assets, and production probes all identify the target version. Record CI run ids, artifact hashes, packaged smoke JSON, post-publish JSON, and any warning that remains.

Do not turn a source gate, skipped secret, local package, stale build, or compatibility response into a PASS. Do not infer rollback from a verifier-contract mismatch when the current signed distribution and stable manifests remain healthy.

## Rollback boundary

Rollback is a separately authorized production action. Prefer a superseding hotfix after users may have seen a release. If stable distribution must be withdrawn, restore both `stable/latest.json` and `stable/release.json` from the same last-known-good version, verify update/download paths, and align renderer rollback state deliberately. Do not delete or retag an existing release, overwrite user data, or treat a schema downgrade as safe without a tested data rollback path.
