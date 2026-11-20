#!/usr/bin/env bash
set -euo pipefail

# Run only inside the clean user allocated to the packaging job.
package="${1:?Expected the extracted Linux package directory}"
source_launcher="$package/chatgpt-tela"
readonly runtime_home="$HOME/.local/share/chatgpt-tela"
readonly installed="$runtime_home/bin/chatgpt-tela"
readonly config="$HOME/.config/chatgpt-tela/product-v1.json"
readonly units="$HOME/.config/systemd/user"
readonly sentinel="$HOME/outside-tela.txt"

[[ "$(id -u)" != 0 && -n "${XDG_RUNTIME_DIR:-}" ]]
[[ -x "$source_launcher" && ! -e "$runtime_home" && ! -e "$HOME/.config/chatgpt-tela" ]]
[[ ! -e "$HOME/.local/state/chatgpt-tela" && ! -e "$XDG_RUNTIME_DIR/chatgpt-tela" && ! -e "$sentinel" ]]
[[ -z "${XDG_DATA_HOME:-}${XDG_CONFIG_HOME:-}${XDG_STATE_HOME:-}${XDG_CACHE_HOME:-}" ]]
systemctl --user show-environment >/dev/null
printf 'foreign data\n' > "$sentinel"

install_package() {
  "$source_launcher" install --apply | jq -e '.verify.ready == true'
  for service in gateway chat codex; do
    local unit="chatgpt-tela-$service.service"
    [[ "$(systemctl --user show --property=FragmentPath --value "$unit")" == "$units/$unit" ]]
    [[ "$(systemctl --user show --property=ActiveState --value "$unit")" == inactive ]]
  done
}

check_services() {
  local action="$1" result_state="$2" unit_state="$3"
  "$installed" services "$action" | jq -e --arg state "$result_state" '
    .success and ([.services[].service] | sort == ["chat", "codex", "gateway"])
    and all(.services[]; .state == $state)'
  for service in gateway chat codex; do
    [[ "$(systemctl --user show --property=ActiveState --value "chatgpt-tela-$service.service")" == "$unit_state" ]]
  done
}

assert_removed() {
  [[ ! -e "$installed" && "$(cat "$sentinel")" == 'foreign data' ]]
  for service in gateway chat codex; do
    local unit="chatgpt-tela-$service.service"
    [[ ! -e "$units/$unit" && ! -L "$units/default.target.wants/$unit" ]]
    [[ "$(systemctl --user show --property=LoadState --value "$unit")" == not-found ]]
  done
}

install_package
"$installed" configure --stdin --if-missing <<'JSON' | jq -e '.configured == true'
{"version":1,"publicMcpAbi":"stable","exposure":{"kind":"existing-https","publicUrl":"https://example.test/mcp","localPort":18743,"authentication":"none","allowUnauthenticatedPublicEndpoint":true}}
JSON
config_sha="$(sha256sum "$config")"
check_services start running active
check_services stop stopped inactive

# Simulate a missing owned launcher, then repair from the extracted package.
rm "$installed"
"$source_launcher" repair --apply | jq -e '.payload == "repaired"'
cmp "$source_launcher" "$installed"

check_services start running active
"$source_launcher" uninstall --apply | jq -e '.applied == true and .failedCount == 0'
assert_removed
[[ "$(sha256sum "$config")" == "$config_sha" ]]
install_package
"$installed" bootstrap-status | jq -e '.configuration == "configured"'
[[ "$(sha256sum "$config")" == "$config_sha" ]]

"$source_launcher" uninstall --apply --remove-data | jq -e '.applied == true and .failedCount == 0 and .manifestRemoved == true'
assert_removed
[[ ! -e "$config" ]]
