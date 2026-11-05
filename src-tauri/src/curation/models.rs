use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDecision {
    pub action: String,
    pub chosen_value: String,
    #[serde(default)]
    pub local_value: Option<String>,
    #[serde(default)]
    pub consensus_ratio: Option<String>,
    #[serde(default)]
    pub plain_explanation: Option<String>,
    #[serde(default)]
    pub confidence_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateTelemetry {
    pub provider: String,
    pub release_id: String,
    #[serde(default)]
    pub track_count: Option<u32>,
    #[serde(default)]
    pub latency_ms: Option<u64>,
    #[serde(default)]
    pub http_status: Option<u16>,
    #[serde(default)]
    pub confidence_score: Option<f64>,
    #[serde(default)]
    pub rejection_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurationDecisionTrace {
    pub album_id: String,
    #[serde(default)]
    pub album_hash: Option<String>,
    #[serde(default)]
    pub matched_release_id: Option<String>,
    pub outcome_status: String,
    pub headline_summary: String,
    #[serde(default)]
    pub field_traces: HashMap<String, FieldDecision>,
    #[serde(default)]
    pub candidate_telemetry: Vec<CandidateTelemetry>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub engine_version: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}
