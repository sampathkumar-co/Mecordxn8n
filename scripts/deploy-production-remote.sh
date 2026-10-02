#!/usr/bin/env bash
set -Eeuo pipefail

archive="${1:-}"
incoming_env="${2:-}"
deploy_root="${3:-}"
release_sha="${4:-}"
expected_archive_sha="${5:-}"
ingress_mode="${6:-}"
incoming_host_caddy="${7:-}"

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
[[ "$ingress_mode" == "external" || "$ingress_mode" == "standalone" ]] ||
  fail "ingress mode must be external or standalone"
if [[ "$ingress_mode" == "external" ]]; then
  [[ -f "$incoming_host_caddy" ]] || fail "host Caddy snippet is missing"
fi

actual_archive_sha="$(sha256sum "$archive" | awk '{print $1}')"
[[ "$actual_archive_sha" == "$expected_archive_sha" ]] ||
  fail "release archive checksum mismatch"

release_dir="$deploy_root/releases/$release_sha"
staging_dir="$deploy_root/releases/.staging-$release_sha"
current_link="$deploy_root/current"
previous_link="$deploy_root/previous"

cleanup() {
  rm -f "$incoming_env" "$archive" "$incoming_host_caddy"
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
if [[ "$ingress_mode" == "external" ]]; then
  install -m 644 "$incoming_host_caddy" "$release_dir/host-caddy.caddy"
fi

if [[ -n "$current_real" && "$current_real" != "$release_dir" ]]; then
  ln -sfn "$current_real" "$previous_link"
fi

cd "$release_dir"

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "docker compose is unavailable"

compose_base=(
  docker compose
  --env-file .env
  -p mecordxn8n
  -f docker-compose.yml
  -f docker-compose.production.yml
)

compose_env_value() {
  local key="$1"
  "${compose_base[@]}" config --environment |
    awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }'
}

external_ingress_network="$(compose_env_value EXTERNAL_INGRESS_NETWORK)"
external_ingress_upstream="$(compose_env_value EXTERNAL_INGRESS_UPSTREAM)"
if [[ -n "$external_ingress_network" || -n "$external_ingress_upstream" ]]; then
  [[ -n "$external_ingress_network" && -n "$external_ingress_upstream" ]] ||
    fail "external ingress network and upstream must be configured together"
fi

compose=("${compose_base[@]}")
if [[ "$ingress_mode" == "external" && -n "$external_ingress_network" ]]; then
  [[ -f docker-compose.external.yml ]] ||
    fail "containerized external ingress compose file is missing"
  docker network inspect "$external_ingress_network" >/dev/null 2>&1 ||
    fail "external ingress Docker network does not exist"
  compose+=(-f docker-compose.external.yml)
fi
if [[ "$ingress_mode" == "standalone" ]]; then
  compose+=(--profile standalone-ingress)
fi

"${compose[@]}" config --quiet
"${compose[@]}" build --pull

# Run the repository's production gate in the exact control image that is
# about to be deployed, while passing the complete production dotenv rather
# than only the subset forwarded by the Compose service definition.
control_image_ref="$("${compose[@]}" config --images | grep -Fx 'mecordxn8n-control-api' | head -n 1)"
[[ -n "$control_image_ref" ]] || fail "control image reference could not be resolved"
control_image="$(docker image inspect "$control_image_ref" --format '{{.Id}}' 2>/dev/null || true)"
[[ -n "$control_image" ]] || fail "control image was not built"
docker run --rm \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount "type=bind,src=$release_dir/.env,dst=/run/mecordxn8n-production.env,readonly" \
  --entrypoint node \
  "$control_image" \
  --env-file=/run/mecordxn8n-production.env \
  scripts/production-preflight.mjs

# Bring up only the stateful databases first and wait for their healthchecks.
# Run migrations from the exact newly built control image before any application
# or worker service is promoted to the new release.
"${compose[@]}" up -d --wait postgres n8n-postgres
"${compose[@]}" run --rm --no-deps control-api node scripts/migrate.mjs

if [[ "$ingress_mode" == "external" ]]; then
  standalone_compose=(
    docker compose
    --env-file .env
    -p mecordxn8n
    -f docker-compose.yml
    -f docker-compose.production.yml
    --profile standalone-ingress
  )
  "${standalone_compose[@]}" stop caddy >/dev/null 2>&1 || true
  "${standalone_compose[@]}" rm -f caddy >/dev/null 2>&1 || true
fi

"${compose[@]}" up -d --remove-orphans

if [[ "$ingress_mode" == "external" ]]; then
  published="$("${compose[@]}" port control-api 8080 | head -n 1)"
  [[ "$published" == 127.0.0.1:* || "$published" == "[::1]:"* ]] ||
    fail "external ingress requires loopback-only control-api publication"

  if [[ -n "$external_ingress_network" ]]; then
    control_container="$("${compose[@]}" ps -q control-api)"
    [[ -n "$control_container" ]] || fail "control-api container is missing"
    docker inspect "$control_container" --format       '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' |
      grep -Fx "$external_ingress_network" >/dev/null ||
      fail "control-api is not attached to the external ingress network"
    docker inspect "$control_container" --format       '{{range .NetworkSettings.Networks}}{{range .Aliases}}{{println .}}{{end}}{{end}}' |
      grep -Fx 'mecordxn8n-control-api' >/dev/null ||
      fail "control-api external ingress alias is missing"
  fi
fi

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
