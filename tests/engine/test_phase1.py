"""Disposable real-process HTTP acceptance. No production endpoints or media.

Run with deploy/engine-regression/Dockerfile; only Python's standard library is used.
Fixtures contain valid container headers, real encoded PCM and synthetic DSD256.
"""
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import struct
import subprocess
import tempfile
import time
import unittest


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def id3(title):
    value = b"\x03" + title.encode()
    frames = b"TIT2" + struct.pack(">I", len(value)) + b"\0\0" + value
    n = len(frames)
    return b"ID3\x03\0\0" + bytes([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]) + frames


def fixtures(root):
    album = root / "PCM"
    album.mkdir()
    # ffmpeg's image encoder is unnecessary: a small valid BMP is converted below.
    bmp = b"BM" + struct.pack("<IHHI", 58, 0, 0, 54) + struct.pack("<IiiHHIIiiII", 40, 1, 1, 1, 24, 0, 4, 0, 0, 0, 0) + b"\0\0\xff\0"
    (album / "cover.bmp").write_bytes(bmp)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(album / "cover.bmp"), "-threads", "1", str(album / "cover.png")], check=True)
    for ext, codec in [("wav", "pcm_s24le"), ("flac", "flac"), ("mp3", "libmp3lame"), ("m4a", "aac")]:
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=0.2", "-ac", "2", "-c:a", codec,
                        "-metadata", "title=Reference", "-metadata", "artist=Test Artist", "-metadata", "album=Reference Album",
                        "-metadata", "composer=Test Composer", "-metadata", "genre=Classical", str(album / ("reference." + ext))], check=True)
    for ext in ("dsf", "dff"):
        folder = root / ext.upper()
        folder.mkdir()
        payload = bytes(range(256)) * 32
        tag = id3("DSD256 " + ext)
        if ext == "dsf":
            fmt = b"fmt " + struct.pack("<QIIIIIIQII", 52, 1, 0, 2, 2, 11289600, 1, len(payload) * 4, 4096, 0)
            metadata_offset = 28 + len(fmt) + 12 + len(payload)
            data = b"DSD " + struct.pack("<QQQ", 28, metadata_offset + len(tag), metadata_offset) + fmt + b"data" + struct.pack("<Q", len(payload) + 12) + payload + tag
        else:
            def chunk(name, data):
                return name + struct.pack(">Q", len(data)) + data + (b"\0" if len(data) % 2 else b"")
            props = b"SND " + chunk(b"FS  ", struct.pack(">I", 11289600)) + chunk(b"CHNL", struct.pack(">H", 2) + b"SLFTSRGT") + chunk(b"CMPR", b"DSD \x00")
            body = b"DSD " + chunk(b"FVER", b"\x01\x05\0\0") + chunk(b"PROP", props) + chunk(b"DSD ", payload) + chunk(b"ID3 ", tag)
            data = b"FRM8" + struct.pack(">Q", len(body)) + body
        (folder / ("reference." + ext)).write_bytes(data)


class EngineAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary = os.environ.get("CADENCE_ENGINE_BINARY", "src-tauri/target/debug/cadence-headless")
        cls.fixture_dir = tempfile.TemporaryDirectory(prefix="cadence-fixtures-")
        fixtures(Path(cls.fixture_dir.name))

    @classmethod
    def tearDownClass(cls):
        cls.fixture_dir.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cadence-phase1-")
        self.base = Path(self.temp.name)
        self.music = self.base / "music"
        shutil.copytree(self.fixture_dir.name, self.music)
        self.data = self.base / "state"
        self.data.mkdir()
        self.tmp = self.base / "tmp"
        self.tmp.mkdir()
        self.control, self.media = port(), port()
        self.token = "regression-" + os.urandom(32).hex()
        self.process = None
        self.start()

    def tearDown(self):
        self.stop()
        self.temp.cleanup()

    def start(self, writable=True):
        env = dict(os.environ, CADENCE_APP_DATA_DIR=str(self.data), CADENCE_MUSIC_DIR=str(self.music), CADENCE_TMP_DIR=str(self.tmp),
                   CADENCE_MUSIC_READ_ONLY=str(not writable).lower(), CADENCE_ADVERTISED_IP="127.0.0.1", CADENCE_ALLOW_LOOPBACK="true",
                   CADENCE_CONTROL_PORT=str(self.control), CADENCE_MEDIA_PORT=str(self.media), CADENCE_MIN_LOCKABLE_MB="1", CADENCE_HEADROOM_MB="1", CADENCE_PAIRING_TOKEN=self.token)
        self.log = open(self.base / "process.log", "ab")
        self.process = subprocess.Popen([self.binary, "--dragonfish"], env=env, stdout=self.log, stderr=self.log)
        for _ in range(200):
            if self.process.poll() is not None:
                self.fail((self.base / "process.log").read_text())
            try:
                status, _, body = self.http("GET", "/readyz", auth=False)
                if status == 200:
                    self.identity = json.loads(body)
                    return
            except OSError:
                pass
            time.sleep(.05)
        self.fail("headless process did not become ready")

    def stop(self):
        if self.process:
            self.process.terminate()
            self.process.wait(timeout=15)
            self.process = None
            self.log.close()

    def http(self, method, path, body=None, auth=True, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.control, timeout=20)
        hdr = {"Content-Type": "application/json"}
        if auth:
            hdr["x-cadence-token"] = self.token
        hdr.update(headers or {})
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=hdr)
        response = conn.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        conn.close()
        return result

    def op(self, operation, ok=True, **params):
        request = dict(protocolVersion=2, engineId=self.identity["engineId"], libraryId=self.identity["libraryId"], operation=operation, **params)
        status, _, body = self.http("POST", "/v1/core", request)
        self.assertEqual(status, 200, body)
        response = json.loads(body)
        self.assertEqual(response.get("ok"), ok, response)
        return response.get("data") if ok else response["error"]

    def scan(self):
        folder = self.op("folders.add", path=str(self.music), scanMode="manual")
        self.op("folders.scan", folderId=folder["id"], forceFull=True)
        for _ in range(400):
            status = self.op("folders.scan.status")
            if status["status"] in ("completed", "failed"):
                self.assertEqual(status["status"], "completed", status)
                break
            time.sleep(.025)
        else:
            self.fail("scan did not complete")
        return self.op("catalog.page", cursor=None, limit=200)["tracks"]

    def test_every_new_route_requires_header_auth_not_url_tokens(self):
        for path, method in [("/v1/core", "POST"), ("/v1/artwork/release", "GET"), ("/v1/artwork/release?token=" + self.token, "GET")]:
            status, _, _ = self.http(method, path, {"operation": "fs.browse"} if method == "POST" else None, auth=False)
            self.assertEqual(status, 401, path)

    def test_scan_metadata_artwork_playlists_and_restart(self):
        tracks = self.scan()
        self.assertEqual(len(tracks), 6)
        for track in tracks:
            if track["format"] in ("DSF", "DFF"):
                self.assertEqual(track["sampleRate"], 11289600)
                self.assertEqual(track["bitDepth"], 1)
                self.assertEqual(track["fingerprintStatus"], "UNSUPPORTED_DSD")
                self.assertTrue(track["title"].startswith("DSD256"))
            else:
                self.assertEqual(track["title"], "Reference")
                self.assertEqual(track["composerName"], "Test Composer")
        pcm = next(t for t in tracks if t["format"] == "FLAC")
        status, headers, art = self.http("GET", "/v1/artwork/" + pcm["releaseId"])
        self.assertEqual(status, 200)
        self.assertTrue(art.startswith(b"\xff\xd8"))
        self.assertEqual(self.http("GET", "/v1/artwork/" + pcm["releaseId"], headers={"If-None-Match": headers["ETag"]})[0], 304)
        playlist = self.op("playlists.create", title="Reference playlist")
        ids = [t["id"] for t in tracks]
        self.op("playlists.setTracks", playlistId=playlist["id"], trackIds=ids)
        self.stop()
        self.start()
        self.assertEqual(self.op("playlists.get", playlistId=playlist["id"])["trackIds"], ids)
        self.assertEqual(len(self.op("catalog.page", cursor=None, limit=200)["tracks"]), 6)

    def test_traversal_symlink_and_playlist_rollback(self):
        outside = self.base / "outside"
        outside.mkdir()
        (self.music / "escape").symlink_to(outside, target_is_directory=True)
        for path in [str(self.music / ".." / "outside"), str(self.music / "escape"), str(outside)]:
            self.op("fs.browse", ok=False, path=path)
            self.op("folders.add", ok=False, path=path, scanMode="manual")
        tracks = self.scan()
        playlist = self.op("playlists.create", title="Atomic")
        self.op("playlists.setTracks", playlistId=playlist["id"], trackIds=[tracks[0]["id"]])
        self.op("playlists.setTracks", ok=False, playlistId=playlist["id"], trackIds=[tracks[1]["id"], "missing"])
        self.assertEqual(self.op("playlists.get", playlistId=playlist["id"])["trackIds"], [tracks[0]["id"]])

    def test_real_curate_pcm_and_safe_dsd_rejection(self):
        tracks = self.scan()
        for track in tracks:
            draft_id = "draft-" + track["id"]
            self.op("curate.draft.save", draft=dict(draftId=draft_id, trackId=track["id"], expectedRevision=0, updatedBy="regression",
                    changes=[dict(field="title", before=track["title"], after="Verified title")]))
            report = self.op("curate.dry_run", draftId=draft_id)
            if track["format"] in ("DSF", "DFF"):
                self.assertFalse(report["applyAvailable"])
                self.op("curate.approve", ok=False, draftId=draft_id, approvalHash=report["approvalHash"], commandId="cmd-" + track["id"])
                continue
            self.assertTrue(report["applyAvailable"], report)
            receipt = self.op("curate.approve", draftId=draft_id, approvalHash=report["approvalHash"], commandId="cmd-" + track["id"])
            for _ in range(100):
                job = self.op("curate.job.status", jobId=receipt["jobId"])
                if job["status"] in ("verified", "failed"):
                    break
                time.sleep(.05)
            self.assertEqual(job["status"], "verified", job)
            path = self.music / "PCM" / ("reference." + track["format"].lower())
            metadata = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_format", "-of", "json", str(path)]))
            tags = {k.lower(): v for k, v in metadata["format"]["tags"].items()}
            self.assertEqual(tags["title"], "Verified title")


if __name__ == "__main__":
    unittest.main()
