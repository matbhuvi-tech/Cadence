#!/bin/sh
set -eu

action="${1:-}"
case "$action" in
  [1-9]* | "upgrade" | "failed-upgrade" | "deconfigure")
    exit 0
    ;;
esac

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl stop cadence-playback-engine || true
  systemctl disable cadence-playback-engine || true
fi

printf "Cadence Playback Engine service removed. Preserved data/config:\n"
printf "  - /etc/cadence/playback-engine.env\n"
printf "  - /var/lib/cadence\n"
