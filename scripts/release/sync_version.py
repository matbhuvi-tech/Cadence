#!/usr/bin/env python3
"""Synchronize or verify a single SemVer version across all Cadence manifests."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import re
import sys

SEMVER_RE = re.compile(
    r'^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$'
)


@dataclass(frozen=True)
class ParsedSemVer:
    major: int
    minor: int
    patch: int
    prerelease: str | None

    @property
    def semver(self) -> str:
        base = f'{self.major}.{self.minor}.{self.patch}'
        return f'{base}-{self.prerelease}' if self.prerelease else base


def parse_semver(raw: str) -> ParsedSemVer:
    value = raw.strip()
    match = SEMVER_RE.fullmatch(value)
    if not match:
        raise ValueError(f'Invalid SemVer tag or version: {raw!r}')
    major, minor, patch = int(match.group(1)), int(match.group(2)), int(match.group(3))
    prerelease = match.group(4)
    if prerelease is not None:
        identifiers = prerelease.split('.')
        if any(not ident for ident in identifiers):
            raise ValueError(f'Invalid prerelease identifier in version: {raw!r}')
    return ParsedSemVer(major=major, minor=minor, patch=patch, prerelease=prerelease)


def compute_android_version_code(semver: str | ParsedSemVer) -> int:
    parsed = parse_semver(semver) if isinstance(semver, str) else semver
    if parsed.minor >= 100 or parsed.patch >= 100:
        raise ValueError(
            f'Minor and patch components must be < 100 for Android versionCode encoding: {parsed.semver}'
        )
    if parsed.prerelease is None:
        rank = 99
    else:
        parts = parsed.prerelease.lower().split('.')
        channel = parts[0]
        num = 0
        if len(parts) > 1 and parts[1].isdigit():
            num = int(parts[1])
        if channel == 'alpha':
            rank = min(29, 10 + num)
        elif channel == 'beta':
            rank = min(59, 30 + num)
        elif channel == 'rc':
            rank = min(98, 60 + num)
        else:
            rank = 50
    return parsed.major * 1_000_000 + parsed.minor * 10_000 + parsed.patch * 100 + rank


def _read_text_and_newline(path: Path) -> tuple[str, str]:
    raw = path.read_bytes()
    newline = '\r\n' if b'\r\n' in raw else '\n'
    return raw.decode('utf-8'), newline


def _write_text_with_newline(path: Path, text: str, newline: str) -> None:
    normalized = text.replace('\r\n', '\n')
    if newline == '\r\n':
        normalized = normalized.replace('\n', '\r\n')
    path.write_bytes(normalized.encode('utf-8'))


def _update_top_json_version(path: Path, version: str, check_only: bool) -> list[str]:
    text, newline = _read_text_and_newline(path)
    data = json.loads(text)
    mismatches: list[str] = []
    actual = data.get('version')
    if actual != version:
        mismatches.append(f'{path}: expected version {version!r}, found {actual!r}')
    if not check_only and mismatches:
        data['version'] = version
        _write_text_with_newline(path, json.dumps(data, indent=2, ensure_ascii=False) + '\n', newline)
    return mismatches


def _update_package_lock_version(path: Path, version: str, check_only: bool) -> list[str]:
    text, newline = _read_text_and_newline(path)
    data = json.loads(text)
    mismatches: list[str] = []
    actual_top = data.get('version')
    if actual_top != version:
        mismatches.append(f'{path}: expected top-level version {version!r}, found {actual_top!r}')
    packages = data.get('packages')
    root_pkg = packages.get('') if isinstance(packages, dict) else None
    if not isinstance(root_pkg, dict):
        raise ValueError(f'{path}: missing packages[""] object in package-lock.json')
    actual_pkg = root_pkg.get('version')
    if actual_pkg != version:
        mismatches.append(f'{path}: expected packages[""].version {version!r}, found {actual_pkg!r}')
    if not check_only and mismatches:
        data['version'] = version
        root_pkg['version'] = version
        _write_text_with_newline(path, json.dumps(data, indent=2, ensure_ascii=False) + '\n', newline)
    return mismatches


def _update_cargo_toml(path: Path, version: str, check_only: bool) -> list[str]:
    text, newline = _read_text_and_newline(path)
    lines = text.replace('\r\n', '\n').split('\n')
    in_package = False
    version_idx: int | None = None
    actual: str | None = None
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('['):
            if in_package:
                break
            in_package = stripped == '[package]'
            continue
        if in_package:
            match = re.match(r'^(\s*version\s*=\s*")([^"]+)(".*)$', line)
            if match:
                version_idx = idx
                actual = match.group(2)
                if actual != version and not check_only:
                    lines[idx] = f'{match.group(1)}{version}{match.group(3)}'
                break
    if version_idx is None:
        raise ValueError(f'{path}: could not locate [package] version field')
    if actual == version:
        return []
    if not check_only:
        _write_text_with_newline(path, '\n'.join(lines), newline)
    return [f'{path}: expected [package] version {version!r}, found {actual!r}']


def _update_cargo_lock(path: Path, version: str, check_only: bool) -> list[str]:
    text, newline = _read_text_and_newline(path)
    lines = text.replace('\r\n', '\n').split('\n')
    in_pkg = False
    found_cadence_core = False
    version_idx: int | None = None
    actual: str | None = None
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped == '[[package]]':
            in_pkg = True
            found_cadence_core = False
            continue
        if in_pkg and stripped.startswith('name = '):
            found_cadence_core = stripped == 'name = "cadence-core"'
            continue
        if in_pkg and found_cadence_core:
            match = re.match(r'^(\s*version\s*=\s*")([^"]+)(".*)$', line)
            if match:
                version_idx = idx
                actual = match.group(2)
                if actual != version and not check_only:
                    lines[idx] = f'{match.group(1)}{version}{match.group(3)}'
                break
            if stripped == '' or stripped.startswith('['):
                break
    if version_idx is None:
        raise ValueError(f'{path}: could not locate cadence-core version in Cargo.lock')
    if actual == version:
        return []
    if not check_only:
        _write_text_with_newline(path, '\n'.join(lines), newline)
    return [f'{path}: expected cadence-core version {version!r}, found {actual!r}']


def _update_android_gradle(path: Path, version: str, version_code: int, check_only: bool) -> list[str]:
    text, newline = _read_text_and_newline(path)
    lines = text.replace('\r\n', '\n').split('\n')
    code_idx: int | None = None
    name_idx: int | None = None
    actual_code: int | None = None
    actual_name: str | None = None
    for idx, line in enumerate(lines):
        code_match = re.match(r'^(\s*versionCode\s+)(\d+)(\s*)$', line)
        if code_match and code_idx is None:
            code_idx = idx
            actual_code = int(code_match.group(2))
            if actual_code != version_code and not check_only:
                lines[idx] = f'{code_match.group(1)}{version_code}{code_match.group(3)}'
            continue
        name_match = re.match(r'^(\s*versionName\s+")([^"]+)(".*)$', line)
        if name_match and name_idx is None:
            name_idx = idx
            actual_name = name_match.group(2)
            if actual_name != version and not check_only:
                lines[idx] = f'{name_match.group(1)}{version}{name_match.group(3)}'
    if code_idx is None or name_idx is None:
        raise ValueError(f'{path}: could not locate versionCode and versionName')
    mismatches: list[str] = []
    if actual_code != version_code:
        mismatches.append(f'{path}: expected versionCode {version_code}, found {actual_code}')
    if actual_name != version:
        mismatches.append(f'{path}: expected versionName {version!r}, found {actual_name!r}')
    if not check_only and mismatches:
        _write_text_with_newline(path, '\n'.join(lines), newline)
    return mismatches


def sync_versions(root: Path, raw_version: str, check_only: bool = False) -> tuple[ParsedSemVer, int, list[str]]:
    parsed = parse_semver(raw_version)
    version = parsed.semver
    version_code = compute_android_version_code(parsed)

    mismatches: list[str] = []
    mismatches.extend(_update_top_json_version(root / 'package.json', version, check_only))
    mismatches.extend(_update_package_lock_version(root / 'package-lock.json', version, check_only))
    mismatches.extend(_update_top_json_version(root / 'pwa' / 'package.json', version, check_only))
    mismatches.extend(_update_package_lock_version(root / 'pwa' / 'package-lock.json', version, check_only))
    mismatches.extend(_update_top_json_version(root / 'src-tauri' / 'tauri.conf.json', version, check_only))
    mismatches.extend(_update_cargo_toml(root / 'src-tauri' / 'Cargo.toml', version, check_only))
    mismatches.extend(_update_cargo_lock(root / 'src-tauri' / 'Cargo.lock', version, check_only))
    mismatches.extend(
        _update_android_gradle(root / 'pwa' / 'android' / 'app' / 'build.gradle', version, version_code, check_only)
    )
    return parsed, version_code, mismatches


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Sync or verify Cadence manifest versions from a SemVer tag.')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--set', dest='set_version', metavar='VERSION', help='Update all manifests to VERSION (e.g. v0.2.0 or 0.2.0-rc.1)')
    mode.add_argument('--check', dest='check_version', metavar='VERSION', help='Verify all manifests match VERSION without modifying files')
    parser.add_argument(
        '--root',
        type=Path,
        default=Path(__file__).resolve().parents[2],
        help='Repository root directory (defaults to repo root)',
    )
    args = parser.parse_args(argv)

    raw_version = args.set_version if args.set_version is not None else args.check_version
    check_only = args.check_version is not None
    try:
        parsed, version_code, mismatches = sync_versions(args.root.resolve(), raw_version, check_only=check_only)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f'sync_version error: {exc}', file=sys.stderr)
        return 2

    if check_only:
        if mismatches:
            print(f'Version mismatch for {parsed.semver} (Android versionCode {version_code}):', file=sys.stderr)
            for item in mismatches:
                print(f'  - {item}', file=sys.stderr)
            return 1
        print(f'All manifests match {parsed.semver} (Android versionCode {version_code}).')
        return 0

    print(
        f'Synchronized {len(mismatches)} drift(s) to {parsed.semver} '
        f'(Android versionCode {version_code}).'
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
