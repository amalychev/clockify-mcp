#!/usr/bin/env bash
#
# Full deployment for clockify-mcp: pull, build, swap the container, verify, purge.
#
#   ./deploy.sh                 pull, rebuild the image, restart the container, health check
#   ./deploy.sh --page-only     only copy landing.html into the running container (no rebuild)
#   ./deploy.sh --no-pull       deploy the working tree as it is, without git pull
#   ./deploy.sh --logs          follow the container log after a successful deploy
#
# Settings live in deploy.env next to this script; see deploy.env.example.
# A failed health check rolls back to the previous image automatically.

set -euo pipefail

# Always operate on the repository this script lives in, whatever the caller's cwd.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- settings ----------------------------------------------------------------

[ -f deploy.env ] && . ./deploy.env

DOCKER="${DOCKER:-docker}"
IMAGE="${IMAGE:-clockify-mcp}"
CONTAINER="${CONTAINER:-clockify-mcp}"
HOST_PORT="${HOST_PORT:-8080}"
CONTAINER_PORT="${CONTAINER_PORT:-8080}"
BRANCH="${BRANCH:-main}"
# Runtime configuration for the server itself (CLOCKIFY_ALLOWED_INSTANCES, …).
ENV_FILE="${ENV_FILE:-.env}"
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
HEALTH_DELAY="${HEALTH_DELAY:-1}"
PUBLIC_URL="${PUBLIC_URL:-}"
CLOUDFLARE_ZONE_ID="${CLOUDFLARE_ZONE_ID:-}"
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"

# If a docker-compose.yml sits next to this script, the container is managed
# by Compose (its own network, no published host port) — build/swap/health
# checks all need to go through `docker compose` and `docker exec` instead of
# `docker run` and a host-port curl.
USE_COMPOSE=false
[ -f docker-compose.yml ] && USE_COMPOSE=true
COMPOSE_SERVICE="${COMPOSE_SERVICE:-app}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${HOST_PORT}/health}"

PAGE_ONLY=false
DO_PULL=true
FOLLOW_LOGS=false

for arg in "$@"; do
  case "$arg" in
    --page-only) PAGE_ONLY=true ;;
    --no-pull)   DO_PULL=false ;;
    --logs)      FOLLOW_LOGS=true ;;
    -h|--help)   awk 'NR>1 { if (!/^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *)           echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# --- output helpers ----------------------------------------------------------

step() { printf '\n\033[1;33m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
ok()   { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m    ✗ %s\033[0m\n' "$1" >&2; exit 1; }

command -v "$DOCKER" >/dev/null || die "docker not found. Set DOCKER=… in deploy.env if it needs sudo."
$DOCKER info >/dev/null 2>&1 || die "cannot talk to the docker daemon. Try DOCKER='sudo docker' in deploy.env."

# --- pull --------------------------------------------------------------------

if $DO_PULL && [ -d .git ]; then
  step "Updating the working tree"
  git fetch --quiet origin "$BRANCH"
  git checkout --quiet "$BRANCH"
  git pull --quiet --ff-only origin "$BRANCH"
  ok "$(git log --oneline -1)"
fi

REVISION="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# --- fast path: replace only the landing page --------------------------------

if $PAGE_ONLY; then
  step "Copying the landing page into $CONTAINER"
  $DOCKER container inspect "$CONTAINER" >/dev/null 2>&1 || die "container $CONTAINER is not running; run a full deploy instead."
  $DOCKER cp landing.html "$CONTAINER:/app/landing.html"
  # Icons and the preview image are read from disk too, so they can travel along.
  $DOCKER cp assets/. "$CONTAINER:/app/assets/"
  # The server reads these files on every request, so no restart is needed.
  ok "copied landing.html ($(wc -c < landing.html | tr -d '[:space:]') bytes) and assets/"
else
  # --- build -----------------------------------------------------------------

  step "Building the image"
  PREVIOUS_IMAGE=""
  if $DOCKER image inspect "$IMAGE:latest" >/dev/null 2>&1; then
    PREVIOUS_IMAGE="$IMAGE:previous"
    $DOCKER tag "$IMAGE:latest" "$PREVIOUS_IMAGE"
    info "previous image kept as $PREVIOUS_IMAGE for rollback"
  fi

  if $USE_COMPOSE; then
    $DOCKER compose build "$COMPOSE_SERVICE"
    $DOCKER tag "$IMAGE:latest" "$IMAGE:$REVISION"
    ok "built $IMAGE:$REVISION (docker compose)"
  else
    $DOCKER build --tag "$IMAGE:$REVISION" --tag "$IMAGE:latest" .
    ok "built $IMAGE:$REVISION"
  fi

  # --- swap the container ----------------------------------------------------

  step "Restarting the container"
  run_container() {
    local image="$1"
    local args=(run --detach --name "$CONTAINER" --restart unless-stopped
                --publish "${HOST_PORT}:${CONTAINER_PORT}"
                --env "PORT=${CONTAINER_PORT}" --env "MCP_TRANSPORT=http")
    [ -f "$ENV_FILE" ] && args+=(--env-file "$ENV_FILE")
    $DOCKER "${args[@]}" "$image" >/dev/null
  }

  if $USE_COMPOSE; then
    $DOCKER compose up --detach "$COMPOSE_SERVICE" >/dev/null
    ok "recreated via docker compose"
  else
    if $DOCKER container inspect "$CONTAINER" >/dev/null 2>&1; then
      $DOCKER rm --force "$CONTAINER" >/dev/null
      info "removed the old container"
    fi
    [ -f "$ENV_FILE" ] && info "passing $ENV_FILE to the container"
    run_container "$IMAGE:latest"
    ok "started from $IMAGE:$REVISION"
  fi

  # --- health check, with rollback -------------------------------------------

  step "Waiting for the server to answer"
  check_health() {
    if $USE_COMPOSE; then
      # No host port is published for the Compose service, so probe from inside the container.
      $DOCKER exec "$CONTAINER" wget --quiet --output-document=- "http://127.0.0.1:${CONTAINER_PORT}/health" >/dev/null 2>&1
    else
      curl --silent --fail --max-time 3 "$HEALTH_URL" >/dev/null 2>&1
    fi
  }

  healthy=false
  for _ in $(seq "$HEALTH_RETRIES"); do
    if check_health; then
      healthy=true
      break
    fi
    sleep "$HEALTH_DELAY"
  done

  if ! $healthy; then
    printf '\033[1;31m    ✗ %s\033[0m\n' "no answer from the health check"
    $DOCKER logs --tail 40 "$CONTAINER" 2>&1 | sed 's/^/      /'
    if [ -n "$PREVIOUS_IMAGE" ]; then
      step "Rolling back to the previous image"
      if $USE_COMPOSE; then
        $DOCKER tag "$PREVIOUS_IMAGE" "$IMAGE:latest"
        $DOCKER compose up --detach "$COMPOSE_SERVICE" >/dev/null
      else
        $DOCKER rm --force "$CONTAINER" >/dev/null 2>&1 || true
        run_container "$PREVIOUS_IMAGE"
      fi
      info "restored $PREVIOUS_IMAGE — the new build was not deployed"
    fi
    exit 1
  fi
  if $USE_COMPOSE; then
    ok "$($DOCKER exec "$CONTAINER" wget --quiet --output-document=- "http://127.0.0.1:${CONTAINER_PORT}/health" 2>/dev/null)"
  else
    ok "$(curl --silent "$HEALTH_URL")"
  fi
fi

# --- cache ------------------------------------------------------------------

if [ -n "$CLOUDFLARE_ZONE_ID" ] && [ -n "$CLOUDFLARE_API_TOKEN" ]; then
  step "Purging the Cloudflare cache"
  response=$(curl --silent --request POST \
    "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    --data '{"purge_everything":true}')
  case "$response" in
    *'"success":true'*) ok "cache purged" ;;
    *) info "purge failed: $response" ;;
  esac
else
  info "Cloudflare credentials not set — skipping cache purge (see deploy.env.example)"
fi

# --- verify ------------------------------------------------------------------

step "Result"
# tr: wc pads its output with spaces on some platforms, which breaks the compare.
local_size=$(wc -c < landing.html | tr -d '[:space:]')
info "revision:      $REVISION"
info "landing.html:  $local_size bytes on disk"

if [ -n "$PUBLIC_URL" ]; then
  served=$(curl --silent --output /dev/null --write-out '%{size_download}' "$PUBLIC_URL" || echo 0)
  if [ "$served" = "$local_size" ]; then
    ok "$PUBLIC_URL serves the current page ($served bytes)"
  else
    info "$PUBLIC_URL serves $served bytes, expected $local_size"
    info "if a CDN sits in front, give it a moment or purge its cache"
  fi
fi

ok "deployed"

$FOLLOW_LOGS && $DOCKER logs --follow --tail 20 "$CONTAINER"
exit 0
