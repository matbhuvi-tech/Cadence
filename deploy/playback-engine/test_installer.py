import importlib.util
import pathlib
import tempfile
import types
import unittest
from unittest import mock

path = pathlib.Path(__file__).with_name('install.py')
spec = importlib.util.spec_from_file_location('installer', path)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


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

    def test_paths_must_not_overlap(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / 'music').mkdir()
            self.assertFalse(installer.paths_separate(root, root / 'music'))
            self.assertTrue(installer.paths_separate(root / 'data', root / 'music'))

    def test_truenas_payload_is_resolved_and_uses_custom_app(self):
        with mock.patch.object(installer, 'run') as run:
            installer.create_truenas_app('/tmp/compose.yml', '{"services":{}}')
            args = run.call_args.args[0]
            self.assertEqual(args[:4], ['midclt', 'call', '-job', 'app.create'])
            import json
            payload = json.loads(args[4])
            self.assertEqual(payload['app_name'], 'cadence-playback-engine')
            self.assertTrue(payload['custom_app'])
            self.assertEqual(payload['custom_compose_config'], {'services': {}})

    def test_existing_installation_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            target = pathlib.Path(d)
            (target / '.env').write_text('existing')
            with self.assertRaises(installer.InstallError):
                installer.ensure_fresh(target)
            self.assertEqual((target / '.env').read_text(), 'existing')

    def test_linux_first_install_uses_release_and_starts_compose(self):
        import os
        import sys
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / 'music').mkdir()
            (root / 'data').mkdir()
            result = types.SimpleNamespace(stdout='', returncode=0)
            answers = ['', '', str(root / 'music'), str(root / 'data')]
            with mock.patch.object(installer.sys, 'platform', 'linux'), \
                 mock.patch.object(os, 'uname', return_value=types.SimpleNamespace(machine='x86_64'), create=True), \
                 mock.patch.dict(os.environ, {'SUDO_USER': ''}), \
                 mock.patch.dict(sys.modules, {'pwd': types.SimpleNamespace()}), \
                 mock.patch.object(pathlib.Path, 'home', return_value=root), \
                 mock.patch.object(installer, 'latest_release', return_value='v1.2.3'), \
                 mock.patch.object(installer, 'default_ip', return_value='192.168.1.12'), \
                 mock.patch.object(installer, 'fetch', return_value='services: {}'), \
                 mock.patch.object(installer, 'ensure_docker'), \
                 mock.patch.object(installer, 'docker_prefix', return_value=['docker']), \
                 mock.patch.object(installer, 'run', return_value=result) as run, \
                 mock.patch('builtins.input', side_effect=answers):
                installer.main()
            env = (root / 'cadence-playback-engine' / '.env').read_text()
            self.assertIn('cadence-playback-engine:v1.2.3', env)
            self.assertIn('192.168.1.12', env)
            commands = [call.args[0] for call in run.call_args_list]
            self.assertTrue(any(cmd[-1:] == ['pull'] for cmd in commands))
            self.assertTrue(any(cmd[-5:] == ['up', '-d', '--wait', '--wait-timeout', '120'] for cmd in commands))
            self.assertTrue(any('test -r /music' in cmd[-1] for cmd in commands))

    def test_truenas_never_installs_system_packages(self):
        with mock.patch.object(installer.shutil, 'which', return_value=None), \
             mock.patch.object(installer, 'run') as run:
            with self.assertRaises(installer.InstallError):
                installer.ensure_docker(truenas=True)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
