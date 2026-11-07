//! Persisted edition classification, independent of queue ordering.
use rusqlite::{params, Connection, Result, Transaction};
use serde::{Deserialize, Serialize};

const SCHEMA_VERSION: i64 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Classification {
    NeedsAttention,
    InProgress,
    NeedsReview,
    Completed,
    NoActionRequired,
}

impl Classification {
    fn code(self) -> &'static str {
        match self {
            Self::NeedsAttention => "needs_attention",
            Self::InProgress => "in_progress",
            Self::NeedsReview => "needs_review",
            Self::Completed => "completed",
            Self::NoActionRequired => "no_action_required",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    FailedWrite,
    PartialWrite,
    IdentityConflict,
    OrphanedEdit,
    InvalidDecision,
    ActionableDraft,
    PendingCommit,
    WritingCommit,
    CatalogDefect,
    StructuralMismatch,
    ProposalNeedsReview,
    ReviewCompleted,
    CommitCompleted,
}

pub fn classify(reasons: &[Reason]) -> Classification {
    use Classification::*;
    use Reason::*;
    let has = |candidates: &[Reason]| candidates.iter().any(|reason| reasons.contains(reason));
    if has(&[
        FailedWrite,
        PartialWrite,
        IdentityConflict,
        OrphanedEdit,
        InvalidDecision,
    ]) {
        NeedsAttention
    } else if has(&[ActionableDraft, PendingCommit, WritingCommit]) {
        InProgress
    } else if has(&[CatalogDefect, StructuralMismatch, ProposalNeedsReview]) {
        NeedsReview
    } else if has(&[ReviewCompleted, CommitCompleted]) {
        Completed
    } else {
        NoActionRequired
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct Projection {
    edition_id: String,
    edition_revision: i64,
    source_sequence: i64,
    pub classification: Classification,
    pub reasons: Vec<Reason>,
    pub stale: bool,
}

/// Read the compact row for one known edition. An edition without a current
/// projection requires attention until its facts have been evaluated.
pub fn get(conn: &Connection, edition_id: &str) -> Result<Projection> {
    conn.query_row(
        "SELECT e.revision, COALESCE(p.source_sequence, 0),
                COALESCE(p.stale OR p.edition_revision <> e.revision, 1),
                COALESCE(p.reasons_json, '[]')
         FROM curate_identity_editions e
         LEFT JOIN curate_queue_projection p
             ON p.edition_id = e.id AND p.schema_version = ?2
         WHERE e.id = ?1",
        params![edition_id, SCHEMA_VERSION],
        |row| {
            let stale = row.get::<_, bool>(2)?;
            let reasons: Vec<Reason> =
                serde_json::from_str(&row.get::<_, String>(3)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(Projection {
                edition_id: edition_id.to_owned(),
                edition_revision: row.get(0)?,
                source_sequence: row.get(1)?,
                classification: if stale {
                    Classification::NeedsAttention
                } else {
                    classify(&reasons)
                },
                reasons,
                stale,
            })
        },
    )
}

/// Publish a full set of facts evaluated against the supplied snapshot. Call
/// within the source transaction. A false result means the snapshot was superseded.
pub fn publish(tx: &Transaction, snapshot: &Projection, reasons: &[Reason]) -> Result<bool> {
    let mut reasons = reasons.to_vec();
    reasons.sort_unstable();
    reasons.dedup();
    let classification = classify(&reasons).code();
    let reasons_json = serde_json::to_string(&reasons)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    let changed = tx.execute(
        "INSERT INTO curate_queue_projection
            (edition_id, edition_revision, source_sequence, schema_version, classification,
             reasons_json, stale, updated_at)
         SELECT e.id, e.revision, COALESCE(p.source_sequence, 0) + 1, ?4, ?5, ?6, 0,
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         FROM curate_identity_editions e
         LEFT JOIN curate_queue_projection p ON p.edition_id = e.id
         WHERE e.id = ?1 AND e.revision = ?2
            AND COALESCE(CASE WHEN p.schema_version = ?4 THEN p.source_sequence END, 0) = ?3
         ON CONFLICT(edition_id) DO UPDATE SET
             edition_revision = excluded.edition_revision,
             source_sequence = excluded.source_sequence,
             schema_version = excluded.schema_version,
             classification = excluded.classification,
             reasons_json = excluded.reasons_json,
             stale = 0,
             updated_at = excluded.updated_at",
        params![
            snapshot.edition_id,
            snapshot.edition_revision,
            snapshot.source_sequence,
            SCHEMA_VERSION,
            classification,
            reasons_json
        ],
    )?;
    Ok(changed == 1)
}

#[cfg(test)]
mod tests {
    use super::{classify, Classification::*, Reason::*};

    #[test]
    fn classifies_by_current_work_before_completed_history() {
        assert_eq!(classify(&[]), NoActionRequired);
        assert_eq!(classify(&[CommitCompleted]), Completed);
        assert_eq!(classify(&[CommitCompleted, CatalogDefect]), NeedsReview);
        assert_eq!(classify(&[StructuralMismatch, PendingCommit]), InProgress);
        assert_eq!(classify(&[WritingCommit, FailedWrite]), NeedsAttention);
    }
}
