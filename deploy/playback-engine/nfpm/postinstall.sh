#!/bin/sh
set -eu

if [ -d /var/lib/cadence ] && [ ! -L /var/lib/cadence ]; then
  chown -h cadence:cadence /var/lib/cadence
  chmod 700 /var/lib/cadence
fi

if [ -f /etc/cadence/playback-engine.env ] && [ ! -L /etc/cadence/playback-engine.env ]; then
  chown -h root:cadence /etc/cadence/playback-engine.env
  chmod 640 /etc/cadence/playback-engine.env
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl daemon-reload || true
  if systemctl is-active --quiet cadence-playback-engine; then
    systemctl restart cadence-playback-engine || true
  fi
fi

printf "\nCadence Playback Engine installed.\n"
printf "Next steps:\n"
printf "  1. Edit /etc/cadence/playback-engine.env (set CADENCE_ADVERTISED_IP and music roots).\n"
printf "  2. Enable and start: sudo systemctl enable --now cadence-playback-engine\n"
printf "  3. Verify health:    sudo -u cadence cadence-headless --doctor\n"
