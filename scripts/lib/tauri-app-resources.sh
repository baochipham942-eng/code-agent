#!/usr/bin/env bash

resolve_tauri_app_resources_root() {
  local app_path="$1"
  local app_resources_dir="$app_path/Contents/Resources"
  local legacy_resources_root="$app_resources_dir/_up_"

  if [[ -d "$legacy_resources_root" ]]; then
    printf '%s\n' "$legacy_resources_root"
  elif [[ -d "$app_resources_dir/dist" || -d "$app_resources_dir/node_modules" || -d "$app_resources_dir/scripts" ]]; then
    printf '%s\n' "$app_resources_dir"
  else
    echo "[tauri-app-resources] missing bundled resources under $app_resources_dir" >&2
    return 1
  fi
}
