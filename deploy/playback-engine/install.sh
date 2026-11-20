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
    sudo env CADENCE_CHECKSUMS_FILE="${CADENCE_CHECKSUMS_FILE:-}" \
      CADENCE_INSTALLER_RELEASE="${CADENCE_INSTALLER_RELEASE:-}" \
      CADENCE_ALLOW_UNVERIFIED="${CADENCE_ALLOW_UNVERIFIED:-}" \
      python3 "$1"
    return $?
  fi
  python3 "$1"
}
# Retry transient DNS/network failures; force IPv4 and HTTPS TLS 1.2+.
get_installer() {
  curl -4 --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 120 \
    --fail --location --silent --show-error --output "$1" "$2"
}
validate_release_tag() {
  tag_val=$1
  case "$tag_val" in
    '' | -* | *..* | */* | *\\*)
      return 1
      ;;
  esac
  python3 - "$tag_val" <<'PY'
import re, sys

tag = sys.argv[1]
if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', tag) or '..' in tag:
    sys.exit(1)
PY
}
checksums_has_entry() {
  python3 - "$1" "$2" <<'PY'
import re, sys

checksums_path, target_name = sys.argv[1:3]
with open(checksums_path, 'r', encoding='utf-8') as fh:
    for raw_line in fh:
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        digest, name = parts[0].lower(), parts[1].strip().lstrip('*')
        if name.startswith('./'):
            name = name[2:]
        if not re.fullmatch(r'[0-9a-f]{64}', digest):
            continue
        if name == target_name:
            sys.exit(0)
sys.exit(1)
PY
}
verify_sha256() {
  python3 - "$1" "$2" "$3" <<'PY'
import hashlib, hmac, re, sys

checksums_path, target_name, file_path = sys.argv[1:4]
expected = None
with open(checksums_path, 'r', encoding='utf-8') as fh:
    for raw_line in fh:
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        digest, name = parts[0].lower(), parts[1].strip().lstrip('*')
        if name.startswith('./'):
            name = name[2:]
        if not re.fullmatch(r'[0-9a-f]{64}', digest):
            continue
        if name == target_name:
            if expected is not None and expected != digest:
                print(
                    f'Conflicting SHA256 entries for {target_name} in {checksums_path}',
                    file=sys.stderr,
                )
                sys.exit(1)
            expected = digest

if not expected:
    print(f'Verification failed: {target_name} missing from {checksums_path}', file=sys.stderr)
    sys.exit(1)

h = hashlib.sha256()
with open(file_path, 'rb') as fh:
    while True:
        chunk = fh.read(65536)
        if not chunk:
            break
        h.update(chunk)
actual = h.hexdigest()
if not hmac.compare_digest(actual, expected):
    print(
        f'SHA256 mismatch for {target_name}: expected {expected}, got {actual}',
        file=sys.stderr,
    )
    sys.exit(1)
print(f'Verified {target_name} SHA256 ({actual[:12]}...)')
PY
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
if [ -n "$release_tag" ] && ! validate_release_tag "$release_tag"; then
  echo "Error: invalid release tag '$release_tag'." >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$script_dir/install.py" ]; then
  if [ -f "$script_dir/cadence_checksums.txt" ]; then
    verify_sha256 "$script_dir/cadence_checksums.txt" "install.py" "$script_dir/install.py"
    if [ -f "$script_dir/compose.yml" ]; then
      verify_sha256 "$script_dir/cadence_checksums.txt" "compose.yml" "$script_dir/compose.yml"
    fi
    if [ -f "$script_dir/compose.hardened.yml" ]; then
      verify_sha256 "$script_dir/cadence_checksums.txt" "compose.hardened.yml" "$script_dir/compose.hardened.yml"
    fi
    export CADENCE_CHECKSUMS_FILE="$script_dir/cadence_checksums.txt"
  fi
  run_installer "$script_dir/install.py"
  exit $?
fi
temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT HUP INT TERM
echo 'Downloading the installer from the latest Cadence release...'
if [ -z "$release_tag" ]; then
  latest_url=$(curl -4 --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 30 \
    --head --location --silent --output /dev/null --write-out '%{url_effective}' \
    'https://github.com/matbhuvi-tech/Cadence/releases/latest' || true)
  case "$latest_url" in
    */releases/tag/*)
      release_tag=${latest_url##*/releases/tag/}
      release_tag=${release_tag%%[?#]*}
      release_tag=${release_tag%%/*}
      ;;
  esac
fi
if [ -z "$release_tag" ]; then
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
' || true)
fi
if [ -z "$release_tag" ]; then
  echo 'Could not find a published Cadence release.' >&2
  exit 1
fi
if ! validate_release_tag "$release_tag"; then
  echo "Error: invalid release tag '$release_tag'." >&2
  exit 1
fi
export CADENCE_INSTALLER_RELEASE="$release_tag"
base_url="https://github.com/matbhuvi-tech/Cadence/releases/download/$release_tag"
get_installer "$temp_dir/install.py" "$base_url/install.py"
get_installer "$temp_dir/compose.yml" "$base_url/compose.yml"

if get_installer "$temp_dir/cadence_checksums.txt" "$base_url/cadence_checksums.txt" 2>/dev/null; then
  verify_sha256 "$temp_dir/cadence_checksums.txt" "install.py" "$temp_dir/install.py"
  verify_sha256 "$temp_dir/cadence_checksums.txt" "compose.yml" "$temp_dir/compose.yml"
  if checksums_has_entry "$temp_dir/cadence_checksums.txt" "compose.hardened.yml"; then
    get_installer "$temp_dir/compose.hardened.yml" "$base_url/compose.hardened.yml"
    verify_sha256 "$temp_dir/cadence_checksums.txt" "compose.hardened.yml" "$temp_dir/compose.hardened.yml"
  fi
  export CADENCE_CHECKSUMS_FILE="$temp_dir/cadence_checksums.txt"
elif [ "${CADENCE_ALLOW_UNVERIFIED:-0}" = "1" ]; then
  echo 'Warning: cadence_checksums.txt unavailable; continuing unverified due to CADENCE_ALLOW_UNVERIFIED=1.' >&2
  if ! get_installer "$temp_dir/compose.hardened.yml" "$base_url/compose.hardened.yml" 2>/dev/null; then
    rm -f -- "$temp_dir/compose.hardened.yml"
  fi
else
  echo 'Error: could not download cadence_checksums.txt to verify install.py and compose.yml integrity.' >&2
  echo 'Set CADENCE_ALLOW_UNVERIFIED=1 only if installing an older release published without checksums.' >&2
  exit 1
fi

run_installer "$temp_dir/install.py"
