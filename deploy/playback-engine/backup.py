#!/usr/bin/env python3
"""Backup, restore, and storage-migration helper for Cadence Playback Engine.

Supports both Docker-managed named volumes (default) and legacy host bind mounts
on Linux Docker Compose and TrueNAS SCALE (24.10+ / 25.10+).

Examples:
  python3 backup.py export /mnt/tank/backups --stop
  python3 backup.py restore /mnt/tank/backups/cadence-backup-20261124T120000Z.tar.gz --stop
  python3 backup.py migrate-to-volume --stop
"""
import argparse
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile

APP = 'cadence-playback-engine'
VOLUME_NAME = 'cadence_data'
SECRET_FILES = ('tls-key.pem', 'pairing-token', 'localhost-pairing.json')


class BackupError(Exception):
    pass


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def valid_tag(value):
    return bool(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', value))


def default_tag(prefix=''):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    return f'{prefix}{stamp}'


def is_truenas():
    return bool(
        shutil.which('midclt')
        and (Path('/etc/truenas-release').exists() or Path('/etc/version').exists())
    )


def privileged(args):
    return args if (hasattr(os, 'geteuid') and os.geteuid() == 0) else ['sudo', *args]


def docker_prefix():
    if subprocess.run(['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return ['docker']
    prefix = privileged(['docker'])
    if subprocess.run([*prefix, 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
        raise BackupError('Docker is not running or is inaccessible.')
    return prefix


def read_env_values(path):
    """Load values produced by install.py write_env; never source .env as shell code."""
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
            raise BackupError(f'Invalid settings in {path}: {exc}') from exc
        result[key] = parts[0] if parts else ''
    return result


def write_env(path, values):
    def quote(value):
        if '\n' in value or '\r' in value or '\x00' in value:
            raise BackupError('Settings cannot contain line breaks or NUL characters.')
        return "'" + value.replace("'", "\\'") + "'"
    path.write_text(''.join(f'{key}={quote(str(value))}\n' for key, value in values.items()), encoding='utf-8')
    try:
        path.chmod(0o600)
    except OSError:
        pass


def find_install_dir(explicit_dir=None, truenas=False):
    """Locate the installer-managed Cadence directory containing .env and compose.yml."""
    if explicit_dir:
        candidate = Path(explicit_dir).expanduser().resolve()
        if not (candidate / '.env').is_file() or not (candidate / 'compose.yml').is_file():
            raise BackupError(f'No Cadence installation (.env and compose.yml) found in {candidate}.')
        return candidate

    cwd = Path.cwd()
    if (cwd / '.env').is_file() and (cwd / 'compose.yml').is_file():
        return cwd

    here = Path(__file__).resolve().parent
    if (here / '.env').is_file() and (here / 'compose.yml').is_file():
        return here

    if not truenas:
        sudo_user = os.environ.get('SUDO_USER')
        if sudo_user:
            import pwd
            home = Path(pwd.getpwnam(sudo_user).pw_dir)
        else:
            home = Path.home()
        candidate = home / 'cadence-playback-engine'
        if (candidate / '.env').is_file() and (candidate / 'compose.yml').is_file():
            return candidate
        raise BackupError('Could not locate Cadence installation. Pass --install-dir <path>.')

    root = Path('/mnt')
    candidates = []
    if root.is_dir():
        for pool in root.iterdir():
            if not pool.is_dir() or pool.name.startswith('.'):
                continue
            target = pool / 'cadence-installation'
            if (target / '.env').is_file() and (target / 'compose.yml').is_file():
                candidates.append(target)
    if len(candidates) > 1:
        raise BackupError('Multiple Cadence installations found under /mnt. Pass --install-dir <path>.')
    if not candidates:
        raise BackupError('Could not locate Cadence installation under /mnt. Pass --install-dir <path>.')
    return candidates[0]


def compose_cmd(docker, install_dir):
    return [*docker, 'compose', '-p', APP, '--project-directory', str(install_dir),
            '-f', str(install_dir / 'compose.yml')]


def find_engine_container_ids(docker, truenas=False):
    projects = [f'ix-{APP}', APP] if truenas else [APP]
    for project in projects:
        res = subprocess.run(
            [*docker, 'ps', '-a',
             '--filter', f'label=com.docker.compose.project={project}',
             '--filter', 'label=com.docker.compose.service=playback-engine',
             '--format', '{{.ID}}'],
            capture_output=True, text=True,
        )
        if res.returncode == 0 and res.stdout.strip():
            return [line.strip() for line in res.stdout.splitlines() if line.strip()]
    return []


def is_engine_running(docker, install_dir, truenas=False):
    if truenas:
        res = subprocess.run(
            ['midclt', 'call', 'app.query', json.dumps([['id', '=', APP]])],
            capture_output=True, text=True,
        )
        if res.returncode == 0 and res.stdout.strip():
            try:
                apps = json.loads(res.stdout)
                if apps:
                    state = str(apps[0].get('state', '')).upper()
                    return state in ('RUNNING', 'DEPLOYING')
            except ValueError:
                pass
    projects = [f'ix-{APP}', APP] if truenas else [APP]
    for project in projects:
        res = subprocess.run(
            [*docker, 'ps',
             '--filter', f'label=com.docker.compose.project={project}',
             '--filter', 'label=com.docker.compose.service=playback-engine',
             '--filter', 'status=running',
             '--format', '{{.ID}}'],
            capture_output=True, text=True,
        )
        if res.returncode == 0 and res.stdout.strip():
            return True
    return False


def stop_engine(docker, install_dir, truenas=False):
    print('Stopping Cadence Playback Engine...')
    if truenas:
        run(['midclt', 'call', '--job', 'app.stop', APP])
    else:
        run([*compose_cmd(docker, install_dir), 'stop', 'playback-engine'])


def start_engine(docker, install_dir, truenas=False):
    print('Starting Cadence Playback Engine...')
    if truenas:
        run(['midclt', 'call', '--job', 'app.start', APP])
    else:
        run([*compose_cmd(docker, install_dir), 'up', '-d'])


def resolve_data_mount(docker, env_values, truenas=False):
    """Return (mount_type, mount_source) for /var/lib/cadence: ('volume', name) or ('bind', host_path)."""
    for cid in find_engine_container_ids(docker, truenas=truenas):
        res = subprocess.run(
            [*docker, 'inspect', '--format', '{{json .Mounts}}', cid],
            capture_output=True, text=True,
        )
        if res.returncode == 0 and res.stdout.strip():
            try:
                mounts = json.loads(res.stdout)
            except ValueError:
                mounts = []
            for m in mounts:
                if m.get('Destination') == '/var/lib/cadence':
                    if m.get('Type') == 'volume' and m.get('Name'):
                        return ('volume', m['Name'])
                    if m.get('Type') == 'bind' and m.get('Source'):
                        return ('bind', m['Source'])

    storage = env_values.get('CADENCE_DATA_STORAGE', '').strip().lower()
    host_data = env_values.get('CADENCE_HOST_DATA_DIR', '').strip()
    if host_data and storage != 'volume':
        return ('bind', host_data)

    # Check existing Docker volumes (TrueNAS prefixes custom app projects with ix-).
    candidates = [f'ix-{APP}_{VOLUME_NAME}', f'{APP}_{VOLUME_NAME}'] if truenas else [f'{APP}_{VOLUME_NAME}']
    for vol in candidates:
        res = subprocess.run([*docker, 'volume', 'inspect', vol], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode == 0:
            return ('volume', vol)
    return ('volume', candidates[0])


def mount_flag(mount_type, mount_source, read_only=False):
    suffix = ':ro' if read_only else ':rw'
    return f'{mount_source}:/var/lib/cadence{suffix}'


def validate_tar_archive(archive_path):
    """Verify backup archive contains required files and has no unsafe paths or special files."""
    if not archive_path.is_file():
        raise BackupError(f'Backup archive does not exist: {archive_path}')
    names = set()
    try:
        with tarfile.open(archive_path, 'r:*') as tf:
            for member in tf.getmembers():
                raw = member.name.lstrip('./')
                if not raw:
                    continue
                if member.name.startswith('/') or '..' in Path(member.name).parts:
                    raise BackupError(f'Refusing unsafe path in backup archive: {member.name}')
                if not (member.isfile() or member.isdir()):
                    raise BackupError(f'Refusing unsupported entry type in backup archive: {member.name}')
                names.add(Path(raw).name)
    except tarfile.TarError as exc:
        raise BackupError(f'Invalid backup archive {archive_path}: {exc}') from exc
    for required in ('backup-manifest.json', 'cadence.db'):
        if required not in names:
            raise BackupError(f'Backup archive is missing required file: {required}')


def pack_backup_directory(source_dir):
    """Validate a backup directory and return a .tar.gz bytes payload."""
    for required in ('backup-manifest.json', 'cadence.db'):
        if not (source_dir / required).is_file():
            raise BackupError(f'Backup directory {source_dir} is missing required file: {required}')
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tf:
        for child in sorted(source_dir.iterdir()):
            if child.is_file() and not child.is_symlink():
                tf.add(child, arcname=child.name)
    return buf.getvalue()


def cmd_export(args):
    truenas = is_truenas()
    install_dir = find_install_dir(args.install_dir, truenas=truenas)
    env_values = read_env_values(install_dir / '.env')
    image = env_values.get('CADENCE_IMAGE', '').strip()
    if not image:
        raise BackupError(f'CADENCE_IMAGE is missing in {install_dir / ".env"}.')

    dest_dir = Path(args.destination).expanduser().resolve()
    if not dest_dir.exists():
        if not dest_dir.parent.is_dir():
            raise BackupError(f'Parent directory does not exist: {dest_dir.parent}')
        dest_dir.mkdir(mode=0o700)
    if not dest_dir.is_dir():
        raise BackupError(f'Destination is not a directory: {dest_dir}')

    tag = args.tag or default_tag()
    if not valid_tag(tag):
        raise BackupError(f'Invalid backup tag: {tag}')

    docker = docker_prefix()
    running = is_engine_running(docker, install_dir, truenas=truenas)
    if running and not args.stop:
        raise BackupError('Cadence Playback Engine is currently running. Stop it first, or rerun with --stop.')

    mount_type, mount_source = resolve_data_mount(docker, env_values, truenas=truenas)
    out_file = dest_dir / f'cadence-backup-{tag}.tar.gz'
    tmp_file = dest_dir / f'.cadence-backup-{tag}.tar.gz.tmp'

    stopped_by_us = False
    try:
        if running:
            stop_engine(docker, install_dir, truenas=truenas)
            stopped_by_us = True

        print(f'Creating atomic engine snapshot ({tag}) from {mount_type} "{mount_source}"...')
        run([
            *docker, 'run', '--rm', '--user', '0:0',
            '-v', mount_flag(mount_type, mount_source, read_only=False),
            image, '--backup', tag,
        ])

        print(f'Exporting backup archive to {out_file}...')
        tar_proc = run(
            [
                *docker, 'run', '--rm', '--user', '0:0', '--entrypoint', '/bin/sh',
                '-v', mount_flag(mount_type, mount_source, read_only=True),
                image, '-c', f'tar -czf - -C "/var/lib/cadence/backups/{tag}" .',
            ],
            capture_output=True,
        )
        tmp_file.write_bytes(tar_proc.stdout)
        try:
            tmp_file.chmod(0o600)
        except OSError:
            pass
        tmp_file.replace(out_file)
        validate_tar_archive(out_file)
        print(f'Backup exported successfully: {out_file}')
        print('Protect this archive: it contains tls-key.pem and pairing-token.')
        return out_file
    finally:
        if tmp_file.exists():
            try:
                tmp_file.unlink()
            except OSError:
                pass
        if stopped_by_us:
            start_engine(docker, install_dir, truenas=truenas)


def cmd_restore(args):
    truenas = is_truenas()
    install_dir = find_install_dir(args.install_dir, truenas=truenas)
    env_values = read_env_values(install_dir / '.env')
    image = env_values.get('CADENCE_IMAGE', '').strip()
    if not image:
        raise BackupError(f'CADENCE_IMAGE is missing in {install_dir / ".env"}.')

    source = Path(args.source).expanduser().resolve()
    if source.is_dir():
        archive_bytes = pack_backup_directory(source)
    elif source.is_file():
        validate_tar_archive(source)
        archive_bytes = source.read_bytes()
    else:
        raise BackupError(f'Backup source not found: {source}')

    tag = args.tag or default_tag('restore-')
    if not valid_tag(tag):
        raise BackupError(f'Invalid restore tag: {tag}')

    docker = docker_prefix()
    running = is_engine_running(docker, install_dir, truenas=truenas)
    if running and not args.stop:
        raise BackupError('Cadence Playback Engine is currently running. Stop it first, or rerun with --stop.')

    mount_type, mount_source = resolve_data_mount(docker, env_values, truenas=truenas)

    stopped_by_us = False
    try:
        if running:
            stop_engine(docker, install_dir, truenas=truenas)
            stopped_by_us = True

        print(f'Staging backup ({tag}) into {mount_type} "{mount_source}"...')
        stage_cmd = (
            f'rm -rf "/var/lib/cadence/backups/{tag}" '
            f'&& mkdir -p "/var/lib/cadence/backups/{tag}" '
            f'&& tar -xzf - -C "/var/lib/cadence/backups/{tag}" '
            f'&& chown -R 568:568 "/var/lib/cadence/backups/{tag}" '
            f'&& chmod 700 "/var/lib/cadence/backups/{tag}"'
        )
        run(
            [
                *docker, 'run', '--rm', '-i', '--user', '0:0', '--entrypoint', '/bin/sh',
                '-v', mount_flag(mount_type, mount_source, read_only=False),
                image, '-c', stage_cmd,
            ],
            input=archive_bytes,
        )

        print(f'Restoring engine state from tag "{tag}"...')
        run([
            *docker, 'run', '--rm', '--user', '0:0',
            '-v', mount_flag(mount_type, mount_source, read_only=False),
            image, '--restore', tag,
        ])

        # Ensure ownership stays compatible with UID/GID 568 (Hardened profile).
        run([
            *docker, 'run', '--rm', '--user', '0:0', '--entrypoint', '/bin/sh',
            '-v', mount_flag(mount_type, mount_source, read_only=False),
            image, '-c', 'chown -R 568:568 /var/lib/cadence',
        ])

        print('Verifying restored database and identity with --doctor...')
        run([
            *docker, 'run', '--rm', '--user', '568:568',
            '-v', mount_flag(mount_type, mount_source, read_only=False),
            image, '--doctor', '--data-dir', '/var/lib/cadence',
        ])
        print('Restore completed and verified.')
    finally:
        if stopped_by_us:
            start_engine(docker, install_dir, truenas=truenas)


def convert_compose_to_volume(compose_text):
    """Replace a /var/lib/cadence host bind mount in compose.yml with the cadence_data named volume."""
    normalized = compose_text.replace('\r\n', '\n')
    bind_pattern = (
        r'(?m)^      - type: bind\n'
        r'        source: \$\{CADENCE_HOST_DATA_DIR[^}]*\}\n'
        r'        target: /var/lib/cadence\n'
        r'        bind:\n'
        r'          create_host_path: false\n'
    )
    volume_block = (
        '      - type: volume\n'
        '        source: cadence_data\n'
        '        target: /var/lib/cadence\n'
    )
    updated, count = re.subn(bind_pattern, volume_block, normalized)
    if not count:
        raise BackupError('Could not locate the CADENCE_HOST_DATA_DIR bind mount in compose.yml.')
    if not re.search(r'(?m)^volumes:\s*$', updated):
        updated = updated.rstrip('\n') + '\n\nvolumes:\n  cadence_data:\n'
    return updated


def cmd_migrate_to_volume(args):
    truenas = is_truenas()
    install_dir = find_install_dir(args.install_dir, truenas=truenas)
    env_path = install_dir / '.env'
    compose_path = install_dir / 'compose.yml'
    env_values = read_env_values(env_path)

    host_data = env_values.get('CADENCE_HOST_DATA_DIR', '').strip()
    storage = env_values.get('CADENCE_DATA_STORAGE', '').strip().lower()
    if storage == 'volume' or not host_data:
        raise BackupError('This installation is already using a Docker-managed volume (no CADENCE_HOST_DATA_DIR found).')
    if not Path(host_data).is_dir():
        raise BackupError(f'Configured host data directory does not exist: {host_data}')

    image = env_values.get('CADENCE_IMAGE', '').strip()
    if not image:
        raise BackupError(f'CADENCE_IMAGE is missing in {env_path}.')

    docker = docker_prefix()
    running = is_engine_running(docker, install_dir, truenas=truenas)
    if running and not args.stop:
        raise BackupError('Cadence Playback Engine is currently running. Stop it first, or rerun with --stop.')

    target_volume = f'ix-{APP}_{VOLUME_NAME}' if truenas else f'{APP}_{VOLUME_NAME}'
    tag = default_tag('migrate-')

    stopped_by_us = False
    try:
        if running:
            stop_engine(docker, install_dir, truenas=truenas)
            stopped_by_us = True

        print(f'Creating snapshot ({tag}) from legacy host directory "{host_data}"...')
        run([
            *docker, 'run', '--rm', '--user', '0:0',
            '-v', f'{host_data}:/var/lib/cadence:rw',
            image, '--backup', tag,
        ])

        tar_proc = run(
            [
                *docker, 'run', '--rm', '--user', '0:0', '--entrypoint', '/bin/sh',
                '-v', f'{host_data}:/var/lib/cadence:ro',
                image, '-c', f'tar -czf - -C "/var/lib/cadence/backups/{tag}" .',
            ],
            capture_output=True,
        )

        print(f'Initializing Docker volume "{target_volume}" and restoring snapshot...')
        run([*docker, 'volume', 'create', target_volume])
        stage_cmd = (
            f'mkdir -p "/var/lib/cadence/backups/{tag}" '
            f'&& tar -xzf - -C "/var/lib/cadence/backups/{tag}" '
            f'&& chown -R 568:568 /var/lib/cadence'
        )
        run(
            [
                *docker, 'run', '--rm', '-i', '--user', '0:0', '--entrypoint', '/bin/sh',
                '-v', f'{target_volume}:/var/lib/cadence:rw',
                image, '-c', stage_cmd,
            ],
            input=tar_proc.stdout,
        )
        run([
            *docker, 'run', '--rm', '--user', '0:0',
            '-v', f'{target_volume}:/var/lib/cadence:rw',
            image, '--restore', tag,
        ])
        run([
            *docker, 'run', '--rm', '--user', '0:0', '--entrypoint', '/bin/sh',
            '-v', f'{target_volume}:/var/lib/cadence:rw',
            image, '-c', 'chown -R 568:568 /var/lib/cadence',
        ])
        run([
            *docker, 'run', '--rm', '--user', '568:568',
            '-v', f'{target_volume}:/var/lib/cadence:rw',
            image, '--doctor', '--data-dir', '/var/lib/cadence',
        ])

        # Back up .env and compose.yml before switching configuration.
        stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup_cfg = install_dir / f'backup-before-volume-migration-{stamp}'
        backup_cfg.mkdir(mode=0o700)
        shutil.copy2(env_path, backup_cfg / '.env')
        shutil.copy2(compose_path, backup_cfg / 'compose.yml')

        updated_compose = convert_compose_to_volume(compose_path.read_text(encoding='utf-8'))
        new_env = dict(env_values)
        new_env['CADENCE_DATA_STORAGE'] = 'volume'
        new_env.pop('CADENCE_HOST_DATA_DIR', None)

        compose_path.write_text(updated_compose, encoding='utf-8')
        write_env(env_path, new_env)

        cmd = compose_cmd(docker, install_dir)
        try:
            run([*cmd, 'config', '--quiet'])
        except Exception:
            shutil.copy2(backup_cfg / '.env', env_path)
            shutil.copy2(backup_cfg / 'compose.yml', compose_path)
            raise

        if truenas:
            resolved = run([*cmd, 'config', '--format', 'json'], capture_output=True, text=True)
            run(['midclt', 'call', '--job', 'app.update', APP,
                 json.dumps({'custom_compose_config': json.loads(resolved.stdout)})])
            if stopped_by_us:
                start_engine(docker, install_dir, truenas=True)
                stopped_by_us = False
        else:
            run([*cmd, 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120'])
            stopped_by_us = False

        print(f'Migration complete! Cadence now uses Docker volume "{target_volume}".')
        print(f'Previous config backed up to: {backup_cfg}')
        print(f'Your original host data directory was left untouched as a safety copy: {host_data}')
    finally:
        if stopped_by_us:
            start_engine(docker, install_dir, truenas=truenas)


def build_parser():
    parser = argparse.ArgumentParser(
        description='Export, restore, or migrate Cadence Playback Engine persistent data.'
    )
    sub = parser.add_subparsers(dest='command', required=True)

    p_export = sub.add_parser('export', help='Create an atomic backup and export it to a custom host directory.')
    p_export.add_argument('destination', help='Host directory where cadence-backup-<tag>.tar.gz will be written.')
    p_export.add_argument('--tag', default='', help='Optional backup tag (default: UTC timestamp).')
    p_export.add_argument('--stop', action='store_true', help='Stop the engine before backing up and restart it after.')
    p_export.add_argument('--install-dir', default='', help='Path to the Cadence installation directory (.env + compose.yml).')
    p_export.set_defaults(func=cmd_export)

    p_restore = sub.add_parser('restore', help='Restore Cadence state from a backup archive (.tar.gz) or directory.')
    p_restore.add_argument('source', help='Path to a cadence-backup-*.tar.gz archive or backup directory.')
    p_restore.add_argument('--tag', default='', help='Optional restore tag (default: restore-<timestamp>).')
    p_restore.add_argument('--stop', action='store_true', help='Stop the engine before restoring and restart it after.')
    p_restore.add_argument('--install-dir', default='', help='Path to the Cadence installation directory (.env + compose.yml).')
    p_restore.set_defaults(func=cmd_restore)

    p_migrate = sub.add_parser('migrate-to-volume', help='Migrate a legacy host bind-mount install to the Docker-managed volume.')
    p_migrate.add_argument('--stop', action='store_true', help='Stop the engine before migrating and restart it after.')
    p_migrate.add_argument('--install-dir', default='', help='Path to the Cadence installation directory (.env + compose.yml).')
    p_migrate.set_defaults(func=cmd_migrate_to_volume)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == '__main__':
    try:
        main()
    except (BackupError, subprocess.CalledProcessError, OSError, ValueError, KeyboardInterrupt) as exc:
        print(f'\nBackup tool stopped: {exc}', file=sys.stderr)
        sys.exit(1)
