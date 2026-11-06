#!/usr/bin/env bash
# Weekly update: build and test the newest main in its own release folder,
# switch to it, and roll back if the new server does not come up.
#
# Runs as root from /opt/mmofps/bin, an installed copy that a push to the
# repository cannot change. git, npm and the tests run as the unprivileged
# mmofps user. Game data lives in /opt/mmofps/data, outside every release.
set -euo pipefail

ROOT="${ROOT:-/opt/mmofps}"
REPO="${REPO:-https://github.com/Zelaron/mmofps-engine.git}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-mmofps}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/healthz}"
KEEP="${KEEP:-3}"

log() { echo "[mmofps-update] $*"; }
as_app() {
  runuser -u mmofps -- env HOME="$ROOT/home" PATH="$ROOT/node/bin:/usr/local/bin:/usr/bin:/bin" \
    TEST_CONCURRENCY="${TEST_CONCURRENCY:-2}" "$@"
}
switch_to() { ln -sfn "$1" "$ROOT/current.tmp" && mv -T "$ROOT/current.tmp" "$ROOT/current"; }
healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | grep -q '"available":true'; then return 0; fi
    sleep 2
  done
  return 1
}

previous="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
target="$(as_app git ls-remote "$REPO" "refs/heads/$BRANCH" | cut -f1)"
[ -n "$target" ] || { log "could not read $BRANCH from $REPO"; exit 1; }
if [ -n "$previous" ] && [ "$(basename "$previous")" = "$target" ]; then
  log "already running $target"
  exit 0
fi

staging="$ROOT/releases/.incoming"
trap 'log "update failed; still running ${previous:+$(basename "$previous")}"; rm -rf "$staging"' ERR
rm -rf "$staging"
log "building $target"
as_app git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$staging"
built="$(as_app git -C "$staging" rev-parse HEAD)"
release="$ROOT/releases/$built"
rm -rf "$release"
mv "$staging" "$release"
cd "$release"
as_app npm ci --no-audit --no-fund
as_app npm run build
as_app npm run check
trap - ERR

switch_to "$release"
log "restarting $SERVICE on $built"
systemctl restart "$SERVICE"
if healthy; then
  log "deployed $built"
else
  log "$built did not come up; rolling back"
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    switch_to "$previous"
    systemctl restart "$SERVICE"
    if healthy; then log "rolled back to $(basename "$previous")"; else log "the previous release did not come up either"; fi
  fi
  exit 1
fi

# Keep the newest releases; never remove the running one.
running="$(readlink -f "$ROOT/current")"
ls -1dt "$ROOT"/releases/*/ | tail -n +"$((KEEP + 1))" | while read -r old; do
  [ "$(readlink -f "$old")" = "$running" ] || rm -rf "$old"
done
