#!/bin/sh
set -eu

# Release automation substitutes the tag in the published copy.
release_tag='__CADENCE_RELEASE_TAG__'
case "$release_tag" in
  __CADENCE_RELEASE_*) release_tag='' ;;
  *) export CADENCE_INSTALLER_RELEASE="$release_tag" ;;
esac

echo 'Cadence Playback Engine setup'
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
  exec python3 "$script_dir/install.py"
fi
temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT HUP INT TERM
echo 'Downloading the installer from the latest Cadence release...'
if [ -n "$release_tag" ]; then
  installer_url="https://github.com/matbhuvi-tech/Cadence/releases/download/$release_tag/install.py"
else
  installer_url='https://github.com/matbhuvi-tech/Cadence/releases/latest/download/install.py'
fi
curl --fail --location --silent --show-error --output "$temp_dir/install.py" \
  "$installer_url"
python3 "$temp_dir/install.py"
