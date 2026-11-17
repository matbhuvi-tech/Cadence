#!/usr/bin/env python3
"""Interactive, first-time installer for the Linux Playback Engine."""
import ipaddress
import json
import os
from pathlib import Path
import re
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


def ensure_fresh(directory):
    if any((directory / name).exists() for name in ('.env', 'compose.yml')):
        raise InstallError(f'An installation already exists at {directory}. Use the upgrade guide; no files were changed.')


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


def latest_release():
    try:
        return json.loads(fetch(f'https://api.github.com/repos/{REPOSITORY}/releases/latest'))['tag_name']
    except (ValueError, KeyError) as exc:
        raise InstallError('GitHub did not return a valid release. Enter a published tag manually.') from exc


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


def create_truenas_app(compose_path, resolved_json):
    del compose_path
    config = json.loads(resolved_json)
    payload = {'app_name': APP, 'custom_app': True, 'custom_compose_config': config}
    run(['midclt', 'call', '--job', 'app.create', json.dumps(payload)])


def main():
    if sys.platform != 'linux':
        raise InstallError('Run this installer on the Linux or TrueNAS SCALE machine hosting the engine.')
    arch = os.uname().machine
    if arch not in ('x86_64', 'aarch64'):
        raise InstallError(f'Unsupported architecture: {arch}. AMD64 and ARM64 are supported.')
    truenas = bool(shutil.which('midclt') and (Path('/etc/truenas-release').exists() or Path('/etc/version').exists()))
    if truenas and os.geteuid() != 0:
        raise InstallError('On TrueNAS, run this installer from the system shell as root (or use sudo).')
    print('\nCadence Playback Engine setup\nPress Enter to accept a suggested value. Your music is mounted read-only.\n')
    try:
        suggested_tag = latest_release()
    except InstallError as exc:
        print(exc)
        suggested_tag = ''
    tag = prompt('Release tag', suggested_tag, valid_tag, 'Enter a valid published release tag, such as v1.2.3.')
    address = prompt('This machine’s LAN IPv4 address', default_ip(), valid_address, 'Enter a reachable LAN IPv4 address (not loopback or link-local).')
    music = prompt('Existing folder containing your music', '', lambda s: Path(s).is_absolute() and Path(s).is_dir(), 'Enter an absolute path to an existing folder.')
    sudo_user = os.environ.get('SUDO_USER')
    import pwd
    home = Path(pwd.getpwnam(sudo_user).pw_dir) if sudo_user else Path.home()
    default_data = '' if truenas else '/var/lib/cadence'
    data = prompt('Persistent engine data folder', default_data, lambda s: Path(s).is_absolute(), 'Enter an absolute folder path.')
    if not paths_separate(data, music):
        raise InstallError('The data and music folders must be separate and must not contain one another.')
    if truenas and (Path('/mnt') not in Path(data).resolve().parents or Path('/mnt') not in Path(music).resolve().parents):
        raise InstallError('On TrueNAS choose data and music paths beneath /mnt on persistent storage.')
    destination = Path(data).parent / 'cadence-installation' if truenas else home / 'cadence-playback-engine'
    ensure_fresh(destination)
    if truenas:
        existing = run(['midclt', 'call', 'app.query', json.dumps([['id', '=', APP]])], capture_output=True, text=True)
        if json.loads(existing.stdout):
            raise InstallError('The TrueNAS app already exists. Use the upgrade guide; it was not changed.')
    compose = fetch(f'https://raw.githubusercontent.com/{REPOSITORY}/{tag}/deploy/playback-engine/compose.yml')
    ensure_docker(truenas)
    docker = docker_prefix(truenas)
    if not truenas:
        existing = run([*docker, 'ps', '-a', '--filter', 'label=com.docker.compose.project=cadence-playback-engine', '--format', '{{.ID}}'], capture_output=True, text=True)
        if existing.stdout.strip():
            raise InstallError('A Cadence Playback Engine Compose installation already exists. Use the upgrade guide; it was not changed.')
    destination.mkdir(parents=True, exist_ok=True)
    data_path = Path(data)
    if not data_path.exists():
        if not data_path.parent.is_dir():
            raise InstallError(f'The parent folder {data_path.parent} must already exist.')
        run(privileged(['mkdir', '-m', '700', '--', str(data_path)]))
        run(privileged(['chown', '568:568', str(data_path)]))
    if not data_path.is_dir():
        raise InstallError('The engine data path is not a directory.')
    compose_file = destination / 'compose.yml'
    compose_file.write_text(compose, encoding='utf-8')
    write_env(destination / '.env', {'CADENCE_IMAGE': f'{IMAGE}:{tag}', 'CADENCE_ADVERTISED_IP': address,
              'CADENCE_HOST_DATA_DIR': str(data_path.resolve()), 'CADENCE_HOST_MUSIC_DIR': str(Path(music).resolve()),
              'CADENCE_LABEL': 'Cadence Playback Engine'})
    command = [*docker, 'compose', '-p', APP, '--project-directory', str(destination), '-f', str(compose_file)]
    run([*command, 'config', '--quiet'])
    if truenas:
        result = run([*command, 'config', '--format', 'json'], capture_output=True, text=True)
        print('Creating the app in TrueNAS. Apps storage must already be configured.')
        create_truenas_app(compose_file, result.stdout)
        print('Installed. Open Apps in TrueNAS to check the app status and logs.')
    else:
        print('Downloading the release and starting the Playback Engine...')
        run([*command, 'pull'])
        try:
            run([*command, 'run', '--rm', '--no-deps', '--entrypoint', '/bin/sh', 'playback-engine',
                 '-c', 'test -r /music && test -x /music && test -w /var/lib/cadence'])
        except subprocess.CalledProcessError as exc:
            raise InstallError('The engine cannot access the folders. Give UID/GID 568 read/search access to music and write access to data, including their parent folders.') from exc
        run([*command, 'up', '-d', '--wait', '--wait-timeout', '120'])
        print(f'Engine is ready. Check status with: cd "{destination}" && docker compose -p {APP} ps')
    print(f'Engine address: https://{address}:4040')
    print(f'Pairing token is stored in {data_path / "pairing-token"}. Keep it private.')
    print('If startup fails, check the app logs and grant UID/GID 568 access to both folders.')


if __name__ == '__main__':
    try:
        main()
    except (InstallError, subprocess.CalledProcessError, OSError, ValueError, EOFError, KeyboardInterrupt) as exc:
        print(f'\nSetup stopped: {exc}', file=sys.stderr)
        sys.exit(1)
