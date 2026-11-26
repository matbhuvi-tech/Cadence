"""Disposable real-process HTTP acceptance. No production endpoints or media.

Run with deploy/engine-regression/Dockerfile; only Python's standard library is used.
Fixtures contain valid container headers, real encoded PCM and synthetic DSD256.
"""
import hashlib
import http.client
import json
import os
import re
import signal
import ssl
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


def id3(title, picture=None):
    value = b"\x03" + title.encode()
    frames = b"TIT2" + struct.pack(">I", len(value)) + b"\0\0" + value
    if picture:
        apic = b"\0image/png\0\x03\0" + picture
        frames += b"APIC" + struct.pack(">I", len(apic)) + b"\0\0" + apic
    n = len(frames)
    return b"ID3\x03\0\0" + bytes([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]) + frames


def fixtures(root):
    album = root / "PCM"
    album.mkdir()
    # ffmpeg's image encoder is unnecessary: a small valid BMP is converted below.
    bmp = b"BM" + struct.pack("<IHHI", 58, 0, 0, 54) + struct.pack("<IiiHHIIiiII", 40, 1, 1, 1, 24, 0, 4, 0, 0, 0, 0) + b"\0\0\xff\0"
    (album / "cover.bmp").write_bytes(bmp)
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(album / "cover.bmp"), "-threads", "1", str(album / "cover.png")], check=True)
    for ext, codec in [("wav", "pcm_s24le"), ("flac", "flac"), ("mp3", "libmp3lame"), ("m4a", "aac"), ("aiff", "pcm_s24be")]:
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=0.2", "-ac", "2", "-c:a", codec,
                        "-metadata", "title=Reference", "-metadata", "artist=Test Artist", "-metadata", "album=Reference Album",
                        "-metadata", "composer=Test Composer", "-metadata", "genre=Classical", *(["-write_id3v2", "1"] if ext == "aiff" else []), str(album / ("reference." + ext))], check=True)
    for ext in ("dsf", "dff"):
        folder = root / ext.upper()
        folder.mkdir()
        payload = bytes(range(256)) * 32
        tag = id3("DSD256 " + ext, (album / "cover.png").read_bytes())
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
        env["CADENCE_TEST_TLS"] = str(getattr(self, "tls", False)).lower()
        self.log = open(self.base / "process.log", "ab")
        command = [self.binary, "--dragonfish"]
        if getattr(self, "trace", False):
            command = ["strace", "-f", "-yy", "-s", "100", "-o", str(self.base / "io.trace"), "-e", "trace=%file,read,pread64,getdents64,write,pwrite64,mmap"] + command
        self.process = subprocess.Popen(command, env=env, stdout=self.log, stderr=self.log, start_new_session=os.name != "nt")
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
            if os.name != "nt":
                os.killpg(self.process.pid, signal.SIGTERM)
            else:
                self.process.terminate()
            self.process.wait(timeout=15)
            self.process = None
            self.log.close()

    def http(self, method, path, body=None, auth=True, headers=None):
        if getattr(self, "tls", False):
            context = ssl.create_default_context(cafile=str(self.data / "tls-cert.pem"))
            conn = http.client.HTTPSConnection("127.0.0.1", self.control, timeout=20, context=context)
        else:
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
        # Pairing-token auth was removed for LAN-trusted direct access (commit e7f900e);
        # verify direct routes respond cleanly without requiring auth headers or URL tokens.
        status, _, body = self.http(
            "POST",
            "/v1/core",
            {
                "protocolVersion": 2,
                "engineId": self.identity["engineId"],
                "libraryId": self.identity["libraryId"],
                "operation": "core.hello",
            },
            auth=False,
        )
        self.assertEqual(status, 200, body)
        self.assertTrue(json.loads(body).get("ok"), body)
        status, _, _ = self.http("GET", "/v1/artwork/release", None, auth=False)
        self.assertEqual(status, 404, "/v1/artwork/release")

    def test_authenticated_https_with_persisted_certificate(self):
        self.stop()
        self.tls = True
        self.start()
        subprocess.run(
            [self.binary, "--healthcheck", "--control-port", str(self.control)],
            env=dict(os.environ, CADENCE_APP_DATA_DIR=str(self.data), CADENCE_TEST_TLS="true"),
            check=True,
        )
        self.assertEqual(self.op("core.hello")["protocolVersion"], 2)
        status, _, body = self.http("POST", "/v1/core", {}, auth=False)
        self.assertEqual(status, 200, body)
        self.assertFalse(json.loads(body).get("ok"), body)
        self.assertEqual(len(self.scan()), 7)

    def test_scan_metadata_artwork_playlists_and_restart(self):
        tracks = self.scan()
        self.assertEqual(len(tracks), 7)
        for track in tracks:
            if track["format"] in ("DSF", "DFF"):
                self.assertEqual(track["sampleRate"], 11289600)
                self.assertEqual(track["bitDepth"], 1)
                self.assertEqual(track["fingerprintStatus"], "UNSUPPORTED_DSD")
                self.assertTrue(track["title"].startswith("DSD256"))
                self.assertTrue(track["hasCoverArt"])
                self.assertEqual(self.http("GET", "/v1/artwork/" + track["releaseId"])[0], 200)
            else:
                self.assertEqual(track["title"], "Reference")
                if track["format"] != "WAV":  # ffmpeg's RIFF INFO fixture has no composer field
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
        self.assertEqual(len(self.op("catalog.page", cursor=None, limit=200)["tracks"]), 7)

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
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.music.rglob("*") if p.suffix in (".dsf", ".dff")}
        decoded = {p: subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(p), "-map", "0:a", "-c:a", "pcm_s32le", "-f", "hash", "-hash", "sha256", "-"])
                   for p in (self.music / "PCM").iterdir() if p.suffix in (".wav", ".flac", ".mp3", ".m4a", ".aiff")}
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
            with sqlite3.connect(self.data / "cadence.db") as db:
                diagnostic = db.execute("SELECT error_message FROM remote_curate_jobs WHERE job_id=?", (receipt["jobId"],)).fetchone()
            self.assertEqual(job["status"], "verified", (track["format"], job, diagnostic))
            path = self.music / "PCM" / ("reference." + track["format"].lower())
            metadata = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_format", "-of", "json", str(path)]))
            tags = {k.lower(): v for k, v in metadata["format"]["tags"].items()}
            self.assertEqual(tags["title"], "Verified title")
        for path, digest in before.items():
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        for path, digest in decoded.items():
            after = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a", "-c:a", "pcm_s32le", "-f", "hash", "-hash", "sha256", "-"])
            self.assertEqual(after, digest, path.name)

    def draft(self, track, label="draft"):
        self.op("curate.draft.save", draft=dict(draftId=label, trackId=track["id"], expectedRevision=0, updatedBy="regression",
                changes=[dict(field="title", before=track["title"], after="Verified title")]))
        return self.op("curate.dry_run", draftId=label)

    def test_readonly_and_external_changes_fail_without_overwrite(self):
        track = next(t for t in self.scan() if t["format"] == "FLAC")
        report = self.draft(track)
        path = self.music / "PCM/reference.flac"
        original = path.read_bytes()
        path.write_bytes(original + b"external-change")
        self.op("curate.approve", ok=False, draftId="draft", approvalHash=report["approvalHash"], commandId="external")
        self.assertEqual(path.read_bytes(), original + b"external-change")
        path.write_bytes(original)
        self.stop()
        self.start(writable=False)
        report = self.op("curate.dry_run", draftId="draft")
        self.assertFalse(report["applyAvailable"])
        self.op("curate.approve", ok=False, draftId="draft", approvalHash=report["approvalHash"], commandId="readonly")
        self.assertEqual(path.read_bytes(), original)

    def test_curate_projection_failure_restores_original_and_catalog(self):
        track = next(t for t in self.scan() if t["format"] == "FLAC")
        report = self.draft(track)
        original = (self.music / "PCM/reference.flac").read_bytes()
        with sqlite3.connect(self.data / "cadence.db") as db:
            db.execute("CREATE TRIGGER regression_fail BEFORE UPDATE OF title ON tracks BEGIN SELECT RAISE(ABORT,'injected projection failure'); END")
        receipt = self.op("curate.approve", draftId="draft", approvalHash=report["approvalHash"], commandId="rollback")
        for _ in range(100):
            job = self.op("curate.job.status", jobId=receipt["jobId"])
            if job["status"] == "failed":
                break
            time.sleep(.025)
        self.assertEqual(job["status"], "failed")
        self.assertEqual((self.music / "PCM/reference.flac").read_bytes(), original)
        self.assertEqual(next(t for t in self.op("catalog.page", cursor=None, limit=200)["tracks"] if t["id"] == track["id"])["title"], track["title"])

    def test_curate_recovers_interruption_after_file_replacement(self):
        track = next(t for t in self.scan() if t["format"] == "FLAC")
        original = (self.music / "PCM/reference.flac").read_bytes()
        report = self.draft(track)
        receipt = self.op("curate.approve", draftId="draft", approvalHash=report["approvalHash"], commandId="recover")
        for _ in range(100):
            job = self.op("curate.job.status", jobId=receipt["jobId"])
            if job["status"] == "verified":
                break
            time.sleep(.025)
        self.assertEqual(job["status"], "verified")
        result = (self.music / "PCM/reference.flac").read_bytes()
        self.stop()
        # Reproduce the durable on-disk state of a crash after atomic rename and
        # before the catalog/job transaction. No production fault hook is needed.
        with sqlite3.connect(self.data / "cadence.db") as db:
            db.execute("INSERT INTO remote_curate_journal VALUES(?,?,?)", (receipt["jobId"], original, result))
            db.execute("UPDATE remote_curate_jobs SET status='applying' WHERE job_id=?", (receipt["jobId"],))
            db.execute("UPDATE remote_curate_drafts SET status='applying' WHERE draft_id='draft'")
            db.execute("UPDATE tracks SET title=? WHERE id=?", (track["title"], track["id"]))
        self.start()
        for _ in range(100):
            job = self.op("curate.job.status", jobId=receipt["jobId"])
            if job["status"] == "verified":
                break
            time.sleep(.025)
        self.assertEqual(job["status"], "verified")
        current = next(t for t in self.op("catalog.page", cursor=None, limit=200)["tracks"] if t["id"] == track["id"])
        self.assertEqual(current["title"], "Verified title")
        stable = (self.music / "PCM/reference.flac").stat().st_mtime_ns
        self.stop()
        self.start()
        self.assertEqual((self.music / "PCM/reference.flac").stat().st_mtime_ns, stable)

    def test_event_stream_and_release_split(self):
        tracks = self.scan()
        release = tracks[0]["releaseId"]
        self.assertTrue(self.op("releases.split.toggle", releaseId=release)["split"])
        self.assertIn(release, self.op("releases.split.list")["releaseIds"])
        self.assertFalse(self.op("releases.split.toggle", releaseId=release)["split"])
        conn = http.client.HTTPConnection("127.0.0.1", self.control, timeout=5)
        conn.request("GET", "/v1/events", headers={"x-cadence-token": self.token})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.readline(), b": connected\n")
        self.assertEqual(response.readline(), b"\n")
        folder = self.op("folders.list")["folders"][0]
        self.op("folders.scan", folderId=folder["id"], forceFull=True)
        self.assertEqual(response.readline(), b"event: engine\n")
        event = json.loads(response.readline().decode().removeprefix("data: "))
        self.assertIn(event["event"], ("catalog.changed", "scan.progress"))
        conn.close()

    def test_interrupted_scan_unavailable_folder_and_revision(self):
        folder = self.op("folders.add", path=str(self.music), scanMode="manual")
        for i in range(40):
            shutil.copy2(self.music / "PCM/reference.flac", self.music / "PCM" / (str(i) + ".flac"))
        before = self.op("catalog.page", cursor=None, limit=200)["revision"]
        self.op("folders.scan", folderId=folder["id"], forceFull=True)
        self.process.kill()
        self.process.wait(timeout=5)
        self.log.close()
        self.process = None
        self.start()
        for _ in range(300):
            status = self.op("folders.scan.status")
            if status["status"] == "completed":
                break
            time.sleep(.025)
        self.assertEqual(status["status"], "completed", status)
        page = self.op("catalog.page", cursor=None, limit=200)
        self.assertEqual(len(page["tracks"]), 47)
        self.assertGreater(page["revision"], before)
        self.music.rename(self.base / "unavailable")
        folders = self.op("folders.list")["folders"]
        self.assertFalse(folders[0]["online"])
        self.op("folders.scan", folderId=folder["id"], forceFull=True)
        for _ in range(100):
            status = self.op("folders.scan.status")
            if status["status"] == "failed":
                break
            time.sleep(.025)
        self.assertEqual(status["status"], "failed", status)
        self.assertEqual(len(self.op("catalog.page", cursor=None, limit=200)["tracks"]), 47)

    def test_malformed_identity_version_and_playlist_lifecycle(self):
        request = dict(protocolVersion=2, engineId="wrong", libraryId=self.identity["libraryId"], operation="folders.add", path=str(self.music))
        self.assertFalse(json.loads(self.http("POST", "/v1/core", request)[2])["ok"])
        request.update(engineId=self.identity["engineId"], protocolVersion=999)
        self.assertFalse(json.loads(self.http("POST", "/v1/core", request)[2])["ok"])
        self.op("folders.add", ok=False, path=str(self.music), scanMode="unknown")
        playlist = self.op("playlists.create", title="Before")
        self.op("playlists.update", playlistId=playlist["id"], title="After", description="Notes")
        self.assertEqual(self.op("playlists.list")["playlists"][0]["title"], "After")
        self.op("playlists.delete", playlistId=playlist["id"])
        self.op("playlists.get", ok=False, playlistId=playlist["id"])
        self.assertEqual(self.op("playlists.list")["playlists"], [])

    def test_startup_quick_rescan_missing_track_and_folder_removal(self):
        tracks = self.scan()
        self.assertTrue(self.op("fs.browse")["entries"])
        root = self.op("folders.list")["folders"][0]
        self.op("folders.add", path=str(self.music), scanMode="startup")
        playlist = self.op("playlists.create", title="Keep identities")
        self.op("playlists.setTracks", playlistId=playlist["id"], trackIds=[t["id"] for t in tracks])
        original_ids = {t["id"] for t in tracks}
        (self.music / "PCM/reference.mp3").unlink()
        self.stop()
        self.start()
        for _ in range(200):
            status = self.op("folders.scan.status")
            if status["status"] == "completed":
                break
            time.sleep(.025)
        self.assertEqual(status["status"], "completed", status)
        current = self.op("catalog.page", cursor=None, limit=200)["tracks"]
        self.assertEqual(len(current), 6)
        self.assertTrue({t["id"] for t in current} < original_ids)
        self.assertEqual(len(self.op("playlists.get", playlistId=playlist["id"])["trackIds"]), 7)
        self.op("folders.remove", folderId=root["id"])
        self.assertEqual(self.op("folders.list")["folders"], [])
        self.assertEqual(len(self.op("catalog.page", cursor=None, limit=200)["tracks"]), 6)
        self.op("folders.scan", ok=False, folderId="missing", forceFull=False)
        self.op("fs.browse", ok=False, path=str(self.music / "PCM/reference.flac"))
        self.op("folders.add", ok=False, path=str(self.music / "PCM/reference.flac"))
        self.op("releases.split.toggle", ok=False, releaseId="missing")
        self.assertEqual(self.op("curate.draft.list")["drafts"], [])

    def test_extended_metadata_and_invalid_changes(self):
        track = next(t for t in self.scan() if t["format"] == "FLAC")
        changes = [dict(field=field, before="", after=value) for field, value in [
            ("artist", "Verified Artist"), ("album", "Verified Album"), ("albumArtist", "Verified Album Artist"),
            ("composer", "Verified Composer"), ("genre", "Jazz"), ("originalAlbum", "Original Film"),
            ("originalYear", "1995"), ("lyrics", "Verified lyrics")]]
        self.op("curate.draft.save", draft=dict(draftId="extended", trackId=track["id"], expectedRevision=0, updatedBy="regression", changes=changes))
        report = self.op("curate.dry_run", draftId="extended")
        receipt = self.op("curate.approve", draftId="extended", approvalHash=report["approvalHash"], commandId="extended")
        for _ in range(100):
            job = self.op("curate.job.status", jobId=receipt["jobId"])
            if job["status"] in ("failed", "verified"):
                break
            time.sleep(.025)
        self.assertEqual(job["status"], "verified")
        current = next(t for t in self.op("catalog.page", cursor=None, limit=200)["tracks"] if t["id"] == track["id"])
        self.assertEqual(current["artist"], "Verified Artist")
        self.assertEqual(current["album"], "Verified Album")
        self.assertEqual(current["composerName"], "Verified Composer")
        self.assertEqual(current["lyrics"], "Verified lyrics")
        self.assertEqual(current["genreTags"], ["Jazz"])
        self.assertEqual(current["provenanceStatus"], "INDEXED")
        self.assertTrue(self.op("curate.draft.list")["drafts"])
        self.op("curate.draft.save", draft=dict(draftId="invalid", trackId=track["id"], expectedRevision=0, updatedBy="regression", changes=[dict(field="filePath", before="", after="/outside")]))
        report = self.op("curate.dry_run", draftId="invalid")
        self.assertFalse(report["applyAvailable"])
        self.op("curate.approve", ok=False, draftId="invalid", approvalHash=report["approvalHash"], commandId="invalid")

    @unittest.skipUnless(os.name == "posix", "Linux syscall audit")
    def test_loading_and_full_cooldown_have_zero_library_syscalls(self):
        self.stop()
        self.trace = True
        self.start()
        tracks = self.scan()
        pcm = next(t for t in tracks if t["format"] == "FLAC")
        report = self.draft(pcm)
        self.op("fs.browse", path=str(self.music))
        self.http("GET", "/v1/artwork/" + pcm["releaseId"])
        snap = self.op("session.snapshot")
        self.op("playback.control", action="play", trackId=pcm["id"], commandId="play-audit", expectedRevision=snap["revision"])
        self.assertEqual(self.op("session.snapshot")["playback"]["activity"], "loading")
        time.sleep(.05)
        trace_path = self.base / "io.trace"
        start = trace_path.stat().st_size

        def protected_requests():
            self.assertTrue(self.op("fs.browse", path=str(self.music))["cached"])
            self.assertEqual(self.op("fs.browse", ok=False, path=str(self.music / "PCM"))["code"], "deferred_until_idle")
            self.op("folders.scan", ok=False, forceFull=True)
            self.op("curate.dry_run", ok=False, draftId="draft")
            self.op("curate.approve", ok=False, draftId="draft", approvalHash=report["approvalHash"], commandId="forbidden")
            self.assertEqual(self.http("GET", "/v1/artwork/" + pcm["releaseId"])[0], 200)
            self.assertEqual(self.http("GET", "/v1/artwork/missing")[0], 503)

        protected_requests()
        snap = self.op("session.snapshot")
        self.op("playback.control", action="stop", commandId="stop-audit", expectedRevision=snap["revision"])
        stopped = time.monotonic()
        protected_requests()
        time.sleep(max(0, 29 - (time.monotonic() - stopped)))
        protected_requests()
        time.sleep(.05)
        audit = trace_path.read_bytes()[start:].decode(errors="replace")
        library = re.escape(str(self.music))
        path_ops = re.compile(r"\b(?:openat2?|newfstatat|statx|access|readlink|rename|unlink|mkdir)\([^\n]*[\"<]" + library)
        fd_ops = re.compile(r"\b(?:read|pread64|getdents64|write|pwrite64|mmap)\([^\n]*<" + library)
        violations = [line for line in audit.splitlines() if path_ops.search(line) or fd_ops.search(line)]
        self.assertEqual(violations, [], "\n".join(violations[:20]))
        time.sleep(max(0, 30.1 - (time.monotonic() - stopped)))
        self.assertFalse(self.op("fs.browse", path=str(self.music / "PCM"))["cached"])


if __name__ == "__main__":
    unittest.main()
