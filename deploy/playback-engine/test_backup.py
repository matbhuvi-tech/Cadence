import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import types
import unittest
from unittest import mock

path = pathlib.Path(__file__).with_name('backup.py')
spec = importlib.util.spec_from_file_location('cadence_backup', path)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def _make_backup_tar_bytes(files=None):
    if files is None:
        files = {
            'backup-manifest.json': b'{"tag":"test","schema_version":1}',
            'cadence.db': b'SQLite format 3\x00',
            'pairing-token': b'secret-token',
        }
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tf:
        for name, data in files.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class BackupHelperTests(unittest.TestCase):
    def test_validate_tar_archive_valid_and_rejections(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            good = root / 'good.tar.gz'
            good.write_bytes(_make_backup_tar_bytes())
            backup.validate_tar_archive(good)

            missing_db = root / 'missing.tar.gz'
            missing_db.write_bytes(_make_backup_tar_bytes({'backup-manifest.json': b'{}'}))
            with self.assertRaises(backup.BackupError):
                backup.validate_tar_archive(missing_db)

            traversal = root / 'traversal.tar.gz'
            traversal.write_bytes(_make_backup_tar_bytes({
                'backup-manifest.json': b'{}',
                'cadence.db': b'db',
                '../evil.txt': b'nope',
            }))
            with self.assertRaises(backup.BackupError):
                backup.validate_tar_archive(traversal)

            symlink_tar = root / 'symlink.tar.gz'
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode='w:gz') as tf:
                for name, data in (('backup-manifest.json', b'{}'), ('cadence.db', b'db')):
                    info = tarfile.TarInfo(name=name)
                    info.size = len(data)
                    tf.addfile(info, io.BytesIO(data))
                link = tarfile.TarInfo(name='link')
                link.type = tarfile.SYMTYPE
                link.linkname = '/etc/passwd'
                tf.addfile(link)
            symlink_tar.write_bytes(buf.getvalue())
            with self.assertRaises(backup.BackupError):
                backup.validate_tar_archive(symlink_tar)

    def test_convert_compose_to_volume(self):
        legacy_compose = (
            "services:\n"
            "  playback-engine:\n"
            "    image: test:v1\n"
            "    volumes:\n"
            "      - type: bind\n"
            "        source: ${CADENCE_HOST_DATA_DIR:?Set an existing writable data directory}\n"
            "        target: /var/lib/cadence\n"
            "        bind:\n"
            "          create_host_path: false\n"
        )
        converted = backup.convert_compose_to_volume(legacy_compose)
        self.assertIn('type: volume', converted)
        self.assertIn('source: cadence_data', converted)
        self.assertIn('\nvolumes:\n  cadence_data:\n', converted)
        self.assertNotIn('CADENCE_HOST_DATA_DIR', converted)

    def test_resolve_data_mount_prefers_container_inspection(self):
        mounts_json = json.dumps([
            {'Type': 'volume', 'Name': 'ix-cadence-playback-engine_cadence_data', 'Destination': '/var/lib/cadence'}
        ])
        with mock.patch.object(backup, 'find_engine_container_ids', return_value=['cid123']), \
             mock.patch.object(backup.subprocess, 'run', return_value=types.SimpleNamespace(returncode=0, stdout=mounts_json)):
            self.assertEqual(
                backup.resolve_data_mount(['docker'], {}, truenas=True),
                ('volume', 'ix-cadence-playback-engine_cadence_data'),
            )

    def test_export_refuses_when_running_without_stop(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            install_dir = root / 'install'
            install_dir.mkdir()
            (install_dir / '.env').write_text("CADENCE_IMAGE='example/test:v1'\n", encoding='utf-8')
            (install_dir / 'compose.yml').write_text('services: {}\n', encoding='utf-8')
            dest = root / 'backups'
            dest.mkdir()

            args = backup.build_parser().parse_args(['export', str(dest), '--install-dir', str(install_dir)])
            with mock.patch.object(backup, 'is_truenas', return_value=False), \
                 mock.patch.object(backup, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(backup, 'is_engine_running', return_value=True):
                with self.assertRaises(backup.BackupError) as ctx:
                    backup.cmd_export(args)
                self.assertIn('--stop', str(ctx.exception))

    def test_export_with_stop_creates_archive_and_restarts(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            install_dir = root / 'install'
            install_dir.mkdir()
            (install_dir / '.env').write_text(
                "CADENCE_IMAGE='example/test:v1'\nCADENCE_DATA_STORAGE='volume'\n",
                encoding='utf-8',
            )
            (install_dir / 'compose.yml').write_text('services: {}\n', encoding='utf-8')
            dest = root / 'backups'
            dest.mkdir()

            tar_bytes = _make_backup_tar_bytes()
            calls = []

            def fake_run(cmd, **kwargs):
                calls.append(cmd)
                if 'tar -czf -' in ' '.join(cmd):
                    return types.SimpleNamespace(returncode=0, stdout=tar_bytes)
                return types.SimpleNamespace(returncode=0, stdout='')

            args = backup.build_parser().parse_args([
                'export', str(dest), '--tag', 'pre-upgrade', '--stop', '--install-dir', str(install_dir),
            ])
            with mock.patch.object(backup, 'is_truenas', return_value=False), \
                 mock.patch.object(backup, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(backup, 'is_engine_running', return_value=True), \
                 mock.patch.object(backup, 'resolve_data_mount', return_value=('volume', 'cadence-playback-engine_cadence_data')), \
                 mock.patch.object(backup, 'stop_engine') as mock_stop, \
                 mock.patch.object(backup, 'start_engine') as mock_start, \
                 mock.patch.object(backup, 'run', side_effect=fake_run):
                out = backup.cmd_export(args)

            self.assertEqual(out, dest / 'cadence-backup-pre-upgrade.tar.gz')
            self.assertTrue(out.is_file())
            mock_stop.assert_called_once()
            mock_start.assert_called_once()
            self.assertTrue(any('--backup' in c and 'pre-upgrade' in c for c in calls))

    def test_restore_with_stop_stages_restores_and_runs_doctor(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            install_dir = root / 'install'
            install_dir.mkdir()
            (install_dir / '.env').write_text(
                "CADENCE_IMAGE='example/test:v1'\nCADENCE_DATA_STORAGE='volume'\n",
                encoding='utf-8',
            )
            (install_dir / 'compose.yml').write_text('services: {}\n', encoding='utf-8')
            archive = root / 'cadence-backup-test.tar.gz'
            archive.write_bytes(_make_backup_tar_bytes())

            calls = []

            def fake_run(cmd, **kwargs):
                calls.append((cmd, kwargs.get('input')))
                return types.SimpleNamespace(returncode=0, stdout='')

            args = backup.build_parser().parse_args([
                'restore', str(archive), '--tag', 'restore-test', '--stop', '--install-dir', str(install_dir),
            ])
            with mock.patch.object(backup, 'is_truenas', return_value=False), \
                 mock.patch.object(backup, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(backup, 'is_engine_running', return_value=True), \
                 mock.patch.object(backup, 'resolve_data_mount', return_value=('volume', 'cadence-playback-engine_cadence_data')), \
                 mock.patch.object(backup, 'stop_engine') as mock_stop, \
                 mock.patch.object(backup, 'start_engine') as mock_start, \
                 mock.patch.object(backup, 'run', side_effect=fake_run):
                backup.cmd_restore(args)

            mock_stop.assert_called_once()
            mock_start.assert_called_once()
            self.assertTrue(any(inp is not None and 'tar -xzf -' in ' '.join(cmd) for cmd, inp in calls))
            self.assertTrue(any('--restore' in cmd and 'restore-test' in cmd for cmd, _ in calls))
            self.assertTrue(any('--doctor' in cmd for cmd, _ in calls))

    def test_migrate_to_volume_updates_config_and_leaves_host_dir_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            host_data = root / 'old-data'
            host_data.mkdir()
            (host_data / 'cadence.db').write_bytes(b'old-db')
            install_dir = root / 'install'
            install_dir.mkdir()
            backup.write_env(install_dir / '.env', {
                'CADENCE_IMAGE': 'example/test:v1',
                'CADENCE_ADVERTISED_IP': '192.168.1.12',
                'CADENCE_DEPLOYMENT_PROFILE': 'standard',
                'CADENCE_HOST_DATA_DIR': str(host_data),
                'CADENCE_HOST_MUSIC_DIR': '',
                'CADENCE_LABEL': 'Cadence Playback Engine',
            })
            (install_dir / 'compose.yml').write_text(
                "services:\n"
                "  playback-engine:\n"
                "    image: ${CADENCE_IMAGE}\n"
                "    volumes:\n"
                "      - type: bind\n"
                "        source: ${CADENCE_HOST_DATA_DIR:?Set an existing writable data directory}\n"
                "        target: /var/lib/cadence\n"
                "        bind:\n"
                "          create_host_path: false\n",
                encoding='utf-8',
            )

            tar_bytes = _make_backup_tar_bytes()

            def fake_run(cmd, **kwargs):
                if 'tar -czf -' in ' '.join(cmd):
                    return types.SimpleNamespace(returncode=0, stdout=tar_bytes)
                return types.SimpleNamespace(returncode=0, stdout='')

            args = backup.build_parser().parse_args([
                'migrate-to-volume', '--stop', '--install-dir', str(install_dir),
            ])
            with mock.patch.object(backup, 'is_truenas', return_value=False), \
                 mock.patch.object(backup, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(backup, 'is_engine_running', return_value=True), \
                 mock.patch.object(backup, 'stop_engine') as mock_stop, \
                 mock.patch.object(backup, 'run', side_effect=fake_run):
                backup.cmd_migrate_to_volume(args)

            mock_stop.assert_called_once()
            new_env = backup.read_env_values(install_dir / '.env')
            self.assertEqual(new_env['CADENCE_DATA_STORAGE'], 'volume')
            self.assertNotIn('CADENCE_HOST_DATA_DIR', new_env)
            new_compose = (install_dir / 'compose.yml').read_text(encoding='utf-8')
            self.assertIn('source: cadence_data', new_compose)
            self.assertIn('volumes:\n  cadence_data:', new_compose)
            self.assertTrue((host_data / 'cadence.db').is_file())


if __name__ == '__main__':
    unittest.main()
