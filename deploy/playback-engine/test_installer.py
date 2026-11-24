import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

path = pathlib.Path(__file__).with_name('install.py')
spec = importlib.util.spec_from_file_location('installer', path)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def _has_native_docker_compose():
    docker_bin = shutil.which('docker')
    if not docker_bin:
        return False
    if os.name == 'posix' and docker_bin.lower().endswith('.exe'):
        return False
    return subprocess.run(
        ['docker', 'compose', 'version'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0


class InstallerTests(unittest.TestCase):
    def test_lan_address_validation(self):
        for address in ('127.0.0.1', '169.254.0.1', '100.64.0.1', '0.0.0.0', '::1', 'invalid'):
            self.assertFalse(installer.valid_address(address), address)
        self.assertTrue(installer.valid_address('192.168.1.12'))

    def test_release_tag_validation(self):
        self.assertTrue(installer.valid_tag('v1.2.3-rc.1'))
        for tag in ('../main', '', 'a/b', 'bad tag', '-bad'):
            self.assertFalse(installer.valid_tag(tag))

    def test_compose_env_escaping_and_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            values = {'CADENCE_HOST_MUSIC_DIR': "/music/John's $ records", 'CADENCE_LABEL': 'Music #1'}
            file = pathlib.Path(d) / '.env'
            installer.write_env(file, values)
            data = file.read_text()
            self.assertIn("CADENCE_HOST_MUSIC_DIR='/music/John\\'s $ records'", data)
            self.assertIn("CADENCE_LABEL='Music #1'", data)
            loaded = installer.read_env_values(file)
            self.assertEqual(loaded, values)

    @unittest.skipUnless(_has_native_docker_compose(), 'Native Docker Compose unavailable')
    def test_compose_reads_special_characters_literally(self):
        with tempfile.TemporaryDirectory() as d:
            env_file = pathlib.Path(d) / '.env'
            values = {
                'CADENCE_HOST_MUSIC_DIR': "/music/John's $ records",
                'CADENCE_LABEL': 'Music #1',
                'CADENCE_IMAGE': 'example/test:v1',
                'CADENCE_ADVERTISED_IP': '192.168.1.12',
            }
            installer.write_env(env_file, values)
            env = {k: v for k, v in os.environ.items() if k not in values}
            result = subprocess.run(
                ['docker', 'compose', '--env-file', str(env_file), '-f',
                 str(path.with_name('compose.yml')), 'config', '--format', 'json'],
                capture_output=True, text=True, check=True, env=env,
            )
            parsed = json.loads(result.stdout)
            service = parsed['services']['playback-engine']
            self.assertEqual(service['environment']['CADENCE_LABEL'], 'Music #1')
            self.assertEqual(service['volumes'][0]['type'], 'volume')
            self.assertEqual(service['volumes'][0]['source'], 'cadence_data')
            self.assertIn('cadence_data', parsed.get('volumes', {}))
            # Compose escapes dollar signs when emitting a configuration for reuse.
            self.assertEqual(service['volumes'][1]['source'], "/music/John's $$ records")

    @unittest.skipUnless(_has_native_docker_compose(), 'Native Docker Compose unavailable')
    def test_compose_hardened_reads_special_characters_literally(self):
        with tempfile.TemporaryDirectory() as d:
            env_file = pathlib.Path(d) / '.env'
            values = {
                'CADENCE_HOST_MUSIC_DIR': "/music/John's $ records",
                'CADENCE_LABEL': 'Music #1',
                'CADENCE_IMAGE': 'example/test:v1',
                'CADENCE_ADVERTISED_IP': '192.168.1.12',
            }
            installer.write_env(env_file, values)
            env = {k: v for k, v in os.environ.items() if k not in values}
            result = subprocess.run(
                ['docker', 'compose', '--env-file', str(env_file), '-f',
                 str(path.with_name('compose.hardened.yml')), 'config', '--format', 'json'],
                capture_output=True, text=True, check=True, env=env,
            )
            parsed = json.loads(result.stdout)
            service = parsed['services']['playback-engine']
            self.assertEqual(service['user'], '568:568')
            self.assertEqual(service['environment']['CADENCE_MUSIC_READ_ONLY'], 'true')
            self.assertEqual(service['volumes'][0]['type'], 'volume')
            self.assertEqual(service['volumes'][0]['source'], 'cadence_data')
            self.assertIn('cadence_data', parsed.get('volumes', {}))
            self.assertTrue(service['volumes'][1]['read_only'])
            self.assertEqual(service['volumes'][1]['source'], "/music/John's $$ records")

    def test_paths_must_not_overlap(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / 'music').mkdir()
            self.assertFalse(installer.paths_separate(root, root / 'music'))
            self.assertTrue(installer.paths_separate(root / 'data', root / 'music'))

    def test_latest_release_falls_back_to_prerelease_list(self):
        def fake_fetch(url):
            if url.endswith('/releases/latest'):
                raise installer.InstallError('404 Not Found')
            return json.dumps([
                {'tag_name': 'v0.1.0-draft', 'draft': True},
                {'tag_name': 'v0.1.0-rc.2', 'draft': False},
            ])

        with mock.patch.object(installer, 'fetch', side_effect=fake_fetch):
            self.assertEqual(installer.latest_release(), 'v0.1.0-rc.2')

    def test_check_cifs_support_passes_and_fails(self):
        ok_res = types.SimpleNamespace(returncode=0)
        fail_res = types.SimpleNamespace(returncode=1)
        with mock.patch.object(installer.subprocess, 'run', return_value=ok_res):
            installer.check_cifs_support(['docker'], 'example/image:v1')
        with mock.patch.object(installer.subprocess, 'run', return_value=fail_res):
            with self.assertRaises(installer.InstallError):
                installer.check_cifs_support(['docker'], 'example/image:v1')

    def test_local_compose_hardened_requires_music(self):
        with self.assertRaises(installer.InstallError):
            installer.local_compose('', profile='hardened')

    def test_truenas_deploy_create_and_update(self):
        with mock.patch.object(installer, 'run') as run:
            installer.deploy_truenas_app('{"services":{}}', existing=False)
            args = run.call_args.args[0]
            self.assertEqual(args[:4], ['midclt', 'call', '--job', 'app.create'])
            payload = json.loads(args[4])
            self.assertEqual(payload['app_name'], 'cadence-playback-engine')
            self.assertTrue(payload['custom_app'])
            self.assertEqual(payload['custom_compose_config'], {'services': {}})

        with mock.patch.object(installer, 'run') as run:
            installer.deploy_truenas_app('{"services":{}}', existing=True)
            args = run.call_args.args[0]
            self.assertEqual(args[:5], ['midclt', 'call', '--job', 'app.update', 'cadence-playback-engine'])
            payload = json.loads(args[5])
            self.assertEqual(payload['custom_compose_config'], {'services': {}})

    def test_existing_redeploy_backs_up_config_and_declined_redeploy_aborts(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            install_dir = root / 'cadence-playback-engine'
            install_dir.mkdir()
            (install_dir / '.env').write_text("CADENCE_IMAGE='example:v1'\n", encoding='utf-8')
            (install_dir / 'compose.yml').write_text('services: {}\n', encoding='utf-8')

            backup_dir = installer.backup_deployment_files(install_dir)
            self.assertTrue((backup_dir / '.env').is_file())
            self.assertTrue((backup_dir / 'compose.yml').is_file())

            with mock.patch.object(installer.sys, 'platform', 'linux'), \
                 mock.patch.object(os, 'uname', return_value=types.SimpleNamespace(machine='x86_64'), create=True), \
                 mock.patch.object(installer.shutil, 'which', return_value=None), \
                 mock.patch.dict(os.environ, {'SUDO_USER': ''}), \
                 mock.patch.dict(sys.modules, {'pwd': types.SimpleNamespace()}), \
                 mock.patch.object(pathlib.Path, 'home', return_value=root), \
                 mock.patch('builtins.input', side_effect=['n']):
                with self.assertRaises(installer.InstallError) as ctx:
                    installer.main()
                self.assertIn('Cancelled', str(ctx.exception))
            self.assertEqual((install_dir / '.env').read_text(encoding='utf-8'), "CADENCE_IMAGE='example:v1'\n")

    def test_linux_first_install_standard_smb_default(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            result = types.SimpleNamespace(stdout='', returncode=0)
            # Tag default, IP default, Profile default (Enter -> Standard), Music '-' (no data prompt!)
            answers = ['', '', '', '-']
            with mock.patch.object(installer.sys, 'platform', 'linux'), \
                 mock.patch.object(os, 'uname', return_value=types.SimpleNamespace(machine='x86_64'), create=True), \
                 mock.patch.object(installer.shutil, 'which', return_value=None), \
                 mock.patch.dict(os.environ, {'SUDO_USER': '', 'CADENCE_INSTALLER_RELEASE': ''}), \
                 mock.patch.dict(sys.modules, {'pwd': types.SimpleNamespace()}), \
                 mock.patch.object(pathlib.Path, 'home', return_value=root), \
                 mock.patch.object(installer, 'latest_release', return_value='v1.2.3'), \
                 mock.patch.object(installer, 'default_ip', return_value='192.168.1.12'), \
                 mock.patch.object(installer, 'ensure_docker'), \
                 mock.patch.object(installer, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(installer, 'check_cifs_support') as mock_cifs, \
                 mock.patch.object(installer, 'test_as_cadence', return_value=(True, '')) as mock_perm, \
                 mock.patch.object(installer, 'run', return_value=result) as run, \
                 mock.patch('builtins.input', side_effect=answers):
                installer.main()

            env = (root / 'cadence-playback-engine' / '.env').read_text(encoding='utf-8')
            compose = (root / 'cadence-playback-engine' / 'compose.yml').read_text(encoding='utf-8')
            self.assertIn('cadence-playback-engine:v1.2.3', env)
            self.assertIn('192.168.1.12', env)
            self.assertIn("CADENCE_DEPLOYMENT_PROFILE='standard'", env)
            self.assertIn("CADENCE_DATA_STORAGE='volume'", env)
            self.assertNotIn('CADENCE_HOST_DATA_DIR', env)
            self.assertIn('SYS_ADMIN', compose)
            self.assertIn('source: cadence_data', compose)
            self.assertIn('volumes:\n  cadence_data:', compose)
            self.assertNotIn('DATA_VOLUME_START', compose)
            self.assertNotIn('LOCAL_MUSIC_VOLUME_START', compose)
            self.assertNotIn('target: /music', compose)
            self.assertTrue((root / 'cadence-playback-engine' / 'backup.py').is_file())
            mock_perm.assert_not_called()
            mock_cifs.assert_called_once_with(['docker'], 'ghcr.io/matbhuvi-tech/cadence-playback-engine:v1.2.3')
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(any(cmd[-1:] == ['pull'] for cmd in commands))
            self.assertTrue(any(cmd[-5:] == ['up', '-d', '--remove-orphans', '--wait', '--wait-timeout'] or cmd[-6:] == ['up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '120'] for cmd in commands))
            probe_cmds = [cmd[-1] for cmd in commands if isinstance(cmd[-1], str) and 'test -w /var/lib/cadence' in cmd[-1]]
            self.assertEqual(probe_cmds, ['test -w /var/lib/cadence'])

    def test_linux_first_install_hardened_read_only_option(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / 'music').mkdir()
            result = types.SimpleNamespace(stdout='', returncode=0)
            # Tag default, IP default, Profile '2' (hardened), '-' rejected then real music dir (no data prompt!)
            answers = ['', '', '2', '-', str(root / 'music')]
            with mock.patch.object(installer.sys, 'platform', 'linux'), \
                 mock.patch.object(os, 'uname', return_value=types.SimpleNamespace(machine='x86_64'), create=True), \
                 mock.patch.object(installer.shutil, 'which', return_value=None), \
                 mock.patch.dict(os.environ, {'SUDO_USER': '', 'CADENCE_INSTALLER_RELEASE': ''}), \
                 mock.patch.dict(sys.modules, {'pwd': types.SimpleNamespace()}), \
                 mock.patch.object(pathlib.Path, 'home', return_value=root), \
                 mock.patch.object(installer, 'latest_release', return_value='v1.2.3'), \
                 mock.patch.object(installer, 'default_ip', return_value='192.168.1.12'), \
                 mock.patch.object(installer, 'ensure_docker'), \
                 mock.patch.object(installer, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(installer, 'check_cifs_support') as mock_cifs, \
                 mock.patch.object(installer, 'test_as_cadence', return_value=(True, '')) as mock_perm, \
                 mock.patch.object(installer, 'run', return_value=result) as run, \
                 mock.patch('builtins.input', side_effect=answers):
                installer.main()

            env = (root / 'cadence-playback-engine' / '.env').read_text(encoding='utf-8')
            compose = (root / 'cadence-playback-engine' / 'compose.yml').read_text(encoding='utf-8')
            self.assertIn("CADENCE_DEPLOYMENT_PROFILE='hardened'", env)
            self.assertIn("CADENCE_DATA_STORAGE='volume'", env)
            self.assertNotIn('CADENCE_HOST_DATA_DIR', env)
            self.assertIn('user: "568:568"', compose)
            self.assertIn('CADENCE_MUSIC_READ_ONLY: "true"', compose)
            self.assertIn('source: cadence_data', compose)
            self.assertNotIn('SYS_ADMIN', compose)
            self.assertNotIn('apparmor:unconfined', compose)
            mock_perm.assert_called_once_with(str(root / 'music'), 'read')
            mock_cifs.assert_not_called()
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(any('test -w /var/lib/cadence && test -r /music' in cmd[-1] for cmd in commands))

    def test_legacy_bind_mount_redeploy_preserves_host_data_dir(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            data_dir = root / 'legacy-data'
            data_dir.mkdir()
            install_dir = root / 'cadence-playback-engine'
            install_dir.mkdir()
            installer.write_env(install_dir / '.env', {
                'CADENCE_IMAGE': 'ghcr.io/matbhuvi-tech/cadence-playback-engine:v1.1.0',
                'CADENCE_ADVERTISED_IP': '192.168.1.12',
                'CADENCE_DEPLOYMENT_PROFILE': 'standard',
                'CADENCE_HOST_DATA_DIR': str(data_dir),
                'CADENCE_HOST_MUSIC_DIR': '',
                'CADENCE_LABEL': 'Cadence Playback Engine',
            })
            (install_dir / 'compose.yml').write_text('services: {}\n', encoding='utf-8')
            result = types.SimpleNamespace(stdout='', returncode=0)
            # Confirm update, accept tag, accept IP, accept profile
            answers = ['y', '', '', '']
            with mock.patch.object(installer.sys, 'platform', 'linux'), \
                 mock.patch.object(os, 'uname', return_value=types.SimpleNamespace(machine='x86_64'), create=True), \
                 mock.patch.object(installer.shutil, 'which', return_value=None), \
                 mock.patch.dict(os.environ, {'SUDO_USER': '', 'CADENCE_INSTALLER_RELEASE': ''}), \
                 mock.patch.dict(sys.modules, {'pwd': types.SimpleNamespace()}), \
                 mock.patch.object(pathlib.Path, 'home', return_value=root), \
                 mock.patch.object(installer, 'ensure_docker'), \
                 mock.patch.object(installer, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(installer, 'check_cifs_support'), \
                 mock.patch.object(installer, 'test_as_cadence', return_value=(True, '')) as mock_perm, \
                 mock.patch.object(installer, 'run', return_value=result), \
                 mock.patch('builtins.input', side_effect=answers):
                installer.main()

            env = installer.read_env_values(install_dir / '.env')
            compose = (install_dir / 'compose.yml').read_text(encoding='utf-8')
            self.assertEqual(env['CADENCE_DATA_STORAGE'], 'bind')
            self.assertEqual(env['CADENCE_HOST_DATA_DIR'], str(data_dir.resolve()))
            self.assertIn('CADENCE_HOST_DATA_DIR', compose)
            self.assertNotIn('cadence_data:', compose)
            mock_perm.assert_called_once_with(data_dir, 'write')

    def test_volume_redeploy_preserves_managed_volume(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            install_dir = root / 'cadence-playback-engine'
            install_dir.mkdir()
            installer.write_env(install_dir / '.env', {
                'CADENCE_IMAGE': 'ghcr.io/matbhuvi-tech/cadence-playback-engine:v1.2.0',
                'CADENCE_ADVERTISED_IP': '192.168.1.12',
                'CADENCE_DEPLOYMENT_PROFILE': 'standard',
                'CADENCE_DATA_STORAGE': 'volume',
                'CADENCE_HOST_MUSIC_DIR': '',
                'CADENCE_LABEL': 'Cadence Playback Engine',
            })
            (install_dir / 'compose.yml').write_text('services: {}\n', encoding='utf-8')
            result = types.SimpleNamespace(stdout='', returncode=0)
            answers = ['y', '', '', '']
            with mock.patch.object(installer.sys, 'platform', 'linux'), \
                 mock.patch.object(os, 'uname', return_value=types.SimpleNamespace(machine='x86_64'), create=True), \
                 mock.patch.object(installer.shutil, 'which', return_value=None), \
                 mock.patch.dict(os.environ, {'SUDO_USER': '', 'CADENCE_INSTALLER_RELEASE': ''}), \
                 mock.patch.dict(sys.modules, {'pwd': types.SimpleNamespace()}), \
                 mock.patch.object(pathlib.Path, 'home', return_value=root), \
                 mock.patch.object(installer, 'ensure_docker'), \
                 mock.patch.object(installer, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(installer, 'check_cifs_support'), \
                 mock.patch.object(installer, 'test_as_cadence', return_value=(True, '')) as mock_perm, \
                 mock.patch.object(installer, 'run', return_value=result), \
                 mock.patch('builtins.input', side_effect=answers):
                installer.main()

            env = installer.read_env_values(install_dir / '.env')
            compose = (install_dir / 'compose.yml').read_text(encoding='utf-8')
            self.assertEqual(env['CADENCE_DATA_STORAGE'], 'volume')
            self.assertNotIn('CADENCE_HOST_DATA_DIR', env)
            self.assertIn('source: cadence_data', compose)
            self.assertIn('volumes:\n  cadence_data:', compose)
            mock_perm.assert_not_called()

    def test_parse_checksums_handles_standard_and_binary_prefixes(self):
        manifest = (
            "# comment\n"
            f"{'a' * 64}  compose.yml\n"
            f"{'b' * 64} *./install.py\n"
            "not-a-hash  broken.txt\n"
        )
        parsed = installer.parse_checksums(manifest)
        self.assertEqual(parsed, {'compose.yml': 'a' * 64, 'install.py': 'b' * 64})

    def test_parse_checksums_rejects_conflicting_duplicate_entries(self):
        same = f"{'a' * 64}  compose.yml\n{'a' * 64} *./compose.yml\n"
        self.assertEqual(installer.parse_checksums(same), {'compose.yml': 'a' * 64})

        conflicting = f"{'a' * 64}  compose.yml\n{'b' * 64}  compose.yml\n"
        with self.assertRaises(installer.InstallError):
            installer.parse_checksums(conflicting)

    def test_local_compose_fetches_remote_when_active_tag_differs_from_bootstrap_release(self):
        local_compose_body = pathlib.Path(__file__).with_name('compose.yml').read_text(encoding='utf-8')
        remote_compose_body = local_compose_body + '# v0.1.5\n'
        remote_digest = hashlib.sha256(remote_compose_body.encode('utf-8')).hexdigest()
        remote_checksums = f'{remote_digest}  compose.yml\n'

        with tempfile.TemporaryDirectory() as d:
            tmp = pathlib.Path(d)
            fake_installer = tmp / 'install.py'
            fake_installer.write_text('# stub\n', encoding='utf-8')
            (tmp / 'compose.yml').write_text(local_compose_body, encoding='utf-8')
            bootstrap_cs = tmp / 'cadence_checksums.txt'
            bootstrap_digest = hashlib.sha256(local_compose_body.encode('utf-8')).hexdigest()
            bootstrap_cs.write_text(f'{bootstrap_digest}  compose.yml\n', encoding='utf-8')

            with mock.patch.object(installer, '__file__', str(fake_installer)), \
                 mock.patch.dict(os.environ, {
                     'CADENCE_CHECKSUMS_FILE': str(bootstrap_cs),
                     'CADENCE_INSTALLER_RELEASE': 'v0.2.0',
                     'CADENCE_ACTIVE_TAG': 'v0.2.0',
                 }), \
                 mock.patch.object(installer, 'fetch') as fetch_mock:
                out_same = installer.local_compose('/music', profile='standard')
                self.assertNotIn('# v0.1.5', out_same)
                self.assertNotIn('LOCAL_MUSIC_VOLUME_START', out_same)
                fetch_mock.assert_not_called()

            def fake_fetch(url):
                if url.endswith('/v0.1.5/compose.yml'):
                    return remote_compose_body
                if url.endswith('/v0.1.5/cadence_checksums.txt'):
                    return remote_checksums
                raise AssertionError(f'unexpected url: {url}')

            with mock.patch.object(installer, '__file__', str(fake_installer)), \
                 mock.patch.dict(os.environ, {
                     'CADENCE_CHECKSUMS_FILE': str(bootstrap_cs),
                     'CADENCE_INSTALLER_RELEASE': 'v0.2.0',
                     'CADENCE_ACTIVE_TAG': 'v0.1.5',
                 }), \
                 mock.patch.object(installer, 'fetch', side_effect=fake_fetch) as fetch_mock:
                out_diff = installer.local_compose('/music', profile='standard')
                self.assertIn('# v0.1.5', out_diff)
                self.assertEqual(fetch_mock.call_count, 2)

    def test_verify_release_digest_valid_tampered_and_missing(self):
        content = 'services:\n  playback-engine:\n    image: test\n'
        digest = hashlib.sha256(content.encode('utf-8')).hexdigest()
        checksums = f'{digest}  compose.yml\n'

        with tempfile.TemporaryDirectory() as d:
            cs_file = pathlib.Path(d) / 'cadence_checksums.txt'
            cs_file.write_text(checksums, encoding='utf-8')
            with mock.patch.dict(os.environ, {'CADENCE_CHECKSUMS_FILE': str(cs_file), 'CADENCE_INSTALLER_RELEASE': 'v1.2.3'}):
                installer.verify_release_digest('compose.yml', content, 'v1.2.3')
                with self.assertRaises(installer.InstallError):
                    installer.verify_release_digest('compose.yml', content + '#tampered', 'v1.2.3')
                with self.assertRaises(installer.InstallError):
                    installer.verify_release_digest('compose.hardened.yml', content, 'v1.2.3')

    def test_verify_release_digest_fails_closed_when_checksums_unavailable(self):
        with mock.patch.object(installer, 'fetch', side_effect=installer.InstallError('404')), \
             mock.patch.dict(os.environ, {'CADENCE_CHECKSUMS_FILE': '', 'CADENCE_ALLOW_UNVERIFIED': ''}):
            with self.assertRaises(installer.InstallError):
                installer.verify_release_digest('compose.yml', 'body', 'v0.1.0-alpha.1')

        with mock.patch.object(installer, 'fetch', side_effect=installer.InstallError('404')), \
             mock.patch.dict(os.environ, {'CADENCE_CHECKSUMS_FILE': '', 'CADENCE_ALLOW_UNVERIFIED': '1'}):
            installer.verify_release_digest('compose.yml', 'body', 'v0.1.0-alpha.1')

    def test_local_compose_remote_fetch_verifies_digest(self):
        compose_body = pathlib.Path(__file__).with_name('compose.yml').read_text(encoding='utf-8')
        digest = hashlib.sha256(compose_body.encode('utf-8')).hexdigest()
        checksums = f'{digest}  compose.yml\n'

        def fake_fetch(url):
            if url.endswith('/compose.yml'):
                return compose_body
            if url.endswith('/cadence_checksums.txt'):
                return checksums
            raise AssertionError(f'unexpected url: {url}')

        with tempfile.TemporaryDirectory() as d:
            fake_installer = pathlib.Path(d) / 'install.py'
            with mock.patch.object(installer, '__file__', str(fake_installer)), \
                 mock.patch.dict(os.environ, {'CADENCE_ACTIVE_TAG': 'v1.2.3', 'CADENCE_CHECKSUMS_FILE': ''}), \
                 mock.patch.object(installer, 'fetch', side_effect=fake_fetch):
                out = installer.local_compose('/music', profile='standard')
                self.assertIn('SYS_ADMIN', out)

            with mock.patch.object(installer, '__file__', str(fake_installer)), \
                 mock.patch.dict(os.environ, {'CADENCE_ACTIVE_TAG': 'v1.2.3', 'CADENCE_CHECKSUMS_FILE': ''}), \
                 mock.patch.object(installer, 'fetch', side_effect=[compose_body + '#bad', checksums]):
                with self.assertRaises(installer.InstallError):
                    installer.local_compose('/music', profile='standard')

    def test_truenas_never_installs_system_packages(self):
        with mock.patch.object(installer.shutil, 'which', return_value=None), \
             mock.patch.object(installer, 'run') as run:
            with self.assertRaises(installer.InstallError):
                installer.ensure_docker(truenas=True)
            run.assert_not_called()


FIXTURE_INSTALL_PY = """#!/usr/bin/env python3
import json
import os
import pathlib
import sys

here = pathlib.Path(__file__).resolve().parent
payload = {
    'argv': sys.argv,
    'script_dir': str(here),
    'checksums_file': os.environ.get('CADENCE_CHECKSUMS_FILE', ''),
    'installer_release': os.environ.get('CADENCE_INSTALLER_RELEASE', ''),
    'allow_unverified': os.environ.get('CADENCE_ALLOW_UNVERIFIED', ''),
    'siblings': sorted(p.name for p in here.iterdir()),
}
pathlib.Path(os.environ['CADENCE_TEST_SENTINEL']).write_text(
    json.dumps(payload), encoding='utf-8'
)
"""

FAKE_CURL_PY = f"""#!{sys.executable}
import json
import os
import pathlib
import shutil
import sys

args = sys.argv[1:]
log_path = os.environ.get('CADENCE_TEST_CURL_LOG')
if log_path:
    with open(log_path, 'a', encoding='utf-8') as fh:
        fh.write(json.dumps(args) + '\\n')

# Enforce hardened TLS flags on every invocation.
if '--proto' not in args or '=https' not in args or '--tlsv1.2' not in args:
    sys.stderr.write('curl missing required --proto =https or --tlsv1.2\\n')
    sys.exit(99)

is_head = '--head' in args or '-I' in args
write_out = None
out_path = None
url = None
i = 0
while i < len(args):
    a = args[i]
    if a in ('--output', '-o') and i + 1 < len(args):
        out_path = args[i + 1]
        i += 2
        continue
    if a in ('--write-out', '-w') and i + 1 < len(args):
        write_out = args[i + 1]
        i += 2
        continue
    if a in ('--proto', '--retry', '--retry-delay', '--connect-timeout', '--max-time'):
        i += 2
        continue
    if not a.startswith('-'):
        url = a
    i += 1

if is_head:
    latest_url = os.environ.get('CADENCE_TEST_LATEST_EFFECTIVE_URL', '')
    if write_out == '%{{url_effective}}' and latest_url:
        sys.stdout.write(latest_url)
    sys.exit(0)

if not url or not out_path:
    sys.stderr.write(f'unexpected curl args: {{args}}\\n')
    sys.exit(2)

fixture_dir = pathlib.Path(os.environ['CADENCE_TEST_FIXTURE_DIR'])
name = url.rsplit('/', 1)[-1]
src = fixture_dir / name
if not src.is_file():
    sys.stderr.write(f'curl: (22) The requested URL returned error: 404 ({{name}})\\n')
    sys.exit(22)

shutil.copyfile(src, out_path)
sys.exit(0)
"""

FAKE_SUDO_PY = f"""#!{sys.executable}
import json
import os
import subprocess
import sys

args = sys.argv[1:]
with open(os.environ['CADENCE_TEST_SUDO_LOG'], 'w', encoding='utf-8') as fh:
    json.dump(args, fh)

if not args or args[0] != 'env':
    sys.stderr.write(f'expected sudo env ..., got: {{args}}\\n')
    sys.exit(97)

env = os.environ.copy()
idx = 1
while idx < len(args) and '=' in args[idx]:
    k, v = args[idx].split('=', 1)
    env[k] = v
    idx += 1

cmd = args[idx:]
res = subprocess.run(cmd, env=env)
sys.exit(res.returncode)
"""


def _sha256_text(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def _write_text_lf(path_obj, content):
    path_obj.write_bytes(content.replace('\r\n', '\n').encode('utf-8'))


def _build_hermetic_bin(bin_dir):
    """Populate bin_dir with symlinks to host POSIX utilities only (excluding curl, sudo, midclt)."""
    bin_dir.mkdir(exist_ok=True)
    for tool in ('sh', 'mktemp', 'rm', 'dirname', 'id', 'env', 'cat', 'chmod', 'mkdir', 'cp', 'mv'):
        resolved = shutil.which(tool)
        if resolved:
            link = bin_dir / tool
            if not link.exists():
                link.symlink_to(resolved)
    py_link = bin_dir / 'python3'
    if not py_link.exists():
        py_link.symlink_to(pathlib.Path(sys.executable))


def _run_install_sh(sh_path, cwd, hermetic_bin, env, truenas_mock=False):
    """Execute install.sh via shell functions so mock curl/sudo/midclt work even when /tmp is noexec."""
    run_env = env.copy()
    run_env['PATH'] = str(hermetic_bin)
    run_env['CADENCE_TEST_PYTHON'] = sys.executable

    funcs = ['curl() { "$CADENCE_TEST_PYTHON" "$CADENCE_TEST_FAKE_CURL" "$@"; }']
    if truenas_mock:
        funcs.extend([
            'midclt() { return 0; }',
            'id() { if [ "${1:-}" = "-u" ]; then echo 1000; else command id "$@"; fi; }',
            'sudo() { "$CADENCE_TEST_PYTHON" "$CADENCE_TEST_FAKE_SUDO" "$@"; }',
        ])
    wrapper = '\n'.join(funcs) + '\n. "$0"\n'
    return subprocess.run(
        ['sh', '-c', wrapper, str(sh_path)],
        cwd=str(cwd),
        env=run_env,
        capture_output=True,
        text=True,
    )


FAKE_CURL_FAIL_ON_CALL_PY = """import sys
sys.stderr.write('unexpected curl invocation during local bundle test\\n')
sys.exit(98)
"""


@unittest.skipUnless(
    os.name == 'posix' and shutil.which('sh') and shutil.which('python3'),
    'POSIX sh and python3 required for install.sh end-to-end tests',
)
class InstallShSupplyChainTests(unittest.TestCase):
    INSTALL_SH_SRC = pathlib.Path(__file__).with_name('install.sh')
    COMPOSE_BODY = pathlib.Path(__file__).with_name('compose.yml').read_text(encoding='utf-8')
    COMPOSE_HARDENED_BODY = pathlib.Path(__file__).with_name('compose.hardened.yml').read_text(encoding='utf-8')

    def _run_remote_install_sh(
        self,
        fixtures,
        substituted_tag='v1.2.3',
        extra_env=None,
        truenas_mock=False,
    ):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            hermetic_bin = root / 'bin'
            _build_hermetic_bin(hermetic_bin)
            mocks_dir = root / 'mocks'
            mocks_dir.mkdir()
            fixture_dir = root / 'fixtures'
            fixture_dir.mkdir()
            runner_dir = root / 'runner'
            runner_dir.mkdir()

            fake_curl_py = mocks_dir / 'fake_curl.py'
            fake_sudo_py = mocks_dir / 'fake_sudo.py'
            _write_text_lf(fake_curl_py, FAKE_CURL_PY)
            _write_text_lf(fake_sudo_py, FAKE_SUDO_PY)

            for fname, content in fixtures.items():
                _write_text_lf(fixture_dir / fname, content)

            sh_text = self.INSTALL_SH_SRC.read_text(encoding='utf-8')
            if substituted_tag is not None:
                sh_text = sh_text.replace('__CADENCE_RELEASE_TAG__', substituted_tag)
            sh_path = runner_dir / 'install.sh'
            _write_text_lf(sh_path, sh_text)

            sentinel = root / 'sentinel.json'
            curl_log = root / 'curl.jsonl'
            sudo_log = root / 'sudo.json'

            env = os.environ.copy()
            env['CADENCE_TEST_FAKE_CURL'] = str(fake_curl_py)
            env['CADENCE_TEST_FAKE_SUDO'] = str(fake_sudo_py)
            env['CADENCE_TEST_FIXTURE_DIR'] = str(fixture_dir)
            env['CADENCE_TEST_SENTINEL'] = str(sentinel)
            env['CADENCE_TEST_CURL_LOG'] = str(curl_log)
            env['CADENCE_TEST_SUDO_LOG'] = str(sudo_log)
            for key in ('CADENCE_CHECKSUMS_FILE', 'CADENCE_INSTALLER_RELEASE', 'CADENCE_ALLOW_UNVERIFIED'):
                env.pop(key, None)
            if extra_env:
                env.update(extra_env)

            proc = _run_install_sh(sh_path, runner_dir, hermetic_bin, env, truenas_mock=truenas_mock)
            sentinel_data = json.loads(sentinel.read_text(encoding='utf-8')) if sentinel.is_file() else None
            curl_calls = (
                [json.loads(line) for line in curl_log.read_text(encoding='utf-8').splitlines() if line.strip()]
                if curl_log.is_file()
                else []
            )
            sudo_args = json.loads(sudo_log.read_text(encoding='utf-8')) if sudo_log.is_file() else None
            return proc, sentinel_data, curl_calls, sudo_args

    def _valid_checksums(self, include_hardened=True):
        lines = [
            f"{_sha256_text(FIXTURE_INSTALL_PY)}  install.py",
            f"{_sha256_text(self.COMPOSE_BODY)}  compose.yml",
        ]
        if include_hardened:
            lines.append(f"{_sha256_text(self.COMPOSE_HARDENED_BODY)}  compose.hardened.yml")
        return '\n'.join(lines) + '\n'

    def test_install_sh_valid_release_verifies_all_assets_before_running(self):
        fixtures = {
            'install.py': FIXTURE_INSTALL_PY,
            'compose.yml': self.COMPOSE_BODY,
            'compose.hardened.yml': self.COMPOSE_HARDENED_BODY,
            'cadence_checksums.txt': self._valid_checksums(include_hardened=True),
        }
        proc, sentinel, curl_calls, _ = self._run_remote_install_sh(fixtures, substituted_tag='v1.2.3')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIsNotNone(sentinel)
        self.assertEqual(sentinel['installer_release'], 'v1.2.3')
        self.assertTrue(sentinel['checksums_file'].endswith('cadence_checksums.txt'))
        self.assertIn('compose.yml', sentinel['siblings'])
        self.assertIn('compose.hardened.yml', sentinel['siblings'])
        self.assertIn('Verified install.py SHA256', proc.stdout)
        self.assertIn('Verified compose.yml SHA256', proc.stdout)
        self.assertIn('Verified compose.hardened.yml SHA256', proc.stdout)
        self.assertTrue(curl_calls)
        for call in curl_calls:
            self.assertIn('--proto', call)
            self.assertIn('=https', call)
            self.assertIn('--tlsv1.2', call)

        # Also verify unsubstituted install.sh resolving /releases/latest redirect cleanly.
        proc_latest, sentinel_latest, curl_latest, _ = self._run_remote_install_sh(
            fixtures,
            substituted_tag=None,
            extra_env={'CADENCE_TEST_LATEST_EFFECTIVE_URL': 'https://github.com/matbhuvi-tech/Cadence/releases/tag/v1.2.3'},
        )
        self.assertEqual(proc_latest.returncode, 0, proc_latest.stderr)
        self.assertEqual(sentinel_latest['installer_release'], 'v1.2.3')
        self.assertTrue(any('--head' in c and '%{url_effective}' in c for c in curl_latest))

    def test_install_sh_rejects_tampered_install_py_before_execution(self):
        fixtures = {
            'install.py': FIXTURE_INSTALL_PY + '# tampered\n',
            'compose.yml': self.COMPOSE_BODY,
            'compose.hardened.yml': self.COMPOSE_HARDENED_BODY,
            'cadence_checksums.txt': self._valid_checksums(),
        }
        proc, sentinel, _, _ = self._run_remote_install_sh(fixtures)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('SHA256 mismatch for install.py', proc.stderr)
        self.assertIsNone(sentinel)

    def test_install_sh_rejects_tampered_compose_yml_before_execution(self):
        fixtures = {
            'install.py': FIXTURE_INSTALL_PY,
            'compose.yml': self.COMPOSE_BODY + '# tampered\n',
            'compose.hardened.yml': self.COMPOSE_HARDENED_BODY,
            'cadence_checksums.txt': self._valid_checksums(),
        }
        proc, sentinel, _, _ = self._run_remote_install_sh(fixtures)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('SHA256 mismatch for compose.yml', proc.stderr)
        self.assertIsNone(sentinel)

    def test_install_sh_rejects_tampered_compose_hardened_yml_before_execution(self):
        fixtures = {
            'install.py': FIXTURE_INSTALL_PY,
            'compose.yml': self.COMPOSE_BODY,
            'compose.hardened.yml': self.COMPOSE_HARDENED_BODY + '# tampered\n',
            'cadence_checksums.txt': self._valid_checksums(include_hardened=True),
        }
        proc, sentinel, _, _ = self._run_remote_install_sh(fixtures)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('SHA256 mismatch for compose.hardened.yml', proc.stderr)
        self.assertIsNone(sentinel)

    def test_install_sh_rejects_conflicting_duplicate_checksum_entries(self):
        conflicting_cs = (
            self._valid_checksums()
            + f"{'0' * 64}  install.py\n"
        )
        fixtures = {
            'install.py': FIXTURE_INSTALL_PY,
            'compose.yml': self.COMPOSE_BODY,
            'compose.hardened.yml': self.COMPOSE_HARDENED_BODY,
            'cadence_checksums.txt': conflicting_cs,
        }
        proc, sentinel, _, _ = self._run_remote_install_sh(fixtures)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('Conflicting SHA256 entries for install.py', proc.stderr)
        self.assertIsNone(sentinel)

    def test_install_sh_missing_checksums_fails_closed_unless_allow_unverified(self):
        fixtures = {
            'install.py': FIXTURE_INSTALL_PY,
            'compose.yml': self.COMPOSE_BODY,
        }
        proc_fail, sentinel_fail, _, _ = self._run_remote_install_sh(fixtures)
        self.assertNotEqual(proc_fail.returncode, 0)
        self.assertIn('cadence_checksums.txt', proc_fail.stderr)
        self.assertIsNone(sentinel_fail)

        proc_ok, sentinel_ok, _, _ = self._run_remote_install_sh(
            fixtures,
            extra_env={'CADENCE_ALLOW_UNVERIFIED': '1'},
        )
        self.assertEqual(proc_ok.returncode, 0, proc_ok.stderr)
        self.assertIn('CADENCE_ALLOW_UNVERIFIED=1', proc_ok.stderr)
        self.assertIsNotNone(sentinel_ok)

    def test_install_sh_local_bundle_verifies_when_checksums_present(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            hermetic_bin = root / 'bin'
            _build_hermetic_bin(hermetic_bin)
            fake_curl_py = root / 'fake_curl_fail.py'
            _write_text_lf(fake_curl_py, FAKE_CURL_FAIL_ON_CALL_PY)

            bundle = root / 'bundle'
            bundle.mkdir()
            sentinel = root / 'sentinel.json'
            sh_path = bundle / 'install.sh'
            _write_text_lf(sh_path, self.INSTALL_SH_SRC.read_text(encoding='utf-8'))
            _write_text_lf(bundle / 'install.py', FIXTURE_INSTALL_PY)
            _write_text_lf(bundle / 'compose.yml', self.COMPOSE_BODY)
            _write_text_lf(bundle / 'cadence_checksums.txt', self._valid_checksums(include_hardened=False))

            env = os.environ.copy()
            env['CADENCE_TEST_FAKE_CURL'] = str(fake_curl_py)
            env['CADENCE_TEST_SENTINEL'] = str(sentinel)
            env.pop('CADENCE_CHECKSUMS_FILE', None)
            proc_ok = _run_install_sh(sh_path, bundle, hermetic_bin, env, truenas_mock=False)
            self.assertEqual(proc_ok.returncode, 0, proc_ok.stderr)
            self.assertTrue(sentinel.is_file())
            data = json.loads(sentinel.read_text(encoding='utf-8'))
            self.assertEqual(data['checksums_file'], str(bundle / 'cadence_checksums.txt'))

            sentinel.unlink()
            _write_text_lf(bundle / 'compose.yml', self.COMPOSE_BODY + '# tampered\n')
            proc_bad = _run_install_sh(sh_path, bundle, hermetic_bin, env, truenas_mock=False)
            self.assertNotEqual(proc_bad.returncode, 0)
            self.assertIn('SHA256 mismatch for compose.yml', proc_bad.stderr)
            self.assertFalse(sentinel.is_file())

    def test_install_sh_truenas_nonroot_uses_sudo_env(self):
        fixtures = {
            'install.py': FIXTURE_INSTALL_PY,
            'compose.yml': self.COMPOSE_BODY,
            'compose.hardened.yml': self.COMPOSE_HARDENED_BODY,
            'cadence_checksums.txt': self._valid_checksums(include_hardened=True),
        }
        proc, sentinel, _, sudo_args = self._run_remote_install_sh(
            fixtures,
            substituted_tag='v1.2.3',
            truenas_mock=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIsNotNone(sentinel)
        self.assertIsNotNone(sudo_args)
        self.assertEqual(sudo_args[0], 'env')
        self.assertTrue(any(a.startswith('CADENCE_CHECKSUMS_FILE=') and a.endswith('cadence_checksums.txt') for a in sudo_args))
        self.assertIn('CADENCE_INSTALLER_RELEASE=v1.2.3', sudo_args)
        self.assertIn('CADENCE_ALLOW_UNVERIFIED=', sudo_args)
        self.assertEqual(sudo_args[-2], 'python3')
        self.assertTrue(sentinel['checksums_file'].endswith('cadence_checksums.txt'))
        self.assertEqual(sentinel['installer_release'], 'v1.2.3')


if __name__ == '__main__':
    unittest.main()
