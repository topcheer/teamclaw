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

# ClawHub packs the LOCAL package folder (dist/ included), unlike the npm
# workflow which builds in CI first. Without this build step the tarball
# shipped whatever dist/ happened to be on disk - the 2026.11.8 publish
# carried a dist from before two security releases, and the ClawHub rescan
# flagged five already-fixed issues in the stale compiled files. Build here
# so the artifact always matches the source commit recorded below.
build_cmd=(npm --prefix "${package_dir}" run build)
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

printf 'Package build:'
printf ' %q' "${build_cmd[@]}"
printf '\n'

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

"${build_cmd[@]}"
"${sync_manifest_cmd[@]}"
"${check_package_cmd[@]}"

# Refuse to publish a dist/ that is older than the newest TypeScript source
# (a silent build skip must never reach the registry again).
newest_src="$(find "${package_dir}/src" -name '*.ts' -type f -newer "${package_dir}/dist/src/controller/security.js" 2>/dev/null | head -1 || true)"
if [[ -n "${newest_src}" ]]; then
  echo "dist/ is stale relative to ${newest_src}; refusing to publish" >&2
  exit 1
fi

if [[ "${mode}" == "--dry-run" ]]; then
  exit 0
fi

clawhub whoami >/dev/null
(
  cd "${repo_root}"
  "${publish_package_cmd[@]}"
  for skill_file in "${skill_files[@]}"; do
    # clawhub's legacy `publish` resolves the path against its own opts.workdir
    # (not the shell cwd), so a repo-relative path fails its stat check - pass
    # the absolute skill folder (skill_file is already absolute from find).
    clawhub publish "${skill_file%/SKILL.md}" --changelog "${changelog}" --tags "${tags}"
  done
)
