#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

repo="${1:-}"
repo_args=()
if [[ -n "$repo" ]]; then
  repo_args=(--repo "$repo")
fi

create_label() {
  gh label create "$1" "${repo_args[@]}" --color "$2" --description "$3" --force >/dev/null
}

create_label "priority:P0" "b60205" "Release blocker"
create_label "priority:P1" "d97706" "High priority"
create_label "priority:P2" "eab308" "Normal priority"
create_label "area:ssh" "0e8a16" "SSH transport and OpenSSH compatibility"
create_label "area:ui" "1d76db" "Desktop user interface"
create_label "area:terminal" "5319e7" "Terminal and PTY"
create_label "area:files" "006b75" "SFTP and file operations"
create_label "area:release" "0052cc" "Packaging and releases"
create_label "area:protocol" "7057ff" "Non-SSH transports"
create_label "security" "d1242f" "Security-sensitive work"
create_label "performance" "fbca04" "Performance measurement and optimization"
create_label "reliability" "c2e0c6" "Stability and recovery"
create_label "enhancement" "a2eeef" "New feature or improvement"

existing_titles="$(gh issue list "${repo_args[@]}" --state all --limit 500 --json title --jq '.[].title')"

for file in issues/[0-9][0-9][0-9]-*.md; do
  title="$(sed -n '1s/^# //p' "$file")"
  labels="$(sed -n '2s/^Labels: //p' "$file")"
  if grep -Fqx "$title" <<<"$existing_titles"; then
    echo "skip: $title"
    continue
  fi

  body="$(mktemp)"
  trap 'rm -f "$body"' EXIT
  sed '1,2d' "$file" >"$body"
  args=(--title "$title" --body-file "$body")
  IFS=',' read -ra label_list <<<"$labels"
  for label in "${label_list[@]}"; do
    args+=(--label "$(xargs <<<"$label")")
  done
  gh issue create "${repo_args[@]}" "${args[@]}"
  rm -f "$body"
  trap - EXIT
done
