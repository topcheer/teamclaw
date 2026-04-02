#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
if [[ "${mode}" != "--dry-run" && "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/teamclaw-clawhub-release.sh [--dry-run|--publish]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="${TEAMCLAW_PACKAGE_DIR:-src}"
skills_workdir="${TEAMCLAW_SKILLS_WORKDIR:-src}"
skills_dir="${TEAMCLAW_SKILLS_DIR:-skills}"
tags="${TEAMCLAW_CLAWHUB_TAGS:-latest}"
changelog="${TEAMCLAW_CHANGELOG:-}"

if [[ -z "${changelog}" ]]; then
  changelog="TeamClaw release $(node -p "require('./${package_dir}/package.json').version")"
fi

package_name="$(node -p "require('./${package_dir}/package.json').name")"
package_version="$(node -p "require('./${package_dir}/package.json').version")"
package_display_name="$(node -p "require('./${package_dir}/openclaw.plugin.json').name")"
source_commit="$(git -C "${repo_root}" rev-parse HEAD)"
source_ref="$(git -C "${repo_root}" rev-parse --abbrev-ref HEAD)"

sync_manifest_cmd=(node scripts/sync-teamclaw-plugin-manifest.mjs "${package_dir}")
check_package_cmd=(node scripts/teamclaw-package-check.mjs "${package_dir}")
publish_package_cmd=(
  clawhub package publish "${package_dir}"
  --family code-plugin
  --name "${package_name}"
  --display-name "${package_display_name}"
  --version "${package_version}"
  --changelog "${changelog}"
  --tags "${tags}"
  --source-repo "topcheer/teamclaw"
  --source-commit "${source_commit}"
  --source-ref "${source_ref}"
  --source-path "${package_dir}"
)

skills_root="${repo_root}/${skills_workdir}/${skills_dir}"
if [[ ! -d "${skills_root}" ]]; then
  echo "skills directory not found: ${skills_root}" >&2
  exit 1
fi

mapfile -t skill_files < <(find "${skills_root}" -mindepth 2 -maxdepth 2 -name SKILL.md | sort)
if [[ "${#skill_files[@]}" -eq 0 ]]; then
  echo "no bundled skills found under ${skills_root}" >&2
  exit 1
fi

printf 'Manifest sync:'
printf ' %q' "${sync_manifest_cmd[@]}"
printf '\n'

printf 'Package check:'
printf ' %q' "${check_package_cmd[@]}"
printf '\n'

printf 'ClawHub package publish:'
printf ' %q' "${publish_package_cmd[@]}"
printf '\n'

for skill_file in "${skill_files[@]}"; do
  skill_dir="${skill_file%/SKILL.md}"
  skill_rel="${skill_dir#"${repo_root}/"}"
  skill_publish_cmd=(clawhub publish "${skill_rel}" --changelog "${changelog}" --tags "${tags}")
  printf 'ClawHub skill publish:'
  printf ' %q' "${skill_publish_cmd[@]}"
  printf '\n'
done

"${sync_manifest_cmd[@]}"
"${check_package_cmd[@]}"

if [[ "${mode}" == "--dry-run" ]]; then
  exit 0
fi

clawhub whoami >/dev/null
(
  cd "${repo_root}"
  "${publish_package_cmd[@]}"
  for skill_file in "${skill_files[@]}"; do
    skill_dir="${skill_file%/SKILL.md}"
    skill_rel="${skill_dir#"${repo_root}/"}"
    clawhub publish "${skill_rel}" --changelog "${changelog}" --tags "${tags}"
  done
)
