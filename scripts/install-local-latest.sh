#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to build from a dirty checkout. Commit or stash local changes first." >&2
  exit 1
fi

head="$(git rev-parse HEAD)"
short_head="$(git rev-parse --short HEAD)"
version="0.0.0-local-$(date -u +%Y%m%d%H%M%S)-${short_head}"
install_root="${HOME}/Library/Application Support/ChatGPT Tela"
bin_root="${install_root}/bin"
installed_launcher="${bin_root}/chatgpt-tela"
installed_manifest="${bin_root}/chatgpt-tela-package-v1.json"

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/chatgpt-tela-local-install.XXXXXX")"
cleanup() {
  rm -rf -- "$tmp_root"
}
trap cleanup EXIT INT TERM

native_metadata="$tmp_root/native-engine-metadata.json"
payload="$tmp_root/payload"

echo "Building Tela from ${head} (${version})"
"$(command -v bun)" install --frozen-lockfile

build_args=(
  run apps/package-build/src/main.ts
  --output "$payload"
  --version "$version"
)

if [[ "$(uname -s)" == "Darwin" ]]; then
  build_args+=(--mac-codesign-identity -)
fi

workspace_helper="$bin_root/helpers/tela-workspace-files"
native_engine="$bin_root/native-engine/codex"
native_helper="$bin_root/native-engine/codex-code-mode-host"
if [[ -f "$installed_manifest" ]]; then
  if [[ ! -f "$native_engine" || ! -f "$native_helper" ]]; then
    echo "The installed Native engine is incomplete; refusing to build a package that drops it." >&2
    exit 1
  fi
  node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!m.nativeEngine) throw new Error("installed package has no nativeEngine metadata"); fs.writeFileSync(process.argv[2], JSON.stringify(m.nativeEngine));' "$installed_manifest" "$native_metadata"
  build_args+=(--native-engine "$native_engine" --native-engine-metadata "$native_metadata")
fi
if [[ -f "$workspace_helper" ]]; then
  build_args+=(--workspace-files "$workspace_helper")
fi

"$(command -v bun)" "${build_args[@]}"

if [[ -x "$installed_launcher" && -f "$bin_root/.chatgpt-tela-payload-v1.json" ]]; then
  lifecycle_command=("$payload/chatgpt-tela" upgrade)
else
  lifecycle_command=("$payload/chatgpt-tela" install)
fi

"${lifecycle_command[@]}" --dry-run --payload "$payload"
"${lifecycle_command[@]}" --apply --payload "$payload"

echo "Installed Tela from ${short_head}. Temporary build material was removed."
