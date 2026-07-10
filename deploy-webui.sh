#!/usr/bin/env bash
# Deploy the accessibility WebUI to the qbittorrent container on dockge.
#
# The target folder is inside the container's existing /config bind mount,
# so deployment never restarts qbittorrent (a restart re-announces every
# torrent). qBittorrent serves file changes on the next request; browsers
# need a hard refresh (Ctrl+F5) because JS/CSS carry max-age=43200.
#
# Rollback to the stock WebUI:
#   incus exec dockge -- docker exec qbittorrent curl -s -X POST \
#     http://localhost:8080/api/v2/app/setPreferences \
#     --data-urlencode 'json={"alternative_webui_enabled":false}'
set -euo pipefail

cd "$(dirname "$0")/src/webui/www"

tar -cf - private public | incus exec dockge -- tar -xf - -C /opt/stacks/qbittorrent/config/webui-a11y

# idempotent: also flips the alternative UI on for first-time deploys
incus exec dockge -- docker exec qbittorrent curl -s -X POST \
    http://localhost:8080/api/v2/app/setPreferences \
    --data-urlencode 'json={"alternative_webui_enabled":true,"alternative_webui_path":"/config/webui-a11y"}' \
    -o /dev/null

echo "deployed — hard-refresh (Ctrl+F5) the browser"
