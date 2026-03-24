#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
package_dir="${2:-src}"
npm_registry="https://registry.npmjs.org/"
provenance_mode="${TEAMCLAW_NPM_PROVENANCE:-auto}"

if [[ "${mode}" != "--dry-run" && "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/teamclaw-npm-publish.sh [--dry-run|--publish] <package-dir>" >&2
  exit 2
fi

if [[ -z "${package_dir}" ]]; then
  echo "missing package dir" >&2
  exit 2
fi

if [[ "${provenance_mode}" != "auto" && "${provenance_mode}" != "always" && "${provenance_mode}" != "never" ]]; then
  echo "TEAMCLAW_NPM_PROVENANCE must be one of: auto, always, never" >&2
  exit 2
fi

metadata_file="$(mktemp "${TMPDIR:-/tmp}/teamclaw-package-check.XXXXXX.json")"
trap 'rm -f "${metadata_file}"' EXIT

node scripts/teamclaw-package-check.mjs "${package_dir}" >"${metadata_file}"

package_name="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(p.packageName);' "${metadata_file}")"
package_version="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(p.packageVersion);' "${metadata_file}")"
publish_tag="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(p.publishTag);' "${metadata_file}")"

publish_cmd=(npm publish --registry "${npm_registry}" --access public --tag latest)
if [[ "${publish_tag}" == "beta" ]]; then
  publish_cmd=(npm publish --registry "${npm_registry}" --access public --tag beta)
fi

publish_auth="npm token / local npm auth"
provenance_status="disabled"
if [[ "${provenance_mode}" == "always" ]]; then
  publish_cmd+=(--provenance)
  publish_auth="forced provenance"
  provenance_status="enabled (forced)"
elif [[ "${provenance_mode}" == "auto" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" && -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" && -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
    publish_cmd+=(--provenance)
    publish_auth="GitHub OIDC trusted publishing"
    provenance_status="enabled (GitHub Actions OIDC)"
  else
    provenance_status="disabled (no supported CI OIDC provider detected)"
  fi
fi

echo "Resolved package dir: ${package_dir}"
echo "Resolved package name: ${package_name}"
echo "Resolved package version: ${package_version}"
echo "Resolved publish tag: ${publish_tag}"
echo "Publish registry: ${npm_registry}"
echo "Publish auth: ${publish_auth}"
echo "Publish provenance: ${provenance_status}"

printf 'Publish command:'
printf ' %q' "${publish_cmd[@]}"
printf '\n'

if [[ "${mode}" == "--dry-run" ]]; then
  exit 0
fi

(
  cd "${package_dir}"
  "${publish_cmd[@]}"
)
