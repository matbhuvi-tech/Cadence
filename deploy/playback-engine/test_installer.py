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
                'CADENCE_HOST_DATA_DIR': '/data',
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
            service = json.loads(result.stdout)['services']['playback-engine']
            self.assertEqual(service['environment']['CADENCE_LABEL'], 'Music #1')
            # Compose escapes dollar signs when emitting a configuration for reuse.
            self.assertEqual(service['volumes'][1]['source'], "/music/John's $$ records")

    @unittest.skipUnless(_has_native_docker_compose(), 'Native Docker Compose unavailable')
    def test_compose_hardened_reads_special_characters_literally(self):
        with tempfile.TemporaryDirectory() as d:
            env_file = pathlib.Path(d) / '.env'
            values = {
                'CADENCE_HOST_MUSIC_DIR': "/music/John's $ records",
                'CADENCE_LABEL': 'Music #1',
                'CADENCE_HOST_DATA_DIR': '/data',
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
            service = json.loads(result.stdout)['services']['playback-engine']
            self.assertEqual(service['user'], '568:568')
            self.assertEqual(service['environment']['CADENCE_MUSIC_READ_ONLY'], 'true')
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
                 mock.patch.dict(os.environ, {'SUDO_USER': ''}), \
                 mock.patch.dict(sys.modules, {'pwd': types.SimpleNamespace()}), \
                 mock.patch.object(pathlib.Path, 'home', return_value=root), \
                 mock.patch('builtins.input', side_effect=['n']):
                with self.assertRaises(installer.InstallError):
                    installer.main()
            self.assertEqual((install_dir / '.env').read_text(encoding='utf-8'), "CADENCE_IMAGE='example:v1'\n")

    def test_linux_first_install_standard_smb_default(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / 'data').mkdir()
            result = types.SimpleNamespace(stdout='', returncode=0)
            # Tag default, IP default, Profile default (Enter -> Standard), Music '-', Data path
            answers = ['', '', '', '-', str(root / 'data')]
            with mock.patch.object(installer.sys, 'platform', 'linux'), \
                 mock.patch.object(os, 'uname', return_value=types.SimpleNamespace(machine='x86_64'), create=True), \
                 mock.patch.dict(os.environ, {'SUDO_USER': '', 'CADENCE_INSTALLER_RELEASE': ''}), \
                 mock.patch.dict(sys.modules, {'pwd': types.SimpleNamespace()}), \
                 mock.patch.object(pathlib.Path, 'home', return_value=root), \
                 mock.patch.object(installer, 'latest_release', return_value='v1.2.3'), \
                 mock.patch.object(installer, 'default_ip', return_value='192.168.1.12'), \
                 mock.patch.object(installer, 'ensure_docker'), \
                 mock.patch.object(installer, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(installer, 'check_cifs_support') as mock_cifs, \
                 mock.patch.object(installer, 'test_as_cadence', return_value=(True, '')), \
                 mock.patch.object(installer, 'run', return_value=result) as run, \
                 mock.patch('builtins.input', side_effect=answers):
                installer.main()

            env = (root / 'cadence-playback-engine' / '.env').read_text(encoding='utf-8')
            compose = (root / 'cadence-playback-engine' / 'compose.yml').read_text(encoding='utf-8')
            self.assertIn('cadence-playback-engine:v1.2.3', env)
            self.assertIn('192.168.1.12', env)
            self.assertIn("CADENCE_DEPLOYMENT_PROFILE='standard'", env)
            self.assertIn('SYS_ADMIN', compose)
            self.assertNotIn('LOCAL_MUSIC_VOLUME_START', compose)
            self.assertNotIn('target: /music', compose)
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
            (root / 'data').mkdir()
            result = types.SimpleNamespace(stdout='', returncode=0)
            # Tag default, IP default, Profile '2' (hardened), '-' rejected then real music dir, Data path
            answers = ['', '', '2', '-', str(root / 'music'), str(root / 'data')]
            with mock.patch.object(installer.sys, 'platform', 'linux'), \
                 mock.patch.object(os, 'uname', return_value=types.SimpleNamespace(machine='x86_64'), create=True), \
                 mock.patch.dict(os.environ, {'SUDO_USER': '', 'CADENCE_INSTALLER_RELEASE': ''}), \
                 mock.patch.dict(sys.modules, {'pwd': types.SimpleNamespace()}), \
                 mock.patch.object(pathlib.Path, 'home', return_value=root), \
                 mock.patch.object(installer, 'latest_release', return_value='v1.2.3'), \
                 mock.patch.object(installer, 'default_ip', return_value='192.168.1.12'), \
                 mock.patch.object(installer, 'ensure_docker'), \
                 mock.patch.object(installer, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(installer, 'check_cifs_support') as mock_cifs, \
                 mock.patch.object(installer, 'test_as_cadence', return_value=(True, '')), \
                 mock.patch.object(installer, 'run', return_value=result) as run, \
                 mock.patch('builtins.input', side_effect=answers):
                installer.main()

            env = (root / 'cadence-playback-engine' / '.env').read_text(encoding='utf-8')
            compose = (root / 'cadence-playback-engine' / 'compose.yml').read_text(encoding='utf-8')
            self.assertIn("CADENCE_DEPLOYMENT_PROFILE='hardened'", env)
            self.assertIn('user: "568:568"', compose)
            self.assertIn('CADENCE_MUSIC_READ_ONLY: "true"', compose)
            self.assertNotIn('SYS_ADMIN', compose)
            self.assertNotIn('apparmor:unconfined', compose)
            mock_cifs.assert_not_called()
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(any('test -w /var/lib/cadence && test -r /music' in cmd[-1] for cmd in commands))

    def test_truenas_never_installs_system_packages(self):
        with mock.patch.object(installer.shutil, 'which', return_value=None), \
             mock.patch.object(installer, 'run') as run:
            with self.assertRaises(installer.InstallError):
                installer.ensure_docker(truenas=True)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
