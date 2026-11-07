CREATE TABLE IF NOT EXISTS curate_queue_projection (
    edition_id TEXT PRIMARY KEY REFERENCES curate_identity_editions(id),
    edition_revision INTEGER NOT NULL,
    source_sequence INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    classification TEXT NOT NULL,
    reasons_json TEXT NOT NULL DEFAULT '[]',
    stale INTEGER NOT NULL CHECK (stale IN (0, 1)),
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS curate_queue_by_classification
    ON curate_queue_projection (schema_version, classification, updated_at, edition_id);

-- Edition revision changes include both sides of a regroup. Invalidate inside
-- the identity transaction, even when classification has never been published.
CREATE TRIGGER IF NOT EXISTS curate_queue_edition_changed
AFTER UPDATE OF revision ON curate_identity_editions
WHEN NEW.revision <> OLD.revision
BEGIN
    INSERT INTO curate_queue_projection
        (edition_id, edition_revision, source_sequence, schema_version, classification, stale, updated_at)
    VALUES (NEW.id, NEW.revision, 1, 1, 'needs_attention', 1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(edition_id) DO UPDATE SET
        edition_revision = excluded.edition_revision,
        source_sequence = source_sequence + 1,
        classification = excluded.classification,
        stale = 1,
        updated_at = excluded.updated_at;
END;
