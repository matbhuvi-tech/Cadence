#!/usr/bin/env python3
"""Interactive installer and repeatable redeployer for the Linux Playback Engine."""
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
from datetime import datetime, timezone
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request

REPOSITORY = 'matbhuvi-tech/Cadence'
IMAGE = 'ghcr.io/matbhuvi-tech/cadence-playback-engine'
APP = 'cadence-playback-engine'


class InstallError(Exception):
    pass


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def valid_address(value):
    try:
        ip = ipaddress.ip_address(value)
        return (ip.version == 4 and not (ip.is_loopback or ip.is_link_local or
                ip.is_unspecified or ip.is_multicast or ip.is_reserved or
                ip in ipaddress.ip_network('100.64.0.0/10')))
    except ValueError:
        return False


def valid_tag(value):
    return bool(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', value))


def paths_separate(data, music):
    a, b = Path(data).resolve(), Path(music).resolve()
    return a != b and a not in b.parents and b not in a.parents


def read_env_values(path):
    """Load values produced by write_env; never source .env as shell code."""
    result = {}
    if not path.exists():
        return result
    for line in path.read_text(encoding='utf-8').splitlines():
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            continue
        if value.startswith("'") and value.endswith("'") and len(value) >= 2:
            inner = value[1:-1]
            if not re.search(r"(?<!\\)'", inner):
                result[key] = inner.replace("\\'", "'")
                continue
        try:
            parts = shlex.split(value)
        except ValueError as exc:
            raise InstallError(f'Invalid existing settings in {path}: {exc}') from exc
        result[key] = parts[0] if parts else ''
    return result


def find_existing_install(truenas, home):
    """Locate our installer-managed deployment, without inspecting personal folders."""
    if not truenas:
        target = home / 'cadence-playback-engine'
        return target if (target / '.env').is_file() and (target / 'compose.yml').is_file() else None
    root = Path('/mnt')
    candidates = []
    for pool in root.iterdir():
        if not pool.is_dir() or pool.name.startswith('.'):
            continue
        target = pool / 'cadence-installation'
        if (target / '.env').is_file() and (target / 'compose.yml').is_file():
            candidates.append(target)
    if len(candidates) > 1:
        raise InstallError('Multiple Cadence installations were found. Select the intended pool manually; no changes made.')
    return candidates[0] if candidates else None


def backup_deployment_files(destination):
    """Back up only installer-managed config; never modify user library data."""
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = destination / f'backup-before-redeploy-{stamp}'
    index = 1
    while backup.exists():
        backup = destination / f'backup-before-redeploy-{stamp}-{index}'
        index += 1
    backup.mkdir(mode=0o700)
    for name in ('.env', 'compose.yml'):
        if (destination / name).exists():
            shutil.copy2(destination / name, backup / name)
    print(f'Existing deployment configuration backed up to {backup}')
    return backup


def write_env(path, values):
    def quote(value):
        if '\n' in value or '\r' in value or '\x00' in value:
            raise InstallError('Settings cannot contain line breaks or NUL characters.')
        return "'" + value.replace("'", "\\'") + "'"
    path.write_text(''.join(f'{key}={quote(str(value))}\n' for key, value in values.items()), encoding='utf-8')
    path.chmod(0o600)


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Cadence-Playback-Engine-Installer', 'Accept': 'application/vnd.github+json'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.read(2_000_000).decode('utf-8')
    except (urllib.error.URLError, OSError, UnicodeError) as exc:
        raise InstallError(f'Could not download {url}: {exc}') from exc


def parse_checksums(text):
    """Parse SHA256SUMS manifest text into {filename: lowercase_hex_digest}."""
    digests = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        digest, name = parts[0].lower(), parts[1].strip().lstrip('*')
        if name.startswith('./'):
            name = name[2:]
        if re.fullmatch(r'[0-9a-f]{64}', digest) and name:
            if name in digests and digests[name] != digest:
                raise InstallError(f'Conflicting checksum entries for {name} in cadence_checksums.txt.')
            digests[name] = digest
    return digests


def verify_release_digest(filename, content_text, tag):
    """Verify downloaded release asset text against cadence_checksums.txt (fail closed)."""
    if not tag:
        raise InstallError(f'Cannot verify {filename} without a release tag.')
    checksums_text = None
    env_path = os.environ.get('CADENCE_CHECKSUMS_FILE', '').strip()
    if env_path and os.environ.get('CADENCE_INSTALLER_RELEASE') == tag:
        candidate = Path(env_path)
        if candidate.is_file():
            checksums_text = candidate.read_text(encoding='utf-8')
    if checksums_text is None:
        try:
            checksums_text = fetch(
                f'https://github.com/{REPOSITORY}/releases/download/{tag}/cadence_checksums.txt'
            )
        except InstallError as exc:
            if os.environ.get('CADENCE_ALLOW_UNVERIFIED') == '1':
                print(
                    f'Warning: cadence_checksums.txt unavailable for {tag}; '
                    f'skipping digest verification for {filename} due to CADENCE_ALLOW_UNVERIFIED=1.',
                    file=sys.stderr,
                )
                return
            raise InstallError(
                f'Could not download cadence_checksums.txt for {tag} to verify {filename}. '
                'Set CADENCE_ALLOW_UNVERIFIED=1 only for legacy releases without checksums.'
            ) from exc

    checksums = parse_checksums(checksums_text)
    expected = checksums.get(filename)
    if not expected:
        raise InstallError(f'{filename} is missing from cadence_checksums.txt for {tag}.')
    actual = hashlib.sha256(content_text.encode('utf-8')).hexdigest()
    if not hmac.compare_digest(actual, expected):
        raise InstallError(f'SHA256 mismatch for {filename}: expected {expected}, got {actual}.')
    print(f'Verified {filename} SHA256 ({actual[:12]}...)')


def latest_release():
    try:
        return json.loads(fetch(f'https://api.github.com/repos/{REPOSITORY}/releases/latest'))['tag_name']
    except (InstallError, ValueError, KeyError):
        pass
    try:
        releases = json.loads(fetch(f'https://api.github.com/repos/{REPOSITORY}/releases?per_page=10'))
        for rel in releases:
            if not rel.get('draft') and rel.get('tag_name'):
                return rel['tag_name']
    except (InstallError, ValueError, KeyError, TypeError) as exc:
        raise InstallError('GitHub did not return a valid release. Enter a published tag manually.') from exc
    raise InstallError('GitHub did not return a valid release. Enter a published tag manually.')


def default_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(('192.0.2.1', 80))
            address = sock.getsockname()[0]
            return address if valid_address(address) else ''
    except OSError:
        return ''


def prompt(label, default='', check=None, error='Please enter a valid value.'):
    while True:
        suffix = f' [{default}]' if default else ''
        value = input(f'{label}{suffix}: ').strip() or default
        if value and (check is None or check(value)):
            return value
        print(error)


def choose_profile(default_profile='standard'):
    default_norm = 'hardened' if str(default_profile).strip().lower() == 'hardened' else 'standard'
    default_choice = '2' if default_norm == 'hardened' else '1'
    print('\nDeployment profile:')
    print('  1. Standard (Default — SMB mounting & Curate read/write; root + SYS_ADMIN for mount.cifs)')
    print('  2. Hardened Read-Only (Non-root UID 568, IPC_LOCK only, local/NAS :ro, no runtime SMB)')
    while True:
        raw = input(f'Select profile [1/2] [{default_choice}]: ').strip().lower() or default_choice
        if raw in ('1', 'standard'):
            return 'standard'
        if raw in ('2', 'hardened'):
            return 'hardened'
        print('Enter 1 (Standard) or 2 (Hardened Read-Only).')


def truenas_music_picker(allow_skip=True):
    """Browse mounted TrueNAS pools/datasets without shell quoting."""
    root = Path('/mnt')
    excluded = {'ix-applications', 'ix-apps', '.system', 'iocage'}
    current = root
    while True:
        try:
            children = sorted(
                (p for p in current.iterdir() if p.is_dir() and p.name not in excluded),
                key=lambda p: p.name.casefold(),
            )
        except OSError as exc:
            print(f'Cannot list {current}: {exc}')
            children = []
        print(f'\nMusic directory browser — {current}')
        for i, path in enumerate(children, 1):
            print(f'  {i}. {path.name}/')
        print('  s. Select this folder' if current != root else '  s. Select (unavailable at /mnt)')
        print('  u. Up one level')
        if allow_skip:
            print('  0. Skip local folder (add SMB shares in Cadence later)')
        print('  m. Enter an absolute path manually')
        choice = input('Choose a number, s, u, or m: ').strip().lower()
        if choice == '0':
            if allow_skip:
                return ''
            print('Hardened Read-Only mode requires selecting a local/NAS music folder.')
            continue
        if choice.isdigit() and 1 <= int(choice) <= len(children):
            current = children[int(choice) - 1]
        elif choice == 'u':
            current = current.parent if current != root else root
        elif choice == 's' and current != root:
            print(f'Selected music folder: {current}')
            return str(current)
        elif choice == 'm':
            raw = input('Absolute music directory (no quotes needed): ').strip()
            if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ("'", '"'):
                raw = raw[1:-1]
            candidate = Path(raw)
            if candidate.is_absolute() and candidate.is_dir() and root in candidate.resolve().parents:
                return str(candidate.resolve())
            print('Enter an existing directory under /mnt.')
        else:
            print('Invalid selection.')


def prompt_music_folder(truenas, profile):
    if truenas:
        return truenas_music_picker(allow_skip=(profile == 'standard'))
    if profile == 'standard':
        music = prompt('Existing local music folder (type - for none)', '-',
                       lambda value: value == '-' or (Path(value).is_absolute() and Path(value).is_dir()),
                       'Enter an existing absolute folder path, or - for none.')
        return '' if music == '-' else music
    return prompt('Existing local music folder (required for Hardened Read-Only)', '',
                  lambda value: Path(value).is_absolute() and Path(value).is_dir(),
                  'Enter an existing absolute folder path.')


def suggested_truenas_data_path(music):
    """Suggest an isolated dataset directory even if no local music is selected."""
    if music:
        pool = Path(music).resolve().relative_to('/mnt').parts[0]
    else:
        pools = sorted((p for p in Path('/mnt').iterdir()
                        if p.is_dir() and not p.name.startswith('.') and p.name not in
                        ('ix-applications', 'ix-apps', '.system', 'iocage')),
                       key=lambda p: p.name.casefold())
        if not pools:
            return ''
        print('Storage pools:')
        for idx, item in enumerate(pools, 1):
            print(f'  {idx}. {item}')
        selected = prompt('Storage pool number', '1',
                          lambda value: value.isdigit() and 1 <= int(value) <= len(pools))
        pool = pools[int(selected) - 1].name
    return str(Path('/mnt') / pool / 'cadence-data')


def test_as_cadence(directory, mode):
    """Verify actual uid 568 access, including ACLs, without broad chmod/chown."""
    probe = r'''import os, sys, uuid
path, mode = sys.argv[1:]
if mode == 'read':
    with os.scandir(path) as entries:
        next(entries, None)
else:
    name = os.path.join(path, '.cadence-write-probe-' + uuid.uuid4().hex)
    fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    os.unlink(name)
'''
    def become_cadence():
        os.setgroups([])
        os.setgid(568)
        os.setuid(568)
    completed = subprocess.run([sys.executable, '-c', probe, str(directory), mode],
                               preexec_fn=become_cadence, capture_output=True, text=True)
    return completed.returncode == 0, completed.stderr.strip()


def check_permissions(data_path, music):
    success, error = test_as_cadence(data_path, 'write')
    if not success:
        raise InstallError(f'Cadence UID 568 cannot write to {data_path}: {error}. '
                           'Choose a dedicated cadence-data directory, or grant UID 568 '
                           'write permission using the TrueNAS ACL editor. '
                           'No existing directory permissions were changed.')
    if music:
        success, error = test_as_cadence(music, 'read')
        if not success:
            raise InstallError(f'Cadence UID 568 cannot read {music}: {error}. '
                               'Grant UID 568 read/traverse permissions using the TrueNAS ACL editor.')


def local_compose(music, profile='standard'):
    """Use matching local Compose when supplied; support standard (SMB) and hardened profiles."""
    if profile not in ('standard', 'hardened'):
        raise InstallError(f'Unsupported deployment profile: {profile}')
    template_name = 'compose.hardened.yml' if profile == 'hardened' else 'compose.yml'
    nearby = Path(__file__).resolve().with_name(template_name)
    installer_release = os.environ.get('CADENCE_INSTALLER_RELEASE', '').strip()
    bootstrap_checksums = os.environ.get('CADENCE_CHECKSUMS_FILE', '').strip()
    tag = os.environ.get('CADENCE_ACTIVE_TAG', '').strip()
    allow_nearby = not (bootstrap_checksums and installer_release and tag and tag != installer_release)
    if allow_nearby and nearby.is_file():
        compose = nearby.read_text(encoding='utf-8')
        print(f'Using Compose template alongside installer: {nearby}')
    else:
        if not tag:
            raise InstallError('Release tag is required to download Compose template.')
        try:
            compose = fetch(f'https://github.com/{REPOSITORY}/releases/download/{tag}/{template_name}')
        except InstallError:
            compose = fetch(f'https://raw.githubusercontent.com/{REPOSITORY}/{tag}/deploy/playback-engine/{template_name}')
        verify_release_digest(template_name, compose, tag)
    if profile == 'hardened':
        if not music:
            raise InstallError('Hardened Read-Only mode requires an existing local or NAS music directory.')
        if 'user: "568:568"' not in compose or 'CADENCE_MUSIC_READ_ONLY: "true"' not in compose:
            raise InstallError('The Compose template does not match the Hardened Read-Only profile.')
        if 'SYS_ADMIN' in compose or 'apparmor:unconfined' in compose:
            raise InstallError('The Hardened Read-Only Compose template must not request SYS_ADMIN or apparmor:unconfined.')
        return compose
    if 'SYS_ADMIN' not in compose or 'CADENCE_MUSIC_READ_ONLY: "false"' not in compose:
        raise InstallError('The published Compose template does not support dynamic read/write SMB. '
                           'Publish the updated Compose and Docker image together, or run the '
                           'updated install.py and compose.yml from the same directory.')
    if not music:
        pattern = r'(?m)^      # LOCAL_MUSIC_VOLUME_START\n.*?^      # LOCAL_MUSIC_VOLUME_END\n'
        compose, count = re.subn(pattern, '', compose, flags=re.DOTALL)
        if not count:
            raise InstallError('This Compose template requires a local music directory. '
                               'Use the updated compose.yml alongside install.py.')
    else:
        compose = compose.replace('      # LOCAL_MUSIC_VOLUME_START\n', '')
        compose = compose.replace('      # LOCAL_MUSIC_VOLUME_END\n', '')
    return compose



def privileged(args):
    return args if os.geteuid() == 0 else ['sudo', *args]


def ensure_docker(truenas=False):
    if shutil.which('docker') and subprocess.run(['docker', 'compose', 'version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return
    if truenas:
        raise InstallError('TrueNAS Apps and Docker Compose must be available. Configure Apps storage and use a supported TrueNAS version; the installer will not alter system packages on a NAS.')
    if not shutil.which('apt-get') or not Path('/etc/debian_version').exists():
        raise InstallError('Docker Engine and Docker Compose v2 are required. Install them using your Linux distribution instructions and rerun this installer.')
    print('Docker Engine or Docker Compose v2 is missing. The installer will use apt to install missing packages; your administrator password may be requested.')
    run(privileged(['apt-get', 'update']))
    packages = []
    if not shutil.which('docker'):
        packages.append('docker.io')
    if not shutil.which('docker') or subprocess.run(['docker', 'compose', 'version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        candidates = ('docker-compose-v2', 'docker-compose-plugin')
        for package in candidates:
            result = subprocess.run(['apt-cache', 'policy', package], capture_output=True, text=True)
            if re.search(r'Candidate:\s*(?!\(none\))\S+', result.stdout):
                packages.append(package)
                break
        else:
            raise InstallError('No Docker Compose v2 package was found in your configured apt repositories. Install Docker and the Compose plugin, then rerun.')
    if packages:
        run(privileged(['apt-get', 'install', '-y', *packages]))
    if subprocess.run(['docker', 'compose', 'version'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        raise InstallError('Docker Compose v2 is unavailable after installation.')


def docker_prefix(truenas=False):
    if subprocess.run(['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return ['docker']
    print('Checking Docker access with administrator privileges...')
    prefix = privileged(['docker'])
    if subprocess.run([*prefix, 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        if not truenas and shutil.which('systemctl'):
            print('Starting the Docker service...')
            run(privileged(['systemctl', 'start', 'docker']))
        if subprocess.run([*prefix, 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            raise InstallError('Docker is not running or is inaccessible. Start the Docker service and rerun this installer.')
    return prefix


def deploy_truenas_app(resolved_json, existing):
    config = json.loads(resolved_json)
    if existing:
        print('Updating existing Cadence TrueNAS app (same release tag allowed).')
        run(['midclt', 'call', '--job', 'app.update', APP,
             json.dumps({'custom_compose_config': config})])
    else:
        print('Creating Cadence TrueNAS app.')
        payload = {'app_name': APP, 'custom_app': True, 'custom_compose_config': config}
        run(['midclt', 'call', '--job', 'app.create', json.dumps(payload)])


def truenas_app_exists():
    response = run(['midclt', 'call', 'app.query', json.dumps([['id', '=', APP]])],
                   capture_output=True, text=True)
    apps = json.loads(response.stdout)
    if len(apps) > 1:
        raise InstallError('Ambiguous TrueNAS Cadence app query returned multiple entries.')
    if apps and not apps[0].get('custom_app', False):
        raise InstallError('An app with the Cadence name exists but is not a custom app; refusing to replace it.')
    return bool(apps)



def check_cifs_support(docker, image_ref):
    # Verify the selected published image actually contains the CIFS helper before creating the app.
    print('Checking the published engine image for dynamic SMB support...')
    cifs_check = subprocess.run(
        [*docker, 'run', '--rm', '--entrypoint', '/bin/sh',
         image_ref, '-c', 'command -v mount.cifs >/dev/null'],
        capture_output=True, text=True,
    )
    if cifs_check.returncode:
        raise InstallError('The selected release image does not include mount.cifs. '
                           'Build and publish the updated Dockerfile before installing this release.')


def main():
    if sys.platform != 'linux':
        raise InstallError('Run this installer on the Linux or TrueNAS SCALE machine hosting the engine.')
    arch = os.uname().machine
    if arch not in ('x86_64', 'aarch64'):
        raise InstallError(f'Unsupported architecture: {arch}. AMD64 and ARM64 are supported.')
    truenas = bool(shutil.which('midclt') and (Path('/etc/truenas-release').exists() or Path('/etc/version').exists()))
    if truenas and os.geteuid() != 0:
        raise InstallError('On TrueNAS, run this installer from the system shell as root (or use sudo).')
    import pwd
    sudo_user = os.environ.get('SUDO_USER')
    home = Path(pwd.getpwnam(sudo_user).pw_dir) if sudo_user else Path.home()
    existing_dir = find_existing_install(truenas, home)
    existing_env = read_env_values(existing_dir / '.env') if existing_dir else {}
    existing_app = truenas_app_exists() if truenas else False
    if existing_app and not existing_dir:
        raise InstallError('TrueNAS Cadence app exists but its installer-managed configuration was not found. '
                           'Refusing to overwrite an unknown installation.')
    print('\nCadence Playback Engine setup\nPress Enter to accept suggestions.\n'
          'Local music is optional; SMB shares can be added inside Cadence with read/write access.\n')
    if existing_dir:
        print(f'Existing deployment found: {existing_dir}')
        print('This run will update/redeploy it, including when using the SAME release tag.')
        confirmation = input('Update this installation, preserving its data paths? [Y/n]: ').strip().lower()
        if confirmation not in ('', 'y', 'yes'):
            raise InstallError('Cancelled; no changes made.')
    try:
        suggested_tag = (os.environ.get('CADENCE_INSTALLER_RELEASE') or
                         existing_env.get('CADENCE_IMAGE', '').removeprefix(IMAGE + ':') or
                         latest_release())
    except InstallError as exc:
        print(exc)
        suggested_tag = ''
    tag = prompt('Release tag', suggested_tag, valid_tag, 'Enter a valid published release tag, such as v1.2.3.')
    address = prompt('This machine’s LAN IPv4 address',
                     existing_env.get('CADENCE_ADVERTISED_IP') or default_ip(), valid_address,
                     'Enter a reachable LAN IPv4 address (not loopback or link-local).')
    profile = choose_profile(existing_env.get('CADENCE_DEPLOYMENT_PROFILE', 'standard'))
    if existing_dir:
        music = existing_env.get('CADENCE_HOST_MUSIC_DIR', '')
        data = existing_env.get('CADENCE_HOST_DATA_DIR', '')
        if not data or not Path(data).is_absolute():
            raise InstallError('Existing installation has no valid data directory; stopping to protect its state.')
        if music and not Path(music).is_dir():
            raise InstallError(f'Previously configured music directory is missing: {music}')
        if profile == 'hardened' and not music:
            print('Hardened Read-Only mode requires a local/NAS music folder instead of SMB-only mode.')
            music = prompt_music_folder(truenas, profile)
        else:
            print(f'Keeping existing music directory: {music or "none (SMB-only)"}')
        print(f'Keeping existing persistent data directory: {data}')
        destination = existing_dir
    else:
        music = prompt_music_folder(truenas, profile)
        default_data = suggested_truenas_data_path(music) if truenas else '/var/lib/cadence'
        if truenas:
            print(f'Recommended persistent engine data directory: {default_data}')
        data = prompt('Persistent engine data folder', default_data,
                      lambda value: Path(value).is_absolute(), 'Enter an absolute folder path.')
        destination = Path(data).parent / 'cadence-installation' if truenas else home / 'cadence-playback-engine'
        if (destination / '.env').exists() or (destination / 'compose.yml').exists():
            raise InstallError(f'Unexpected installation at {destination}; rerun after checking its identity.')
    if music and not paths_separate(data, music):
        raise InstallError('The data and music folders must be separate and must not contain one another.')
    if truenas and (Path('/mnt') not in Path(data).resolve().parents or
                    (music and Path('/mnt') not in Path(music).resolve().parents)):
        raise InstallError('On TrueNAS choose data and music paths beneath /mnt on persistent storage.')
    os.environ['CADENCE_ACTIVE_TAG'] = tag
    compose = local_compose(music, profile)
    ensure_docker(truenas)
    docker = docker_prefix(truenas)
    run([*docker, 'pull', f'{IMAGE}:{tag}'])
    if profile == 'standard':
        check_cifs_support(docker, f'{IMAGE}:{tag}')
    if not truenas and not existing_dir:
        existing = run([*docker, 'ps', '-a', '--filter', 'label=com.docker.compose.project=cadence-playback-engine', '--format', '{{.ID}}'], capture_output=True, text=True)
        if existing.stdout.strip():
            raise InstallError('A Cadence Compose deployment exists but its managed configuration was not found.')
    destination.mkdir(parents=True, exist_ok=True)
    data_path = Path(data)
    if not data_path.exists():
        if not data_path.parent.is_dir():
            raise InstallError(f'The parent folder {data_path.parent} must already exist.')
        run(privileged(['mkdir', '-m', '700', '--', str(data_path)]))
        run(privileged(['chown', '568:568', str(data_path)]))
    if not data_path.is_dir():
        raise InstallError('The engine data path is not a directory.')
    check_permissions(data_path, music)
    compose_file = destination / 'compose.yml'
    backup_dir = backup_deployment_files(destination) if existing_dir else None
    compose_file.write_text(compose, encoding='utf-8')
    write_env(destination / '.env', {
        'CADENCE_IMAGE': f'{IMAGE}:{tag}',
        'CADENCE_ADVERTISED_IP': address,
        'CADENCE_DEPLOYMENT_PROFILE': profile,
        'CADENCE_HOST_DATA_DIR': str(data_path.resolve()),
        'CADENCE_HOST_MUSIC_DIR': str(Path(music).resolve()) if music else '',
        'CADENCE_LABEL': 'Cadence Playback Engine',
    })
    command = [*docker, 'compose', '-p', APP, '--project-directory', str(destination), '-f', str(compose_file)]
    try:
        run([*command, 'config', '--quiet'])
    except Exception:
        if backup_dir:
            for name in ('.env', 'compose.yml'):
                old = backup_dir / name
                if old.exists():
                    shutil.copy2(old, destination / name)
        raise
    if truenas:
        result = run([*command, 'config', '--format', 'json'], capture_output=True, text=True)
        print('Submitting Cadence configuration to TrueNAS. Apps storage must already be configured.')
        deploy_truenas_app(result.stdout, existing_app)
        print('App submitted to TrueNAS. Confirm it is Running and Healthy in Apps.')
    else:
        print('Downloading the release and starting the Playback Engine...')
        run([*command, 'pull'])
        probe_cmd = 'test -w /var/lib/cadence && test -r /music' if music else 'test -w /var/lib/cadence'
        try:
            run([*command, 'run', '--rm', '--no-deps', '--entrypoint', '/bin/sh', 'playback-engine',
                 '-c', probe_cmd])
        except subprocess.CalledProcessError as exc:
            raise InstallError('The engine cannot access the folders. Give UID/GID 568 read/search access to music and write access to data, including their parent folders.') from exc
        run([*command, 'up', '-d', '--force-recreate' if existing_dir else '--remove-orphans', '--wait', '--wait-timeout', '120'])
        print(f'Engine is ready. Check status with: cd "{destination}" && docker compose -p {APP} ps')
    if backup_dir:
        print(f'Previous installer configuration: {backup_dir}')
    print(f'Engine address: https://{address}:4040')
    print('If startup fails, check Apps > Cadence > Logs. Do not chmod or chown your entire library.')


if __name__ == '__main__':
    try:
        main()
    except (InstallError, subprocess.CalledProcessError, OSError, ValueError, EOFError, KeyboardInterrupt) as exc:
        print(f'\nSetup stopped: {exc}', file=sys.stderr)
        sys.exit(1)
