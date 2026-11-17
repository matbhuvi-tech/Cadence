#!/usr/bin/env python3
"""Compare saved filesystem and DB snapshots, without opening the music library or DB.

python tools/Compare-CadenceCatalogue.py --files before-files.json --database before-db.json --output before-consistency.json
Repeat for after snapshots; optionally pass --baseline before-consistency.json to report added/resolved findings.
Exit 0: no findings; 1: differences/inspection warnings; 2: invalid input/runtime failure.
"""
import argparse
from collections import Counter
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location('cadence_diagnostics', Path(__file__).with_name('Export-CadenceDatabase.py'))
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
key, within = shared.key, shared.within


def normalized(value):
    if isinstance(value, list):
        value = '; '.join(str(x) for x in value)
    return ' '.join(str(value or '').split())


def compare(files, database):
    for report, kind in ((files, 'filesystem'), (database, 'database')):
        if report.get('schemaVersion') != 1 or report.get('kind') != kind:
            raise ValueError(f'Expected schemaVersion 1 {kind} snapshot')
    if files['scopeFingerprint'] != database['scopeFingerprint'] or files['databasePath'] != database['databasePath']:
        raise ValueError('Snapshots have different database paths or registered folder scopes; export a matching pair')
    roots = files['roots']
    findings = []

    def add(code, path='', **details):
        findings.append({'code': code, 'path': path, **details})

    if not files['complete'] or not database['complete']:
        add('incomplete_snapshot', detail='Missing-file conclusions are suppressed where traversal is incomplete')
    for error in files['errors']:
        add('filesystem_inspection_error', error['path'], detail=error['error'])
    for exclusion in files.get('exclusions', []):
        add('filesystem_exclusion', exclusion['path'], detail=exclusion['reason'])
    if database['integrity'] != ['ok']:
        add('database_integrity_failure', detail=database['integrity'])
    for violation in database['foreignKeyViolations']:
        add('database_foreign_key_violation', detail=violation)
    tables = database['tables']
    disk = {key(t['path']): t for t in files['tracks']}
    db_tracks = tables.get('tracks', [])
    db_index = {}
    releases = {r['id']: r for r in tables.get('releases', [])}
    blobs = {r['release_id']: r for r in tables.get('engine_artwork', [])}
    images = {key(i['path']): i for i in files['images']}
    images_by_dir = {}
    for path, image in images.items():
        if image.get('valid'):
            images_by_dir.setdefault(Path(path).parent, []).append(path)
    by_release = {}
    mappings = {'title': 'title', 'artist': 'artist_credit', 'album': 'album_title',
                'album_artist': 'album_artist', 'composer': 'composer', 'year': 'release_year',
                'track_number': 'track_number', 'disc_number': 'disc_number', 'genre': 'genre'}
    for t in db_tracks:
        path = key(t['file_path'])
        if path in db_index:
            add('duplicate_db_path', path, ids=[db_index[path]['id'], t['id']])
        db_index[path] = t
        by_release.setdefault(t['release_id'], []).append(t)
        if not any(within(path, root) for root in roots):
            add('db_track_outside_scope', path, trackId=t['id'])
            continue
        if t['release_id'] not in releases:
            add('orphan_track_release', path, releaseId=t['release_id'])
        actual = disk.get(path)
        if actual is None:
            if files['complete']:
                add('db_track_missing_on_disk', path, trackId=t['id'], isOnline=t.get('is_online'))
            continue
        for field in ('file_size', 'mtime'):
            if field in t and t[field] != actual[field]:
                add(field + '_mismatch', path, database=t[field], filesystem=actual[field])
        if actual['status'] != 'ok':
            continue
        for source, target in mappings.items():
            if target not in t:
                continue
            a, b = normalized(actual['metadata'].get(source)), normalized(t.get(target))
            if source in {'year', 'track_number', 'disc_number'}:
                a = re.match(r'^\d+', a).group() if re.match(r'^\d+', a) else a
                b = re.match(r'^\d+', b).group() if re.match(r'^\d+', b) else b
            if a != b:
                add('metadata_mismatch', path, field=source, database=b, filesystem=a,
                    note='Raw tags versus catalogue values; sidecars, inferred defaults, and curated overrides may explain differences')
        for field, tolerance in [('duration_secs', 1.0), ('sample_rate', 0), ('bit_depth', 0), ('channels', 0)]:
            a, b = actual['technical'].get(field), t.get(field)
            if a is not None and b is not None and abs(float(a) - float(b)) > tolerance:
                add('technical_mismatch', path, field=field, database=b, filesystem=a)
        pictures = actual['embeddedPictures']
        # Engine repurposes has_embedded_art for decoded folder art too; compare to blobs separately.
        if 'engine_artwork' not in tables and bool(t.get('has_embedded_art')) != bool(pictures):
            add('embedded_art_flag_mismatch', path, database=bool(t.get('has_embedded_art')), filesystem=bool(pictures))
        if 'engine_artwork' in tables and t.get('has_embedded_art') and t['release_id'] not in blobs:
            add('art_flag_without_blob', path, releaseId=t['release_id'])
        for picture in pictures:
            if picture.get('valid') is not True:
                add('embedded_art_invalid_or_unverified', path, index=picture['index'], detail=picture.get('error'))
        if pictures and pictures[0]['type'] != 3 and any(p['type'] == 3 for p in pictures):
            add('front_cover_not_first', path)
    for path in sorted(set(disk) - set(db_index)):
        add('disk_track_missing_in_db', path)
    for image in images.values():
        if image.get('valid') is not True:
            add('folder_art_invalid_or_unverified', image['path'], detail=image.get('error'))
    for sidecar in files['sidecars']:
        if sidecar.get('error'):
            add('sidecar_invalid', sidecar['path'], detail=sidecar['error'])
    for release_id, release in releases.items():
        members = by_release.get(release_id, [])
        if not members:
            add('release_without_tracks', release.get('folder_path', ''), releaseId=release_id)
        scoped = [t for t in members if key(t['file_path']) in disk]
        candidates = []
        embedded_hashes = set()
        for t in scoped:
            path = key(t['file_path'])
            parent = Path(path).parent
            # Include album-parent art only inside scope, without accessing disk.
            for directory in {parent, parent.parent}:
                candidates.extend(images_by_dir.get(directory, []))
            embedded_hashes.update(p['sha256'] for p in disk[path].get('embeddedPictures', []) if p.get('valid'))
        if len(embedded_hashes) > 1:
            add('release_has_different_embedded_images', release.get('folder_path', ''), releaseId=release_id,
                note='May be legitimate multiple picture types; inspect picture hashes and types')
        blob = blobs.get(release_id)
        reference = release.get('front_cover_url')
        if 'engine_artwork' in tables:
            if scoped and (candidates or embedded_hashes) and not blob:
                add('source_art_without_engine_blob', release.get('folder_path', ''), releaseId=release_id, folderCandidates=sorted(set(candidates)))
            if blob and scoped and not any(t.get('has_embedded_art') for t in members):
                add('engine_blob_without_advertised_art', release.get('folder_path', ''), releaseId=release_id)
        elif scoped and (candidates or embedded_hashes) and not reference:
            add('source_art_without_release_reference', release.get('folder_path', ''), releaseId=release_id)
        for field in ('front_cover_url', 'backdrop_url'):
            reference = release.get(field)
            if not reference:
                continue
            if re.match(r'^(https?://|data:|blob:|cadence-art:|asset:|file:)', reference, re.I):
                add('art_reference_not_verified', release.get('folder_path', ''), releaseId=release_id, field=field, reference=reference)
            elif os.path.isabs(reference) and any(within(reference, r) for r in roots):
                if key(reference) not in images and files['complete']:
                    add('art_reference_missing', key(reference), releaseId=release_id, field=field)
            else:
                add('art_reference_outside_inventory', release.get('folder_path', ''), releaseId=release_id, field=field, reference=reference,
                    note='External cache/relative reference is recorded but not accessed')
    for release_id in sorted(set(blobs) - set(releases)):
        add('orphan_artwork_blob', releaseId=release_id)
    for release_id, blob in blobs.items():
        if not isinstance(blob.get('jpeg'), dict) or blob['jpeg'].get('bytes', 0) == 0:
            add('empty_or_invalid_artwork_blob', releaseId=release_id)
    for cache in tables.get('artwork_cache_state', []):
        if cache.get('entity_type') != 'release':
            continue
        if cache['id'] not in releases:
            add('orphan_release_artwork_cache', releaseId=cache['id'])
        if cache.get('status') != 'cached':
            add('release_artwork_cache_not_ready', releaseId=cache['id'], status=cache.get('status'))
        elif not cache.get('cache_path'):
            add('cached_artwork_without_path', releaseId=cache['id'])
    findings.sort(key=lambda f: json.dumps(f, sort_keys=True, ensure_ascii=False))
    return {'schemaVersion': 1, 'kind': 'consistency', 'databasePath': files['databasePath'],
            'generatedAtUtc': datetime.now(timezone.utc).isoformat(), 'roots': roots,
            'scopeFingerprint': files['scopeFingerprint'], 'complete': files['complete'] and database['complete'],
            'findings': findings, 'counts': dict(sorted(Counter(f['code'] for f in findings).items())),
            'limitations': ['Raw-tag differences can be intentional curated or sidecar overrides.',
                            'Compressed engine images cannot be compared byte-for-byte with original art.',
                            'No remote URLs or cache paths outside registered folders are read.',
                            'A snapshot pair must be exported while the catalogue and library remain unchanged.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--files', required=True, type=Path)
    parser.add_argument('--database', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--baseline', type=Path)
    args = parser.parse_args()
    try:
        inputs = [args.files, args.database] + ([args.baseline] if args.baseline else [])
        snapshots = [json.loads(p.read_text(encoding='utf-8-sig')) for p in inputs]
        result = compare(*snapshots[:2])
        if args.baseline:
            baseline = snapshots[2]
            if baseline.get('kind') != 'consistency' or baseline.get('schemaVersion') != 1:
                raise ValueError('Baseline must be a schemaVersion 1 consistency report')
            if baseline['scopeFingerprint'] != result['scopeFingerprint'] or baseline['databasePath'] != result['databasePath']:
                raise ValueError('Baseline must have the same database and folder scope')
            before = {json.dumps(f, sort_keys=True, ensure_ascii=False) for f in baseline['findings']}
            after = {json.dumps(f, sort_keys=True, ensure_ascii=False) for f in result['findings']}
            result['changes'] = {'added': [json.loads(f) for f in sorted(after - before)],
                                 'resolved': [json.loads(f) for f in sorted(before - after)], 'unchanged': len(before & after)}
        shared.write_report(result, args.output, result['roots'], inputs)
        print(json.dumps({'output': str(args.output.absolute()), 'findings': len(result['findings']), 'counts': result['counts']}))
        return 1 if result['findings'] else 0
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
