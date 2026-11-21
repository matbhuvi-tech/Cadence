#!/bin/sh
set -eu

if ! getent group cadence >/dev/null 2>&1; then
  if ! getent group 568 >/dev/null 2>&1; then
    groupadd --system --gid 568 cadence
  else
    groupadd --system cadence
  fi
fi

if ! getent passwd cadence >/dev/null 2>&1; then
  nologin_shell="/usr/sbin/nologin"
  if [ ! -x "$nologin_shell" ]; then
    nologin_shell="/sbin/nologin"
  fi
  if ! getent passwd 568 >/dev/null 2>&1; then
    useradd --system --uid 568 --gid cadence --home-dir /var/lib/cadence \
      --no-create-home --shell "$nologin_shell" cadence
  else
    useradd --system --gid cadence --home-dir /var/lib/cadence \
      --no-create-home --shell "$nologin_shell" cadence
  fi
fi
