
CREATE TABLE IF NOT EXISTS curate_identity_editions (
    id TEXT PRIMARY KEY,
    anchor TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'inferred'
        CHECK (status IN ('inferred', 'user_confirmed', 'unmapped', 'conflicted')),
    revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS curate_identity_discs (
    id TEXT PRIMARY KEY,
    edition_id TEXT NOT NULL REFERENCES curate_identity_editions(id),
    number INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    order_revision INTEGER NOT NULL DEFAULT 0,
    UNIQUE (edition_id, number)
);

-- The catalog's opaque track ID is the lineage anchor. Keep detached rows so
-- a removed track's associations cannot be inherited by a replacement ID.
CREATE TABLE IF NOT EXISTS curate_identity_tracks (
    local_track_id TEXT PRIMARY KEY,
    disc_id TEXT REFERENCES curate_identity_discs(id),
    position INTEGER,
    catalog_source_key TEXT,
    lineage_status TEXT NOT NULL CHECK (lineage_status IN ('attached', 'unresolved'))
);
CREATE INDEX IF NOT EXISTS curate_identity_tracks_disc ON curate_identity_tracks(disc_id);

CREATE TABLE IF NOT EXISTS curate_identity_source_groups (
    id TEXT PRIMARY KEY,
    edition_id TEXT NOT NULL REFERENCES curate_identity_editions(id),
    candidate_key TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    UNIQUE (edition_id, candidate_key)
);
CREATE TABLE IF NOT EXISTS curate_identity_sources (
    local_track_id TEXT PRIMARY KEY REFERENCES curate_identity_tracks(local_track_id),
    group_id TEXT REFERENCES curate_identity_source_groups(id),
    status TEXT NOT NULL CHECK (status IN ('inferred', 'user_confirmed', 'unmapped', 'conflicted'))
);

CREATE TABLE IF NOT EXISTS curate_identity_mappings (
    local_track_id TEXT NOT NULL REFERENCES curate_identity_tracks(local_track_id),
    provider TEXT NOT NULL,
    release_id TEXT,
    provider_track_id TEXT,
    provider_position INTEGER,
    method TEXT NOT NULL,
    positional INTEGER NOT NULL CHECK (positional IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('inferred', 'user_confirmed', 'unmapped', 'conflicted')),
    revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (local_track_id, provider)
);

CREATE TABLE IF NOT EXISTS curate_identity_metadata (
    entity_id TEXT NOT NULL,
    field TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (entity_id, field)
);


-- Scan upserts and the tag-commit worker both update track positions.
CREATE TRIGGER IF NOT EXISTS curate_identity_track_reordered
AFTER UPDATE OF track_number ON tracks
WHEN NEW.track_number IS NOT OLD.track_number
    AND NEW.release_id IS OLD.release_id AND NEW.folder_path IS OLD.folder_path
    AND NEW.disc_number IS OLD.disc_number AND NEW.format IS OLD.format
BEGIN
    UPDATE curate_identity_discs SET order_revision = order_revision + 1
        WHERE id = (SELECT disc_id FROM curate_identity_tracks WHERE local_track_id = NEW.id);
    UPDATE curate_identity_tracks SET position = NEW.track_number WHERE local_track_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS curate_identity_track_detached
AFTER DELETE ON tracks
WHEN EXISTS (SELECT 1 FROM curate_identity_tracks WHERE local_track_id = OLD.id)
BEGIN
    UPDATE curate_identity_editions SET revision = revision + 1 WHERE id = (
        SELECT d.edition_id FROM curate_identity_tracks t JOIN curate_identity_discs d ON d.id = t.disc_id
        WHERE t.local_track_id = OLD.id
    );
    UPDATE curate_identity_discs SET revision = revision + 1
        WHERE id = (SELECT disc_id FROM curate_identity_tracks WHERE local_track_id = OLD.id);
    UPDATE curate_identity_tracks SET disc_id = NULL, lineage_status = 'unresolved'
        WHERE local_track_id = OLD.id;
    UPDATE curate_identity_source_groups SET revision = revision + 1
        WHERE id = (SELECT group_id FROM curate_identity_sources WHERE local_track_id = OLD.id);
    UPDATE curate_identity_sources SET group_id = NULL, status = 'unmapped' WHERE local_track_id = OLD.id;
    UPDATE curate_identity_mappings SET status = 'unmapped', release_id = NULL, provider_track_id = NULL,
        provider_position = NULL, method = 'detached', positional = 0, revision = revision + 1
        WHERE local_track_id = OLD.id AND status <> 'unmapped';
END;
