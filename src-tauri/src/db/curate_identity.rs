use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Result, Transaction};
use serde::Deserialize;
use uuid::Uuid;

pub(crate) fn matching_snapshot_ids<'a>(
    tx: &Transaction,
    before: &'a [serde_json::Value],
) -> Result<Option<std::collections::HashSet<&'a str>>> {
    let ordered_ids: Vec<_> = before
        .iter()
        .filter_map(|track| track["localTrackId"].as_str().map(str::to_owned))
        .collect();
    if snapshot(tx, &ordered_ids, false)? != before {
        return Ok(None);
    }
    Ok(Some(
        before
            .iter()
            .filter_map(|track| track["localTrackId"].as_str())
            .collect(),
    ))
}

pub(crate) fn snapshot(
    tx: &Transaction,
    ids: &[String],
    seed: bool,
) -> Result<Vec<serde_json::Value>> {
    let mut rows = Vec::with_capacity(ids.len());
    let mut stmt = tx.prepare_cached(
        "SELECT e.id, e.revision, d.id, d.revision, d.order_revision, g.id, g.revision
         FROM curate_identity_tracks t
         JOIN curate_identity_discs d ON d.id = t.disc_id
         JOIN curate_identity_editions e ON e.id = d.edition_id
         LEFT JOIN curate_identity_sources s ON s.local_track_id = t.local_track_id
         LEFT JOIN curate_identity_source_groups g ON g.id = s.group_id
         WHERE t.local_track_id = ?1",
    )?;
    for id in ids {
        if seed {
            let exists = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM curate_identity_tracks WHERE local_track_id = ?1)",
                [id],
                |row| row.get::<_, bool>(0),
            )?;
            if !exists {
                sync_track(tx, id, None)?;
            }
        }
        if let Some(row) = stmt
            .query_row([id], |row| {
                Ok(serde_json::json!({
                    "localTrackId": id,
                    "editionId": row.get::<_, String>(0)?,
                    "editionRev": row.get::<_, i64>(1)?,
                    "discId": row.get::<_, String>(2)?,
                    "discRev": row.get::<_, i64>(3)?,
                    "trackOrderRev": row.get::<_, i64>(4)?,
                    "sourceGroupId": row.get::<_, Option<String>>(5)?,
                    "sourceGroupRev": row.get::<_, Option<i64>>(6)?,
                }))
            })
            .optional()?
        {
            rows.push(row);
        }
    }
    Ok(rows)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceCandidate {
    pub local_track_id: String,
    pub title: String,
    pub year: Option<i32>,
}

pub(crate) fn record_source(tx: &Transaction, candidate: &SourceCandidate) -> Result<()> {
    let edition: Option<String> = tx
        .query_row(
            "SELECT d.edition_id FROM curate_identity_tracks t
         JOIN curate_identity_discs d ON d.id = t.disc_id
         WHERE t.local_track_id = ?1 AND t.catalog_source_key IS NULL",
            [&candidate.local_track_id],
            |row| row.get(0),
        )
        .optional()?;
    if let (Some(edition), Some(key)) = (edition, source_key(&candidate.title, candidate.year)) {
        set_source(tx, &candidate.local_track_id, &edition, Some(&key))?;
    }
    Ok(())
}

pub(crate) fn revise_metadata(tx: &Transaction, entity: &str, field: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO curate_identity_metadata (entity_id, field) VALUES (?1, ?2)
         ON CONFLICT(entity_id, field) DO UPDATE SET revision = revision + 1",
        params![entity, field],
    )?;
    Ok(())
}

pub(crate) fn record_draft_edits(
    tx: &Transaction,
    album: &str,
    previous: &serde_json::Value,
    draft: &serde_json::Value,
) -> Result<()> {
    let explicit = |value: &serde_json::Value| value["userOverridden"].as_bool() == Some(true);
    let mut changed_fields = Vec::new();
    for field in [
        "albumTitle",
        "albumArtist",
        "composer",
        "year",
        "coverArt",
        "genre",
    ] {
        let old = &previous["fields"][field];
        let new = &draft["fields"][field];
        if explicit(old) != explicit(new) || (explicit(new) && old["selected"] != new["selected"]) {
            changed_fields.push(field);
        }
    }
    let track_selections = |value: &serde_json::Value| {
        value["tracks"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|track| Some((track["trackId"].as_str()?.to_owned(), track)))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let old_tracks = track_selections(previous);
    let new_tracks = track_selections(draft);
    if !changed_fields.is_empty() {
        let ids: Vec<_> = new_tracks.keys().cloned().collect();
        let editions: std::collections::BTreeSet<_> = snapshot(tx, &ids, true)?
            .into_iter()
            .filter_map(|track| track["editionId"].as_str().map(str::to_owned))
            .collect();
        for field in changed_fields {
            revise_metadata(tx, album, field)?;
            for edition in &editions {
                revise_metadata(tx, edition, field)?;
            }
        }
    }
    for (id, new) in &new_tracks {
        let old = old_tracks.get(id).unwrap_or(&serde_json::Value::Null);
        for (selection, field) in [
            ("matchedTitle", "title"),
            ("matchedArtists", "artist"),
            ("originalAlbum", "originalAlbum"),
            ("originalYear", "originalYear"),
        ] {
            let chosen = |value: &serde_json::Value| {
                value["selectedOverrides"].as_array().is_some_and(|fields| {
                    fields.iter().any(|field| field.as_str() == Some(selection))
                })
            };
            if chosen(old) != chosen(new) || (chosen(new) && old[selection] != new[selection]) {
                revise_metadata(tx, id, field)?;
            }
        }
    }
    Ok(())
}

pub(super) fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(include_str!("curate_identity.sql"))?;
    // Field clocks cover all catalog update paths, including completed tag writes.
    for (table, fields) in [
        (
            "tracks",
            &[
                ("title", "title"),
                ("artist", "artist_credit"),
                ("albumTitle", "album_title"),
                ("albumArtist", "album_artist"),
                ("year", "release_year"),
                ("genre", "genre"),
                ("composer", "composer"),
                ("originalAlbum", "original_album"),
                ("originalYear", "original_year"),
            ][..],
        ),
        (
            "releases",
            &[
                ("albumTitle", "title"),
                ("albumArtist", "artist_credit"),
                ("year", "release_year"),
                ("genre", "genre_tags"),
                ("composer", "composer_name"),
                ("coverArt", "front_cover_url"),
            ][..],
        ),
    ] {
        for (field, column) in fields {
            let edition_revision = if table == "releases" {
                format!(
                    "INSERT INTO curate_identity_metadata (entity_id, field)
                     SELECT DISTINCT d.edition_id, '{field}'
                     FROM tracks t JOIN curate_identity_tracks i ON i.local_track_id = t.id
                     JOIN curate_identity_discs d ON d.id = i.disc_id
                     WHERE t.release_id = NEW.id
                     ON CONFLICT(entity_id, field) DO UPDATE SET revision = revision + 1;"
                )
            } else {
                String::new()
            };
            conn.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS curate_identity_{table}_{column}
                 AFTER UPDATE OF {column} ON {table}
                 WHEN NEW.{column} IS NOT OLD.{column}
                 BEGIN
                     INSERT INTO curate_identity_metadata (entity_id, field) VALUES (NEW.id, '{field}')
                     ON CONFLICT(entity_id, field) DO UPDATE SET revision = revision + 1;
                     {edition_revision}
                 END;"
            ))?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MappingStatus {
    Inferred,
    Unmapped,
    Conflicted,
}

impl MappingStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Inferred => "inferred",
            Self::Unmapped => "unmapped",
            Self::Conflicted => "conflicted",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MappingCandidate {
    pub local_track_id: String,
    pub provider: String,
    pub release_id: Option<String>,
    pub provider_track_id: Option<String>,
    pub provider_position: Option<i64>,
    pub method: String,
    pub positional: bool,
    pub status: MappingStatus,
}

fn disc_folder_number(folder: &Path) -> Option<u32> {
    let name = folder.file_name()?.to_str()?.to_ascii_lowercase();
    let number = ["disc", "disk", "cd"]
        .iter()
        .find_map(|prefix| name.strip_prefix(prefix))?;
    number
        .trim_start_matches([' ', '-', '_'])
        .parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
}

/// Synchronize the stored row, because a same-path upsert can retain a different
/// local ID than the scanner submitted. Only scan/import or selected-album paths call this.
pub(crate) fn sync_track(
    tx: &Transaction,
    local_track_id: &str,
    file_path: Option<&str>,
) -> Result<()> {
    let lookup = if file_path.is_some() {
        "file_path"
    } else {
        "id"
    };
    let sql = format!(
        "SELECT id, release_id, mount_id, folder_path, format, disc_number, track_number,
                original_album, original_year FROM tracks WHERE {lookup} = ?1"
    );
    let track = tx
        .query_row(&sql, [file_path.unwrap_or(local_track_id)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<u32>>(5)?,
                row.get::<_, Option<i32>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<i32>>(8)?,
            ))
        })
        .optional()?;
    let Some((
        id,
        release_id,
        mount,
        folder,
        format,
        tagged_disc,
        position,
        original_album,
        original_year,
    )) = track
    else {
        return Ok(());
    };

    let folder = Path::new(&folder);
    let folder_disc = disc_folder_number(folder);
    let disc_number = folder_disc.or(tagged_disc.filter(|n| *n > 0)).unwrap_or(1);
    // Pair explicitly numbered sibling CD directories, and preserve independent
    // catalog releases and format editions in ordinary directories.
    let anchor = if let Some(root) = folder_disc.and_then(|_| folder.parent()) {
        serde_json::json!([
            "disc_folders",
            mount,
            root.to_string_lossy().replace('\\', "/").to_lowercase(),
            format
        ])
    } else {
        serde_json::json!(["catalog_release", release_id, format])
    }
    .to_string();

    let prior: Option<(Option<String>, Option<String>, Option<i32>, Option<String>)> = tx.query_row(
        "SELECT t.disc_id, d.edition_id, t.position, t.catalog_source_key FROM curate_identity_tracks t
         LEFT JOIN curate_identity_discs d ON d.id = t.disc_id
         WHERE t.local_track_id = ?1",
        [&id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).optional()?;
    let (old_disc, old_edition, old_position, old_source_key) = prior.unwrap_or_default();
    let source_key = original_album
        .as_deref()
        .and_then(|title| source_key(title, original_year));

    let edition: String = find_or_insert(
        tx,
        "SELECT id FROM curate_identity_editions WHERE anchor = ?1",
        [&anchor],
        || {
            tx.query_row(
                "INSERT INTO curate_identity_editions (anchor, id) VALUES (?1, ?2) RETURNING id",
                params![anchor, Uuid::new_v4().to_string()],
                |row| row.get(0),
            )
        },
    )?;
    let disc: String = find_or_insert(
        tx,
        "SELECT id FROM curate_identity_discs WHERE edition_id = ?1 AND number = ?2",
        params![edition, disc_number],
        || {
            tx.query_row("INSERT INTO curate_identity_discs (edition_id, number, id) VALUES (?1, ?2, ?3) RETURNING id",
            params![edition, disc_number, Uuid::new_v4().to_string()], |row| row.get(0))
        },
    )?;
    if old_disc.as_deref() != Some(&disc) {
        let edition_changed = old_edition.as_deref() != Some(edition.as_str());
        let disc_set_changed = !edition_changed && tx.query_row(
            "SELECT NOT EXISTS (SELECT 1 FROM curate_identity_tracks WHERE disc_id = ?1 AND local_track_id <> ?3)
                OR NOT EXISTS (SELECT 1 FROM curate_identity_tracks WHERE disc_id = ?2)",
            params![old_disc, disc, id], |row| row.get::<_, bool>(0),
        )?;
        if edition_changed || disc_set_changed {
            tx.execute(
                "UPDATE curate_identity_editions SET revision = revision + 1 WHERE id IN (?1, ?2)",
                params![old_edition, edition],
            )?;
        }
        tx.execute(
            "UPDATE curate_identity_discs SET revision = revision + 1 WHERE id IN (?1, ?2)",
            params![old_disc, disc],
        )?;
    } else if old_position != position {
        tx.execute(
            "UPDATE curate_identity_discs SET order_revision = order_revision + 1 WHERE id = ?1",
            [&disc],
        )?;
    }
    tx.execute(
        "INSERT INTO curate_identity_tracks (local_track_id, disc_id, position, catalog_source_key, lineage_status)
         VALUES (?1, ?2, ?3, ?4, 'attached') ON CONFLICT(local_track_id) DO UPDATE SET
         disc_id = excluded.disc_id, position = excluded.position,
         catalog_source_key = excluded.catalog_source_key, lineage_status = 'attached'
         WHERE disc_id IS NOT excluded.disc_id OR position IS NOT excluded.position
            OR catalog_source_key IS NOT excluded.catalog_source_key",
        params![id, disc, position, source_key],
    )?;
    if old_edition.as_deref().is_some_and(|old| old != edition) {
        tx.execute(
            "UPDATE curate_identity_mappings SET status = 'conflicted', revision = revision + 1
             WHERE local_track_id = ?1 AND status IN ('inferred', 'user_confirmed')",
            [&id],
        )?;
    }
    if source_key != old_source_key || old_edition.as_deref() != Some(edition.as_str()) {
        set_source(tx, &id, &edition, source_key.as_deref())?;
    }
    Ok(())
}

fn find_or_insert(
    tx: &Transaction,
    query: &str,
    keys: impl rusqlite::Params,
    insert: impl FnOnce() -> Result<String>,
) -> Result<String> {
    let mut stmt = tx.prepare_cached(query)?;
    let found = stmt.query_row(keys, |row| row.get(0)).optional()?;
    if let Some(id) = found {
        return Ok(id);
    }
    insert()
}

fn source_key(title: &str, year: Option<i32>) -> Option<String> {
    let normalized = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    (!normalized.is_empty()).then(|| serde_json::json!([normalized, year]).to_string())
}

fn set_source(tx: &Transaction, id: &str, edition: &str, key: Option<&str>) -> Result<()> {
    let prior: Option<(Option<String>, String)> = tx
        .query_row(
            "SELECT group_id, status FROM curate_identity_sources WHERE local_track_id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if prior
        .as_ref()
        .is_some_and(|(_, status)| status == "user_confirmed")
    {
        return Ok(());
    }
    let group = key.map(|key| {
        find_or_insert(tx,
            "SELECT id FROM curate_identity_source_groups WHERE edition_id = ?1 AND candidate_key = ?2",
            params![edition, key],
            || tx.query_row("INSERT INTO curate_identity_source_groups (edition_id, candidate_key, id) VALUES (?1, ?2, ?3) RETURNING id",
                params![edition, key, Uuid::new_v4().to_string()], |row| row.get(0)),
        )
    }).transpose()?;
    let status = if group.is_some() {
        "inferred"
    } else {
        "unmapped"
    };
    let old_group = prior.as_ref().and_then(|(group, _)| group.as_deref());
    if old_group != group.as_deref() {
        tx.execute(
            "UPDATE curate_identity_source_groups SET revision = revision + 1 WHERE id IN (?1, ?2)",
            params![old_group, group],
        )?;
    }
    tx.execute(
        "INSERT INTO curate_identity_sources (local_track_id, group_id, status) VALUES (?1, ?2, ?3)
         ON CONFLICT(local_track_id) DO UPDATE SET group_id = excluded.group_id, status = excluded.status
         WHERE group_id IS NOT excluded.group_id OR status IS NOT excluded.status",
        params![id, group, status],
    )?;
    Ok(())
}

pub(crate) fn record_mapping(tx: &Transaction, mapping: &MappingCandidate) -> Result<()> {
    tx.execute(
        "INSERT INTO curate_identity_mappings
             (local_track_id, provider, release_id, provider_track_id, provider_position, method, positional, status)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
         WHERE EXISTS (SELECT 1 FROM curate_identity_tracks WHERE local_track_id = ?1 AND lineage_status = 'attached')
         ON CONFLICT(local_track_id, provider) DO UPDATE SET
             release_id = excluded.release_id, provider_track_id = excluded.provider_track_id,
             provider_position = excluded.provider_position, method = excluded.method,
             positional = excluded.positional, status = excluded.status, revision = revision + 1
         WHERE status <> 'user_confirmed' AND (
             release_id IS NOT excluded.release_id OR provider_track_id IS NOT excluded.provider_track_id
             OR ((provider_track_id IS NULL OR positional = 1 OR excluded.positional = 1)
                 AND provider_position IS NOT excluded.provider_position) OR method IS NOT excluded.method
             OR positional IS NOT excluded.positional OR status IS NOT excluded.status)",
        params![mapping.local_track_id, mapping.provider, mapping.release_id, mapping.provider_track_id,
            mapping.provider_position, mapping.method, mapping.positional, mapping.status.as_str()],
    )?;
    Ok(())
}
