#!/usr/bin/env bash
# Deploy the WebUI to the qbittorrent container on dockge, as qBittorrent's
# "alternative WebUI":
#   /           the simple page (webui-simple/), made for screen readers
#   /full.html  the full interface (src/webui/www, the accessibility fork)
#
# The target folder is inside the container's existing /config bind mount,
# so deployment never restarts qbittorrent (a restart re-announces every
# torrent).
#
#   ./deploy-webui.sh                         assemble and deploy
#   ./deploy-webui.sh --assemble-only DIR     only build the deploy tree in DIR
#
# Why it works the way it does:
# - qBittorrent keeps translated files in memory by path and re-reads one only
#   when its mtime is newer, so files are extracted with tar -m (mtime = now).
# - The simple page's assets carry ?v=<cache id>-<content hash>: qBittorrent's
#   cache id only changes on restart and assets are cached for 12 hours, so a
#   new hash is what makes browsers fetch a new version. index.html itself is
#   served no-store.
# - index.html is extracted last, so a page load mid-deploy can't pair the new
#   page with old assets.
# - index.html must never be missing: qbittorrent-nox switches the alternative
#   UI off if it is. A symlink anywhere in the tree makes qBittorrent answer 500.
#
# Put the full interface back at / (instant, no restart):
#   incus exec dockge -- sh -c 'cd /opt/stacks/qbittorrent/config/webui-a11y/private && cp full.html index.html && touch index.html'
# Turning the alternative UI off falls back to the stock upstream interface:
#   incus exec dockge -- docker exec qbittorrent curl -s -X POST \
#     http://localhost:8080/api/v2/app/setPreferences \
#     --data-urlencode 'json={"alternative_webui_enabled":false}'
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
TARGET=/opt/stacks/qbittorrent/config/webui-a11y
VERSION_PLACEHOLDERS='__JS_VERSION__\|__CSS_VERSION__'
HASH_LENGTH=10

assemble() {
    local stage="$1"
    cp -r "$REPO/src/webui/www/private" "$REPO/src/webui/www/public" "$stage/"
    mv "$stage/private/index.html" "$stage/private/full.html"
    cp "$REPO/webui-simple/index.html" "$stage/private/index.html"
    cp -r "$REPO/webui-simple/simple" "$stage/private/simple"

    local js css
    js=$(md5sum "$stage/private/simple/app.js" | cut -c1-"$HASH_LENGTH")
    css=$(md5sum "$stage/private/simple/app.css" | cut -c1-"$HASH_LENGTH")
    sed -i "s/__JS_VERSION__/$js/; s/__CSS_VERSION__/$css/" "$stage/private/index.html"
    if grep -q "$VERSION_PLACEHOLDERS" "$stage/private/index.html"; then
        echo "version placeholders left in index.html" >&2
        exit 1
    fi
    if [ -n "$(find "$stage" -type l)" ]; then
        echo "symlink in the deploy tree; qBittorrent would answer 500" >&2
        exit 1
    fi
}

if [ "${1:-}" = "--assemble-only" ]; then
    out="${2:?usage: $0 --assemble-only DIR}"
    mkdir -p "$out"
    if [ -n "$(ls -A "$out")" ]; then
        echo "$out is not empty" >&2
        exit 1
    fi
    assemble "$out"
    echo "assembled in $out"
    exit 0
fi

stage="$(mktemp -d "${TMPDIR:-/tmp}/qbt-webui.XXXXXX")"
cleanup() {
    # only ever the directory mktemp just made
    case "$stage" in
        */qbt-webui.??????) [ -d "$stage" ] && rm -rf -- "$stage" ;;
    esac
}
trap cleanup EXIT
assemble "$stage"

# everything except the page itself first, then the page
tar -C "$stage" --exclude=private/index.html -cf - private public \
    | incus exec dockge -- tar -xmf - -C "$TARGET"
tar -C "$stage" -cf - private/index.html \
    | incus exec dockge -- tar -xmf - -C "$TARGET"

# idempotent: also flips the alternative UI on for first-time deploys
incus exec dockge -- docker exec qbittorrent curl -s -X POST \
    http://localhost:8080/api/v2/app/setPreferences \
    --data-urlencode 'json={"alternative_webui_enabled":true,"alternative_webui_path":"/config/webui-a11y"}' \
    -o /dev/null

echo "deployed: / is the simple page, /full.html the full interface"
echo "full interface back at /: incus exec dockge -- sh -c 'cd $TARGET/private && cp full.html index.html && touch index.html'"
