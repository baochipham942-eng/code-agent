#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

REMOTE="${REMOTE:-origin}"
REPO="${GITHUB_REPOSITORY:-}"
VERSION=""
PUBLISH=0
LOCAL_BUNDLE=0
RUN_GATES=1
CHECK_LOCAL_ENV=0
WAIT_CI=0
YES=0
POST_PUBLISH_VERIFY=0
POST_PUBLISH_ARGS=()

usage() {
  cat <<'EOF'
Usage:
  npm run release:neo -- --version 0.17.0
  npm run release:neo -- --version 0.17.0 --publish --yes
  npm run release:neo -- --version 0.17.0 --publish --wait-ci
  npm run release:neo -- --version 0.17.0 --local-bundle

Modes:
  default         Check source-side release readiness. No tag, push, or build.
  --publish      Create v<version> tag if missing, then push main and the tag.
  --local-bundle Debug the notarized local Tauri bundle chain. This is not the formal release path.

Options:
  --version <v>  Expected semver. Defaults to package.json version.
  --skip-gates   Skip source-side read-only release gates.
  --check-local-env
                 Also require local updater and control-plane release env.
  --wait-ci      After pushing the tag, wait for .github/workflows/release.yml.
  --post-publish-verify
                 Run read-only production checks after CI/publish has completed.
  --server-log-file <file>
                 Vercel log export for --post-publish-verify.
  --require-server-log-audit
                 Fail post-publish verify when server logs are not provided.
  --require-cloud-api-metadata
                 Fail post-publish verify when update health uses GitHub fallback.
  --repo <repo>  GitHub repo, owner/name. Defaults to origin or GITHUB_REPOSITORY.
  --remote <r>   Git remote to push. Defaults to origin.
  --yes          Do not prompt before --publish.
EOF
}

log() {
  printf '[release-neo] %s\n' "$*"
}

fail() {
  printf '[release-neo][FAIL] %s\n' "$*" >&2
  exit 1
}

read_arg_value() {
  local name="$1"
  local value="${2:-}"
  if [[ -z "${value}" || "${value}" == --* ]]; then
    fail "${name} requires a value"
  fi
  printf '%s\n' "${value}"
}

while (($# > 0)); do
  case "$1" in
    --version)
      VERSION="$(read_arg_value "$1" "${2:-}")"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --publish)
      PUBLISH=1
      shift
      ;;
    --local-bundle)
      LOCAL_BUNDLE=1
      shift
      ;;
    --skip-gates)
      RUN_GATES=0
      shift
      ;;
    --check-local-env)
      CHECK_LOCAL_ENV=1
      shift
      ;;
    --wait-ci)
      WAIT_CI=1
      shift
      ;;
    --post-publish-verify)
      POST_PUBLISH_VERIFY=1
      shift
      ;;
    --server-log-file)
      POST_PUBLISH_VERIFY=1
      POST_PUBLISH_ARGS+=("--server-log-file" "$(read_arg_value "$1" "${2:-}")")
      shift 2
      ;;
    --server-log-file=*)
      POST_PUBLISH_VERIFY=1
      POST_PUBLISH_ARGS+=("--server-log-file" "${1#*=}")
      shift
      ;;
    --require-server-log-audit)
      POST_PUBLISH_VERIFY=1
      POST_PUBLISH_ARGS+=("--require-server-log-audit")
      shift
      ;;
    --require-cloud-api-metadata)
      POST_PUBLISH_VERIFY=1
      POST_PUBLISH_ARGS+=("--require-cloud-api-metadata")
      shift
      ;;
    --repo)
      REPO="$(read_arg_value "$1" "${2:-}")"
      shift 2
      ;;
    --repo=*)
      REPO="${1#*=}"
      shift
      ;;
    --remote)
      REMOTE="$(read_arg_value "$1" "${2:-}")"
      shift 2
      ;;
    --remote=*)
      REMOTE="${1#*=}"
      shift
      ;;
    --yes|-y)
      YES=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

cd "${ROOT_DIR}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"
}

json_top_version() {
  local file="$1"
  node -e 'const fs=require("node:fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!data.version) process.exit(2); process.stdout.write(String(data.version));' "${file}"
}

package_lock_root_version() {
  node -e 'const fs=require("node:fs"); const data=JSON.parse(fs.readFileSync("package-lock.json", "utf8")); const value=data.packages && data.packages[""] && data.packages[""].version; if (!value) process.exit(2); process.stdout.write(String(value));'
}

repo_from_remote() {
  local url
  url="$(git remote get-url "${REMOTE}" 2>/dev/null || true)"
  if [[ "${url}" =~ github.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
    printf '%s/%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi
  return 1
}

resolve_version() {
  local package_version
  package_version="$(json_top_version package.json)"
  if [[ -z "${VERSION}" ]]; then
    VERSION="${package_version}"
  fi
  if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
    fail "Invalid version: ${VERSION}"
  fi
  if [[ "${VERSION}" != "${package_version}" ]]; then
    fail "package.json version is ${package_version}, expected ${VERSION}"
  fi
}

verify_version_files() {
  local tauri_version lock_version lock_root_version release_notes
  tauri_version="$(json_top_version src-tauri/tauri.conf.json)"
  lock_version="$(json_top_version package-lock.json)"
  lock_root_version="$(package_lock_root_version)"
  release_notes="docs/releases/v${VERSION}.md"

  [[ "${tauri_version}" == "${VERSION}" ]] || fail "src-tauri/tauri.conf.json version is ${tauri_version}, expected ${VERSION}"
  [[ "${lock_version}" == "${VERSION}" ]] || fail "package-lock.json version is ${lock_version}, expected ${VERSION}"
  [[ "${lock_root_version}" == "${VERSION}" ]] || fail "package-lock root version is ${lock_root_version}, expected ${VERSION}"
  [[ -s "${release_notes}" ]] || fail "Missing release notes: ${release_notes}"
}

verify_worktree_for_publish() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    git status --short
    fail "Tracked worktree changes exist. Commit the release prep before --publish."
  fi
  local branch
  branch="$(git branch --show-current)"
  [[ "${branch}" == "main" ]] || fail "--publish must run from main, current branch is ${branch}"
}

run_gate() {
  local label="$1"
  shift
  log "gate: ${label}"
  "$@"
}

run_source_gates() {
  if [[ "${RUN_GATES}" -eq 0 ]]; then
    log "source gates skipped by --skip-gates"
    return 0
  fi
  run_gate "parse package and tauri config" node -e "JSON.parse(require('node:fs').readFileSync('package.json','utf8')); JSON.parse(require('node:fs').readFileSync('src-tauri/tauri.conf.json','utf8'));"
  if [[ "${CHECK_LOCAL_ENV}" -eq 1 ]]; then
    run_gate "local production env shape" node scripts/verify-production-env.mjs --mode local
  else
    log "gate: local production env shape (skipped; pass --check-local-env to require local release secrets)"
  fi
  run_gate "release shell syntax" bash -c 'for script in "$@"; do bash -n "$script"; done' bash scripts/release-neo.sh scripts/tauri-release-bundle.sh scripts/tauri-notarize.sh scripts/verify-macos-release.sh scripts/publish-release.sh
  run_gate "release gate tests" npx vitest run tests/scripts/verifyProductionEnv.test.ts tests/scripts/releaseMacosGates.test.ts
  run_gate "release security scan" npm run release:security-scan
}

confirm_publish() {
  if [[ "${PUBLISH}" -ne 1 || "${YES}" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -t 0 ]]; then
    fail "--publish in a non-interactive shell requires --yes"
  fi
  local expected="release v${VERSION}"
  local answer
  printf '[release-neo] Type "%s" to push main and tag v%s: ' "${expected}" "${VERSION}" >&2
  read -r answer
  [[ "${answer}" == "${expected}" ]] || fail "Publish aborted"
}

create_or_verify_tag() {
  TAG="v${VERSION}"
  HEAD_SHA="$(git rev-parse HEAD)"
  if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    local tag_sha
    tag_sha="$(git rev-list -n 1 "${TAG}")"
    [[ "${tag_sha}" == "${HEAD_SHA}" ]] || fail "Local tag ${TAG} points at ${tag_sha}, not HEAD ${HEAD_SHA}"
    log "tag exists locally: ${TAG}"
  else
    log "creating annotated tag: ${TAG}"
    git tag -a "${TAG}" -m "Release ${TAG}"
  fi

  local remote_tag
  remote_tag="$(git ls-remote --tags "${REMOTE}" "refs/tags/${TAG}" | awk '{print $1}' | head -n 1 || true)"
  [[ -z "${remote_tag}" ]] || fail "Remote tag ${TAG} already exists on ${REMOTE}"
}

publish_tag_release() {
  confirm_publish
  create_or_verify_tag
  log "pushing main"
  git push "${REMOTE}" main
  log "pushing ${TAG}"
  git push "${REMOTE}" "${TAG}"
}

run_local_bundle() {
  log "local bundle debug path: this does not publish"
  run_gate "notarized production env shape" node scripts/verify-production-env.mjs --mode notarized
  REQUIRE_NOTARIZATION=1 npm run tauri:release:bundle
}

wait_for_ci() {
  if [[ "${WAIT_CI}" -ne 1 ]]; then
    return 0
  fi
  [[ -n "${REPO}" ]] || fail "Cannot resolve GitHub repo for --wait-ci; pass --repo owner/name"
  log "waiting for ${REPO}/.github/workflows/release.yml at ${HEAD_SHA}"
  node scripts/verify-github-workflow-run.mjs \
    --repo "${REPO}" \
    --workflow release.yml \
    --head-sha "${HEAD_SHA}" \
    --event push \
    --timeout-ms 7200000 \
    --poll-ms 60000
}

run_post_publish_verify() {
  if [[ "${POST_PUBLISH_VERIFY}" -ne 1 ]]; then
    return 0
  fi
  local post_publish_cmd=(npm run release:post-publish -- --version "${VERSION}")
  if ((${#POST_PUBLISH_ARGS[@]} > 0)); then
    post_publish_cmd+=("${POST_PUBLISH_ARGS[@]}")
  fi
  run_gate "post-publish production verification" "${post_publish_cmd[@]}"
}

main() {
  require_command git
  require_command node
  require_command npm

  resolve_version
  if [[ -z "${REPO}" ]]; then
    REPO="$(repo_from_remote || true)"
  fi

  log "version: ${VERSION}"
  log "repo: ${REPO:-unknown}"
  verify_version_files
  run_source_gates

  if [[ "${LOCAL_BUNDLE}" -eq 1 ]]; then
    run_local_bundle
  fi

  if [[ "${PUBLISH}" -eq 1 ]]; then
    verify_worktree_for_publish
    publish_tag_release
    wait_for_ci
  fi

  run_post_publish_verify

  if [[ "${PUBLISH}" -ne 1 ]]; then
    log "ready check passed; no tag or push was performed"
  fi
}

main "$@"
