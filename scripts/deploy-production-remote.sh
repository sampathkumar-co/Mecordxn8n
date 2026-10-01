#!/usr/bin/env bash
set -Eeuo pipefail

archive="${1:-}"
incoming_env="${2:-}"
deploy_root="${3:-}"
release_sha="${4:-}"
expected_archive_sha="${5:-}"

fail() {
  printf 'deploy error: %s\n' "$*" >&2
  exit 1
}

[[ -f "$archive" ]] || fail "release archive is missing"
[[ -f "$incoming_env" ]] || fail "production env file is missing"
[[ "$deploy_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "deploy root is invalid"
[[ "$deploy_root" != *".."* ]] || fail "deploy root cannot contain .."
[[ "$release_sha" =~ ^[a-f0-9]{40}$ ]] || fail "release SHA is invalid"
[[ "$expected_archive_sha" =~ ^[a-f0-9]{64}$ ]] || fail "archive checksum is invalid"

actual_archive_sha="$(sha256sum "$archive" | awk '{print $1}')"
[[ "$actual_archive_sha" == "$expected_archive_sha" ]] ||
  fail "release archive checksum mismatch"

release_dir="$deploy_root/releases/$release_sha"
staging_dir="$deploy_root/releases/.staging-$release_sha"
current_link="$deploy_root/current"
previous_link="$deploy_root/previous"

cleanup() {
  rm -f "$incoming_env" "$archive"
  rm -rf "$staging_dir"
}
trap cleanup EXIT

mkdir -p "$deploy_root/releases"
chmod 700 "$deploy_root" "$deploy_root/releases" 2>/dev/null || true

current_real=""
if [[ -L "$current_link" ]]; then
  current_real="$(readlink -f "$current_link" || true)"
fi

if [[ -d "$release_dir" && "$current_real" != "$release_dir" ]]; then
  rm -rf "$release_dir"
fi

if [[ ! -d "$release_dir" ]]; then
  rm -rf "$staging_dir"
  mkdir -p "$staging_dir"
  tar -xzf "$archive" -C "$staging_dir"
  printf '%s\n' "$release_sha" > "$staging_dir/.release-commit"
  mv "$staging_dir" "$release_dir"
fi

install -m 600 "$incoming_env" "$release_dir/.env"

if [[ -n "$current_real" && "$current_real" != "$release_dir" ]]; then
  ln -sfn "$current_real" "$previous_link"
fi

cd "$release_dir"

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "docker compose is unavailable"

compose=(
  docker compose
  --env-file .env
  -p mecordxn8n
  -f docker-compose.yml
  -f docker-compose.production.yml
)

"${compose[@]}" config --quiet
"${compose[@]}" build --pull

# Run the repository's production gate in the exact image/configuration that is
# about to be deployed. No dependencies are started for this check.
"${compose[@]}" run --rm --no-deps control-api   node scripts/production-preflight.mjs

"${compose[@]}" up -d --remove-orphans

ready=0
for attempt in $(seq 1 45); do
  if "${compose[@]}" exec -T control-api node -e     "fetch('http://127.0.0.1:8080/healthz',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"     >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

if [[ "$ready" != "1" ]]; then
  "${compose[@]}" ps >&2 || true
  fail "control API did not become ready"
fi

ln -sfn "$release_dir" "$current_link"
printf 'deployed release %s\n' "$release_sha"
