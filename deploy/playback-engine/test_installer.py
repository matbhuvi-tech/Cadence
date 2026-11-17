import importlib.util
import pathlib
import tempfile
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


if __name__ == '__main__':
    unittest.main()
