#!/usr/bin/env python3
"""Read-only Cadence database export and shared implementation for the PS metadata launcher.

Database: python tools/Export-CadenceDatabase.py --db PATH --output before-db.json --offline-confirmed
Filesystem: use Export-CadenceMetadata.ps1 (or add --filesystem here).
Exit 0: complete export; 2: usage/runtime/incomplete inspection. Requires Python 3.10+.
Filesystem inspection additionally requires: python -m pip install mutagen Pillow
No dependencies are downloaded automatically. Never runs Cadence's own scanner.
"""
import argparse
from contextlib import closing
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
from datetime import datetime, timezone

AUDIO = {'.flac', '.wav', '.mp3', '.m4a', '.alac', '.aac', '.aif', '.aiff', '.ogg', '.opus', '.dsf', '.dff', '.dsdiff'}
IMAGES = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif', '.tif', '.tiff'}
TABLES = ('watched_folders', 'storage_mounts', 'tracks', 'releases', 'artwork_cache_state', 'engine_artwork', 'skipped_files', 'engine_library_state')
MAX_IMAGE = 32 * 1024 * 1024


def key(path):
    return os.path.normcase(os.path.abspath(os.path.normpath(str(path))))


def within(path, root):
    try:
        return os.path.commonpath([key(path), key(root)]) == key(root)
    except ValueError:
        return False


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(roots):
    return digest(json.dumps(sorted(key(p) for p in roots), ensure_ascii=False).encode())


def registered_roots(rows):
    paths = [r['folder_path'] for r in rows]
    if any(not isinstance(p, str) or not p.strip() or not os.path.isabs(p) for p in paths):
        raise ValueError('Registered folders must be nonempty absolute paths valid on this host')
    return sorted({key(p) for p in paths})


def offline_guard():
    """Fail closed on local process enumeration failure; remote hosts require attestation."""
    names = set()
    if os.name == 'nt':
        class Entry(ctypes.Structure):
            _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                        ('th32ProcessID', wintypes.DWORD), ('th32DefaultHeapID', ctypes.c_size_t),
                        ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                        ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', wintypes.LONG),
                        ('dwFlags', wintypes.DWORD), ('szExeFile', wintypes.WCHAR * 260)]
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
        kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateToolhelp32Snapshot(2, 0)
        if handle == ctypes.c_void_p(-1).value:
            raise RuntimeError('Cannot enumerate processes; refusing live inspection')
        try:
            entry = Entry()
            entry.dwSize = ctypes.sizeof(entry)
            if not kernel.Process32FirstW(handle, ctypes.byref(entry)):
                raise RuntimeError('Cannot enumerate processes')
            while True:
                names.add(entry.szExeFile.lower().removesuffix('.exe'))
                if not kernel.Process32NextW(handle, ctypes.byref(entry)):
                    break
        finally:
            kernel.CloseHandle(handle)
    elif Path('/proc').is_dir():
        for p in Path('/proc').iterdir():
            if p.name.isdigit():
                try:
                    names.add((p / 'comm').read_text().strip().lower())
                except FileNotFoundError:
                    pass
    else:
        raise RuntimeError('Automatic offline checking supports Windows and Linux only')
    running = sorted(n for n in names if n in {'cadence', 'cadence-core', 'cadence-engine', 'cadence-headless', 'cadence core'})
    if running:
        raise RuntimeError('Close Cadence and all engines, wait 30 seconds, then retry: ' + ', '.join(running))


def connect(db):
    path = Path(db).absolute()
    if not path.is_file():
        raise FileNotFoundError(f'Database not found: {path}')
    conn = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA query_only=ON')
    conn.execute('BEGIN')  # one consistent SQLite read transaction, including WAL
    return conn


def encode(value):
    if isinstance(value, bytes):
        return {'bytes': len(value), 'sha256': digest(value)}
    return value


def database_snapshot(db, guard=offline_guard):
    guard()
    tables, schema = {}, {}
    with closing(connect(db)) as conn:
        available = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        missing = {'watched_folders', 'tracks', 'releases'} - available
        if missing:
            raise ValueError('Required catalogue tables missing: ' + ', '.join(sorted(missing)))
        for table in TABLES:
            guard()
            if table not in available:
                continue
            schema[table] = [dict(r) for r in conn.execute(f'PRAGMA table_info("{table}")')]
            records = [{k: encode(r[k]) for k in r.keys()} for r in conn.execute(f'SELECT * FROM "{table}"')]
            tables[table] = sorted(records, key=lambda r: json.dumps(r, sort_keys=True, ensure_ascii=False))
        integrity = [r[0] for r in conn.execute('PRAGMA quick_check')]
        foreign_keys = [list(r) for r in conn.execute('PRAGMA foreign_key_check')]
    roots = registered_roots(tables['watched_folders'])
    return {'schemaVersion': 1, 'kind': 'database', 'databasePath': key(db),
            'generatedAtUtc': datetime.now(timezone.utc).isoformat(),
            'scopePolicy': 'all registered watched_folders, including disabled',
            'roots': roots, 'scopeFingerprint': fingerprint(roots),
            'schema': schema, 'tables': tables, 'missingTables': sorted(set(TABLES) - set(tables)),
            'integrity': integrity, 'foreignKeyViolations': foreign_keys,
            'complete': integrity == ['ok'] and not foreign_keys,
            'counts': {name: len(rows) for name, rows in tables.items()}}


def image_info(data):
    from PIL import Image
    import io
    result = {'bytes': len(data), 'sha256': digest(data)}
    if len(data) > MAX_IMAGE:
        return {**result, 'valid': None, 'error': 'image exceeds 32 MiB inspection limit'}
    try:
        with Image.open(io.BytesIO(data)) as image:
            result.update(width=image.width, height=image.height, format=image.format)
            if image.width * image.height > 16_000_000:
                return {**result, 'valid': None, 'error': 'image exceeds 16 megapixel decode limit'}
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
        result['valid'] = True
    except Exception as exc:
        result.update(valid=False, error=str(exc))
    return result


def inspect_audio(path):
    import mutagen
    from mutagen.id3 import ID3
    media = mutagen.File(path)
    if media is None:
        raise ValueError('Unrecognized audio container')
    tags = media.tags
    raw = {}
    pictures = []
    if tags:
        for name, value in tags.items():
            if str(name).startswith(('APIC', 'covr', 'metadata_block_picture')):
                continue
            raw[str(name)] = [str(x) for x in value] if isinstance(value, (list, tuple)) else str(value)
        if isinstance(tags, ID3):
            pictures.extend((p.data, int(p.type), p.mime) for p in tags.getall('APIC'))
        if 'covr' in tags:
            pictures.extend((bytes(p), 3, 'mp4-cover') for p in tags['covr'])
        if 'metadata_block_picture' in tags:
            import base64
            from mutagen.flac import Picture
            for encoded in tags['metadata_block_picture']:
                p = Picture(base64.b64decode(encoded))
                pictures.append((p.data, int(p.type), p.mime))
    pictures.extend((p.data, int(p.type), p.mime) for p in getattr(media, 'pictures', []))
    canonical = {}
    aliases = {'title': ('title', 'TIT2', '\xa9nam'), 'artist': ('artist', 'TPE1', '\xa9ART'),
               'album': ('album', 'TALB', '\xa9alb'), 'album_artist': ('albumartist', 'album artist', 'TPE2', 'aART'),
               'composer': ('composer', 'TCOM', '\xa9wrt'), 'year': ('date', 'year', 'TDRC', '\xa9day'),
               'track_number': ('tracknumber', 'TRCK', 'trkn'), 'disc_number': ('discnumber', 'TPOS', 'disk'),
               'genre': ('genre', 'TCON', '\xa9gen')}
    lower = {str(k).casefold(): v for k, v in (tags or {}).items()}
    for field, candidates in aliases.items():
        for candidate in candidates:
            value = lower.get(candidate.casefold())
            if value is not None:
                if hasattr(value, 'text'):
                    value = value.text
                if isinstance(value, (tuple, list)):
                    value = value[0] if value else ''
                if isinstance(value, tuple):
                    value = value[0]
                canonical[field] = str(value)
                break
    info = media.info
    technical = {name: getattr(info, attr, None) for name, attr in
                 [('duration_secs', 'length'), ('sample_rate', 'sample_rate'), ('bit_depth', 'bits_per_sample'), ('channels', 'channels')]}
    # Mutagen's DSF/DSDIFF readers use native headers. Do not derive DSD bit depth from a packed codec clock.
    if path.suffix.lower() in {'.dsf', '.dff', '.dsdiff'}:
        technical['bit_depth'] = 1
    return {'tags': raw, 'metadata': canonical, 'technical': technical,
            'embeddedPictures': [{'index': i, 'type': kind, 'mime': mime, **image_info(data)}
                                 for i, (data, kind, mime) in enumerate(pictures)],
            'parser': f'mutagen {mutagen.version_string}'}


def filesystem_snapshot(db, guard=offline_guard):
    # Dependencies must be available before starting a potentially long scan.
    import mutagen
    import PIL
    guard()
    with closing(connect(db)) as conn:
        roots = registered_roots(conn.execute('SELECT folder_path FROM watched_folders'))
    snapshot = {'schemaVersion': 1, 'databasePath': key(db),
                'generatedAtUtc': datetime.now(timezone.utc).isoformat(),
                'scopePolicy': 'all registered watched_folders, including disabled',
                'roots': roots, 'scopeFingerprint': fingerprint(roots)}
    if not roots:
        raise ValueError('No registered catalogue folders; refusing an unscoped scan')
    report = {k: snapshot[k] for k in ('schemaVersion', 'databasePath', 'generatedAtUtc', 'scopePolicy', 'roots', 'scopeFingerprint')}
    report.update(kind='filesystem', tracks=[], images=[], sidecars=[], directories=[], errors=[], exclusions=[], complete=True,
                  parserVersions={'mutagen': mutagen.version_string, 'Pillow': PIL.__version__})
    visited = set()

    def error(path, exc, traversal=False):
        report['errors'].append({'path': key(path), 'error': str(exc), 'traversal': traversal})
        if traversal:
            report['complete'] = False

    def walk(path):
        guard()
        identity = key(path)
        if identity in visited:
            return
        visited.add(identity)
        try:
            if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
                report['exclusions'].append({'path': identity, 'reason': 'symlink/junction not followed'})
                report['complete'] = False
                return
            if not any(within(path.resolve(), root) for root in roots):
                error(path, 'resolved path outside registered roots', True)
                return
            if path.is_dir():
                report['directories'].append(identity)
                for child in sorted(path.iterdir(), key=lambda p: p.name):
                    walk(child)
                return
            if not path.is_file():
                error(path, 'not an accessible regular file', True)
                return
            stat = path.stat()
            common = {'path': identity, 'file_size': stat.st_size, 'mtime': int(stat.st_mtime), 'mtimeNs': stat.st_mtime_ns}
            ext = path.suffix.lower()
            if ext in AUDIO:
                record = {**common, 'status': 'ok'}
                try:
                    record.update(inspect_audio(path))
                    if path.stat().st_mtime_ns != stat.st_mtime_ns:
                        raise ValueError('file changed during inspection')
                except Exception as exc:
                    record.update(status='error', error=str(exc))
                    error(path, exc)
                report['tracks'].append(record)
                if len(report['tracks']) % 100 == 0:
                    print(f"Inspected {len(report['tracks'])} tracks; {len(report['errors'])} errors", file=sys.stderr)
            elif ext in IMAGES:
                if stat.st_size > MAX_IMAGE:
                    report['images'].append({**common, 'valid': None, 'error': 'image exceeds 32 MiB inspection limit'})
                else:
                    report['images'].append({**common, **image_info(path.read_bytes())})
            elif path.name.endswith('.sidecar.json'):
                if stat.st_size > 2 * 1024 * 1024:
                    raise ValueError('sidecar exceeds 2 MiB inspection limit')
                try:
                    data = path.read_bytes()
                    report['sidecars'].append({**common, 'sha256': digest(data), 'data': json.loads(data.decode('utf-8-sig'))})
                except Exception as exc:
                    report['sidecars'].append({**common, 'error': str(exc)})
                    error(path, exc)
        except OSError as exc:
            error(path, exc, True)
        except ValueError as exc:
            error(path, exc)

    for root in roots:
        walk(Path(root))
    for field in ('tracks', 'images', 'sidecars'):
        report[field].sort(key=lambda r: r['path'])
    report['counts'] = {k: len(report[k]) for k in ('tracks', 'images', 'sidecars', 'directories', 'errors', 'exclusions')}
    return report


def write_report(report, output, roots=(), protected=()):
    path = Path(output).absolute()
    if any(within(path, r) or within(path.resolve(), r) for r in roots):
        raise ValueError('Report output must be outside registered music folders')
    if key(path) in {key(p) for p in protected}:
        raise ValueError('Report output would overwrite an input')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as out:
        json.dump(report, out, ensure_ascii=False, sort_keys=True, indent=2)
        out.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--db', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--filesystem', action='store_true', help='Used by the PowerShell metadata launcher')
    parser.add_argument('--offline-confirmed', action='store_true', help='Confirm ALL local/remote Cadence engines are stopped and 30-second cooldown elapsed')
    args = parser.parse_args()
    if not args.offline_confirmed:
        parser.error('--offline-confirmed is required: stop ALL engines and wait at least 30 seconds first')
    try:
        offline_guard()
        report = filesystem_snapshot(args.db, offline_guard) if args.filesystem else database_snapshot(args.db, offline_guard)
        write_report(report, args.output, report['roots'], [args.db])
        print(json.dumps({'output': str(args.output.absolute()), 'complete': report['complete'], 'counts': report['counts']}))
        return 0 if report['complete'] and not report.get('errors') else 2
    except (OSError, ValueError, RuntimeError, sqlite3.Error, ImportError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
