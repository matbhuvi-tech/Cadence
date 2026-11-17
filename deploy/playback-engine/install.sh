#!/bin/sh
set -eu

# Release automation substitutes the tag in the published copy.
release_tag='__CADENCE_RELEASE_TAG__'
case "$release_tag" in
  __CADENCE_RELEASE_*) release_tag='' ;;
  *) export CADENCE_INSTALLER_RELEASE="$release_tag" ;;
esac

echo 'Cadence Playback Engine setup'
# TrueNAS manages its Apps as root. Request elevation once, not after a failed deploy.
run_installer() {
  if command -v midclt >/dev/null 2>&1 && [ "$(id -u)" -ne 0 ]; then
    sudo python3 "$1"
    return $?
  fi
  python3 "$1"
}
# Retry transient DNS/network failures; force IPv4 on hosts without IPv6 routing.
get_installer() {
  curl -4 --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 \
    --fail --location --silent --show-error --output "$1" "$2"
}

if ! command -v python3 >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  if [ ! -f /etc/debian_version ] || ! command -v apt-get >/dev/null 2>&1 || command -v midclt >/dev/null 2>&1; then
    echo 'Python 3 and curl are required. Install them using your system instructions and run this script again.' >&2
    exit 1
  fi
  echo 'Python 3 or curl is missing. Installing the required packages (administrator password may be requested).'
  if [ "$(id -u)" = 0 ]; then
    apt-get update
    apt-get install -y python3 curl ca-certificates
  else
    sudo apt-get update
    sudo apt-get install -y python3 curl ca-certificates
  fi
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$script_dir/install.py" ]; then
  run_installer "$script_dir/install.py"
  exit $?
fi
temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT HUP INT TERM
echo 'Downloading the installer from the latest Cadence release...'
if [ -n "$release_tag" ]; then
  installer_url="https://github.com/matbhuvi-tech/Cadence/releases/download/$release_tag/install.py"
  get_installer "$temp_dir/install.py" \
    "$installer_url"
else
  installer_url='https://github.com/matbhuvi-tech/Cadence/releases/latest/download/install.py'
  if ! get_installer "$temp_dir/install.py" "$installer_url"; then
    release_tag=$(python3 -c '
import json, urllib.request
req = urllib.request.Request(
    "https://api.github.com/repos/matbhuvi-tech/Cadence/releases?per_page=10",
    headers={"Accept": "application/vnd.github+json", "User-Agent": "cadence-installer"},
)
with urllib.request.urlopen(req, timeout=15) as resp:
    releases = json.load(resp)
for rel in releases:
    if not rel.get("draft") and rel.get("tag_name"):
        print(rel["tag_name"])
        break
')
    if [ -z "$release_tag" ]; then
      echo 'Could not find a published Cadence release.' >&2
      exit 1
    fi
    export CADENCE_INSTALLER_RELEASE="$release_tag"
    installer_url="https://github.com/matbhuvi-tech/Cadence/releases/download/$release_tag/install.py"
    get_installer "$temp_dir/install.py" \
      "$installer_url"
  fi
fi
run_installer "$temp_dir/install.py"
