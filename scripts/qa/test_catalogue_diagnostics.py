"""Offline diagnostics regression fixtures. Run: python -m unittest discover -s scripts/qa -p test_catalogue_diagnostics.py"""
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

TOOLS = Path(__file__).resolve().parents[2] / 'tools'
sys.path.insert(0, str(TOOLS))


def load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CatalogueDiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'Music'
        self.root.mkdir()
        self.db = self.base / 'cadence.db'
        with closing(sqlite3.connect(self.db)) as c, c:
            c.executescript('''
                CREATE TABLE watched_folders(id TEXT, folder_path TEXT, is_enabled INTEGER);
                CREATE TABLE tracks(id TEXT, release_id TEXT, file_path TEXT, title TEXT, artist_credit TEXT, album_title TEXT, file_size INTEGER, mtime INTEGER, has_embedded_art INTEGER);
                CREATE TABLE releases(id TEXT, folder_path TEXT, title TEXT, front_cover_url TEXT);
                CREATE TABLE engine_artwork(release_id TEXT, etag TEXT, jpeg BLOB);
            ''')
            c.execute('INSERT INTO watched_folders VALUES(?,?,1)', ('w', str(self.root)))
        self.exporter = load('Export-CadenceDatabase')
        self.compare = load('Compare-CadenceCatalogue')

    def wav(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), 'wb') as w:
            w.setparams((2, 2, 44100, 0, 'NONE', 'not compressed'))
            w.writeframes(b'\0' * 400)

    def test_database_readonly_and_blob_hash(self):
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('INSERT INTO engine_artwork VALUES(?,?,?)', ('r', 'etag', b'jpeg'))
        before = self.db.read_bytes()
        report = self.exporter.database_snapshot(self.db, guard=lambda: None)
        self.assertEqual(before, self.db.read_bytes())
        art = report['tables']['engine_artwork'][0]['jpeg']
        self.assertEqual(art['bytes'], 4)
        self.assertEqual(len(art['sha256']), 64)
        self.assertEqual(report['integrity'], ['ok'])

    def test_scanner_scope_and_corrupt_metadata(self):
        self.wav(self.root / 'Album' / 'a.wav')
        self.wav(self.base / 'Music-other' / 'outside.wav')
        (self.root / 'bad.flac').write_bytes(b'not flac')
        report = self.exporter.filesystem_snapshot(self.db, guard=lambda: None)
        self.assertEqual(len(report['tracks']), 2)
        self.assertEqual(len(report['errors']), 1)
        self.assertTrue(report['complete'])
        self.assertNotIn('outside.wav', json.dumps(report))

    def test_compare_mismatches_and_scope(self):
        path = self.root / 'a.wav'
        self.wav(path)
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('INSERT INTO releases VALUES(?,?,?,?)', ('r', str(self.root), 'Album', str(self.root / 'missing.jpg')))
            c.execute('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', ('t', 'r', str(path), 'Wrong', 'Artist', 'Album', 1, 0, 1))
            c.execute('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', ('x', 'r', str(self.base / 'Music-other' / 'x.wav'), 'x', '', '', 1, 0, 0))
        fs = self.exporter.filesystem_snapshot(self.db, guard=lambda: None)
        db = self.exporter.database_snapshot(self.db, guard=lambda: None)
        result = self.compare.compare(fs, db)
        codes = {i['code'] for i in result['findings']}
        self.assertTrue({'file_size_mismatch', 'mtime_mismatch', 'db_track_outside_scope', 'art_flag_without_blob', 'art_reference_missing'} <= codes)

    def test_reject_scope_and_database_mismatch(self):
        fs = self.exporter.filesystem_snapshot(self.db, guard=lambda: None)
        db = self.exporter.database_snapshot(self.db, guard=lambda: None)
        db['scopeFingerprint'] = 'different'
        with self.assertRaises(ValueError):
            self.compare.compare(fs, db)

    def test_no_registered_folders_and_missing_db(self):
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('DELETE FROM watched_folders')
        with self.assertRaises(ValueError):
            self.exporter.filesystem_snapshot(self.db, guard=lambda: None)
        with self.assertRaises(FileNotFoundError):
            self.exporter.database_snapshot(self.base / 'absent.db', guard=lambda: None)

    def test_picture_types_hashes_and_sidecar(self):
        from PIL import Image
        from mutagen.wave import WAVE
        from mutagen.id3 import APIC, TIT2
        import io
        path = self.root / 'art.wav'
        self.wav(path)
        image = io.BytesIO()
        Image.new('RGB', (16, 16), 'red').save(image, format='PNG')
        audio = WAVE(path)
        audio.add_tags()
        audio.tags.add(TIT2(encoding=3, text=['Test Song']))
        audio.tags.add(APIC(encoding=3, mime='image/png', type=4, desc='back', data=image.getvalue()))
        audio.tags.add(APIC(encoding=3, mime='image/png', type=3, desc='front', data=image.getvalue()))
        audio.save()
        (self.root / 'cover.png').write_bytes(image.getvalue())
        (self.root / 'cadence-album.sidecar.json').write_text('{"coverArtUrl":"cover.png"}')
        result = self.exporter.filesystem_snapshot(self.db, guard=lambda: None)
        track = result['tracks'][0]
        self.assertEqual(track['metadata']['title'], 'Test Song')
        self.assertEqual({p['type'] for p in track['embeddedPictures']}, {3, 4})
        self.assertTrue(all(p['valid'] for p in track['embeddedPictures']))
        self.assertEqual(result['images'][0]['sha256'], track['embeddedPictures'][0]['sha256'])
        self.assertEqual(result['sidecars'][0]['data']['coverArtUrl'], 'cover.png')

    def test_overlapping_and_disabled_registered_roots(self):
        path = self.root / 'Album' / 'a.wav'
        self.wav(path)
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('INSERT INTO watched_folders VALUES(?,?,0)', ('disabled', str(path.parent)))
        report = self.exporter.filesystem_snapshot(self.db, guard=lambda: None)
        self.assertEqual(len(report['roots']), 2)
        self.assertEqual(len(report['tracks']), 1)

    def test_missing_root_incomplete_and_missing_files_suppressed(self):
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute('INSERT INTO watched_folders VALUES(?,?,1)', ('absent', str(self.base / 'absent')))
            c.execute('INSERT INTO releases VALUES(?,?,?,NULL)', ('r', str(self.root), 'Album'))
            c.execute('INSERT INTO tracks VALUES(?,?,?,?,?,?,?,?,?)', ('t', 'r', str(self.root / 'lost.wav'), '', '', '', 0, 0, 0))
        files = self.exporter.filesystem_snapshot(self.db, guard=lambda: None)
        self.assertFalse(files['complete'])
        result = self.compare.compare(files, self.exporter.database_snapshot(self.db, guard=lambda: None))
        self.assertNotIn('db_track_missing_on_disk', {f['code'] for f in result['findings']})

    def test_protect_inputs_music_and_existing_output(self):
        with self.assertRaises(ValueError):
            self.exporter.write_report({}, self.root / 'report.json', [self.root])
        with self.assertRaises(ValueError):
            self.exporter.write_report({}, self.db, protected=[self.db])
        output = self.base / 'report.json'
        self.exporter.write_report({}, output)
        with self.assertRaises(FileExistsError):
            self.exporter.write_report({}, output)

    def test_cli_snapshot_and_baseline_workflow(self):
        self.wav(self.root / 'new.wav')
        files = self.base / 'files.json'
        database = self.base / 'database.json'
        before = self.base / 'before.json'
        after = self.base / 'after.json'
        with patch.object(self.exporter, 'offline_guard', lambda: None):
            for flags, output in [(['--filesystem'], files), ([], database)]:
                with patch.object(sys, 'argv', ['export', '--db', str(self.db), '--output', str(output), '--offline-confirmed', *flags]):
                    self.assertEqual(self.exporter.main(), 0)
        with patch.object(sys, 'argv', ['compare', '--files', str(files), '--database', str(database), '--output', str(before)]):
            self.assertEqual(self.compare.main(), 1)
        with patch.object(sys, 'argv', ['compare', '--files', str(files), '--database', str(database), '--output', str(after), '--baseline', str(before)]):
            self.assertEqual(self.compare.main(), 1)
        changes = json.loads(after.read_text())['changes']
        self.assertEqual(changes['added'], [])
        self.assertEqual(changes['resolved'], [])
        self.assertEqual(changes['unchanged'], 1)

    def test_guard_interrupts_scan(self):
        def refused():
            raise RuntimeError('playback active')
        with self.assertRaisesRegex(RuntimeError, 'playback active'):
            self.exporter.filesystem_snapshot(self.db, guard=refused)

    def test_invalid_image_and_sidecar(self):
        (self.root / 'cover.jpg').write_bytes(b'corrupt')
        (self.root / 'cadence-album.sidecar.json').write_text('{invalid')
        result = self.exporter.filesystem_snapshot(self.db, guard=lambda: None)
        self.assertFalse(result['images'][0]['valid'])
        self.assertIn('error', result['sidecars'][0])
        comparison = self.compare.compare(result, self.exporter.database_snapshot(self.db, guard=lambda: None))
        self.assertTrue({'folder_art_invalid_or_unverified', 'sidecar_invalid'} <= {f['code'] for f in comparison['findings']})

    def test_dsf_native_clock_and_id3_picture(self):
        from mutagen.dsf import DSF
        from mutagen.id3 import APIC, TIT2
        path = self.root / 'native.dsf'
        payload = b'\x69' * 8192
        data = struct.pack('<4sQ', b'data', len(payload) + 12) + payload
        fmt = struct.pack('<4sQIIIIIIQII', b'fmt ', 52, 1, 0, 2, 2, 11289600, 8, 32768, 4096, 0)
        path.write_bytes(struct.pack('<4sQQQ', b'DSD ', 28, 28 + len(fmt) + len(data), 0) + fmt + data)
        dsf = DSF(path)
        dsf.add_tags()
        dsf.tags.add(TIT2(encoding=3, text=['Native DSD256']))
        dsf.tags.add(APIC(encoding=3, mime='image/png', type=3, desc='bad picture', data=b'invalid'))
        dsf.save()
        result = self.exporter.filesystem_snapshot(self.db, guard=lambda: None)['tracks'][0]
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(result['metadata']['title'], 'Native DSD256')
        self.assertEqual(result['technical']['sample_rate'], 11289600)
        self.assertEqual(result['technical']['bit_depth'], 1)
        self.assertFalse(result['embeddedPictures'][0]['valid'])

    def test_relative_scope_rejected(self):
        with closing(sqlite3.connect(self.db)) as c, c:
            c.execute("UPDATE watched_folders SET folder_path=''")
        with self.assertRaisesRegex(ValueError, 'absolute paths'):
            self.exporter.filesystem_snapshot(self.db, guard=lambda: None)


if __name__ == '__main__':
    unittest.main()

