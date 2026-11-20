import json
import pathlib
import tempfile
import unittest

import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import sync_version


def _create_fixture_repo(root: pathlib.Path) -> None:
    (root / 'pwa' / 'android' / 'app').mkdir(parents=True)
    (root / 'src-tauri').mkdir(parents=True)

    (root / 'package.json').write_text(json.dumps({'name': 'music-agent', 'version': '0.0.0'}, indent=2) + '\n', encoding='utf-8')
    (root / 'package-lock.json').write_text(
        json.dumps({'name': 'music-agent', 'version': '0.0.0', 'packages': {'': {'name': 'music-agent', 'version': '0.0.0'}}}, indent=2) + '\n',
        encoding='utf-8',
    )
    (root / 'pwa' / 'package.json').write_text(json.dumps({'name': 'cadence-remote-pwa', 'version': '0.1.0'}, indent=2) + '\n', encoding='utf-8')
    (root / 'pwa' / 'package-lock.json').write_text(
        json.dumps({'name': 'cadence-remote-pwa', 'version': '0.1.0', 'packages': {'': {'name': 'cadence-remote-pwa', 'version': '0.1.0'}}}, indent=2) + '\n',
        encoding='utf-8',
    )
    (root / 'src-tauri' / 'tauri.conf.json').write_text(
        json.dumps({'productName': 'Cadence Core', 'version': '0.1.0-2'}, indent=2) + '\n',
        encoding='utf-8',
    )
    (root / 'src-tauri' / 'Cargo.toml').write_text(
        '[package]\nname = "cadence-core"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1.0" }\n',
        encoding='utf-8',
    )
    (root / 'src-tauri' / 'Cargo.lock').write_text(
        '[[package]]\nname = "axum"\nversion = "0.7.9"\n\n[[package]]\nname = "cadence-core"\nversion = "0.1.0"\ndependencies = [\n "axum",\n]\n',
        encoding='utf-8',
    )
    (root / 'pwa' / 'android' / 'app' / 'build.gradle').write_text(
        'android {\n    defaultConfig {\n        applicationId "com.cadence.remote"\n        versionCode 1\n        versionName "0.1.0"\n    }\n}\n',
        encoding='utf-8',
    )


class SyncVersionTests(unittest.TestCase):
    def test_parse_semver_variants_and_rejections(self):
        self.assertEqual(sync_version.parse_semver('v0.1.0-rc.2').semver, '0.1.0-rc.2')
        self.assertEqual(sync_version.parse_semver('1.2.3').semver, '1.2.3')
        for bad in ('', 'latest', 'v1.2', 'v01.2.3', 'v1.2.3-rc..1', 'v1.2.3+meta'):
            with self.assertRaises(ValueError, msg=bad):
                sync_version.parse_semver(bad)

    def test_android_version_code_monotonic_order(self):
        versions = ['0.1.0-alpha.5', '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0', '0.1.1']
        codes = [sync_version.compute_android_version_code(v) for v in versions]
        self.assertEqual(codes, sorted(set(codes)))
        self.assertEqual(codes, [10015, 10062, 10063, 10099, 10199])

    def test_set_and_check_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            _create_fixture_repo(root)

            # Check fails before sync
            self.assertEqual(sync_version.main(['--check', 'v0.2.0-rc.3', '--root', str(root)]), 1)

            # Set syncs all manifests
            self.assertEqual(sync_version.main(['--set', 'v0.2.0-rc.3', '--root', str(root)]), 0)
            self.assertEqual(sync_version.main(['--check', '0.2.0-rc.3', '--root', str(root)]), 0)

            cargo_toml = (root / 'src-tauri' / 'Cargo.toml').read_text(encoding='utf-8')
            self.assertIn('version = "0.2.0-rc.3"', cargo_toml)
            self.assertIn('serde = { version = "1.0" }', cargo_toml)

            cargo_lock = (root / 'src-tauri' / 'Cargo.lock').read_text(encoding='utf-8')
            self.assertIn('name = "axum"\nversion = "0.7.9"', cargo_lock)
            self.assertIn('name = "cadence-core"\nversion = "0.2.0-rc.3"', cargo_lock)

            gradle = (root / 'pwa' / 'android' / 'app' / 'build.gradle').read_text(encoding='utf-8')
            self.assertIn('versionCode 20063', gradle)
            self.assertIn('versionName "0.2.0-rc.3"', gradle)

            # Check catches drift on a subsequent version
            self.assertEqual(sync_version.main(['--check', 'v0.2.0', '--root', str(root)]), 1)


if __name__ == '__main__':
    unittest.main()
