use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

pub const STRICT_OVERWRITE_THRESHOLD: f64 = 0.05;
pub const RELAXED_MISSING_THRESHOLD: f64 = 0.14;
pub const REVIEW_THRESHOLD: f64 = 0.28;
pub const STRICT_RUNNER_UP_GAP: f64 = 0.15;
pub const RELAXED_RUNNER_UP_GAP: f64 = 0.12;
pub const TRACK_LENGTH_GRACE_SECS: f64 = 10.0;
pub const TRACK_LENGTH_MAX_SECS: f64 = 30.0;
pub const TRACK_LENGTH_HARD_VETO_SECS: f64 = 15.0;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album_artist: Option<String>,
    pub track_number: Option<u32>,
    pub disc_number: Option<u32>,
    pub duration_secs: f64,
    pub release_year: Option<i32>,
    pub mb_recording_id: Option<String>,
    pub original_album: Option<String>,
    pub is_compilation: bool,
    pub locked_fields: HashSet<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAlbum {
    pub release_id: String,
    pub title: String,
    pub artist: String,
    pub year: Option<i32>,
    pub is_compilation: bool,
    pub discs_total: u32,
    pub locked_release_fields: HashSet<String>,
    pub album_locked: bool,
    pub tracks: Vec<LocalTrack>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateTrack {
    pub track_id: Option<String>,
    pub title: String,
    pub artist: String,
    pub index: u32,
    pub medium_index: u32,
    pub medium: u32,
    pub duration_secs: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateAlbum {
    pub provider: String, // "musicbrainz" | "apple_music"
    pub external_release_id: String,
    pub album: String,
    pub artist: String,
    pub is_va: bool,
    pub year: Option<i32>,
    pub original_year: Option<i32>,
    pub mediums: u32,
    pub composer: Option<String>,
    pub genre: Option<String>,
    pub artwork_url: Option<String>,
    pub tracks: Vec<CandidateTrack>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VetoCode {
    TrackCountMismatch,
    DurationMismatch,
    AmbiguousRunnerUp,
    CompilationOrVaFlip,
    DestructiveOrEmptyReplacement,
    SevereTextDivergence,
    UserHistoryLocked,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VetoReason {
    pub code: VetoCode,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchOutcome {
    AutoApply,
    NeedsReview,
    NoMatch,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackProposal {
    pub local_track_id: String,
    pub candidate_title: String,
    pub candidate_artist: String,
    pub proposed_title: Option<String>,
    pub proposed_artist: Option<String>,
    pub track_distance: f64,
    pub auto_apply_fields: Vec<String>,
    pub review_fields: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumProposal {
    pub provider: String,
    pub external_release_id: String,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i32>,
    pub composer: Option<String>,
    pub genre: Option<String>,
    pub artwork_url: Option<String>,
    pub auto_apply_release_fields: Vec<String>,
    pub review_release_fields: Vec<String>,
    pub tracks: Vec<TrackProposal>,
    pub penalties: BTreeMap<String, f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchEvaluation {
    pub outcome: MatchOutcome,
    pub distance: f64,
    pub effective_distance: f64,
    pub runner_up_distance: Option<f64>,
    pub vetoes: Vec<VetoReason>,
    pub proposal: Option<AlbumProposal>,
}

pub fn is_va_artist(value: &str) -> bool {
    let norm = value.trim().to_ascii_lowercase();
    matches!(norm.as_str(), "various artists" | "various" | "va" | "v.a.")
}

pub fn is_placeholder_value(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "unknown"
            | "unknown album"
            | "unknown artist"
            | "unknown title"
            | "untitled"
            | "[untitled]"
            | "untitled album"
            | "none"
            | "n/a"
            | "na"
            | "null"
            | "artist"
            | "album"
            | "various"
            | "various artists"
            | "va"
            | "v.a."
    ) {
        return true;
    }
    if lower.chars().all(|c| c.is_ascii_digit() || c == '-' || c == ' ') {
        return true;
    }
    for prefix in ["track ", "audiotrack ", "track_", "cd ", "disc "] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let digits = rest.trim();
            if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
                return true;
            }
        }
    }
    false
}

fn fold_latin_char(ch: char) -> char {
    match ch {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'é' | 'è' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'í' | 'ì' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ú' | 'ù' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ž' | 'ź' | 'ż' => 'z',
        'š' | 'ś' | 'ŝ' | 'ş' => 's',
        'ř' | 'ŕ' | 'ŗ' => 'r',
        'ł' | 'ĺ' | 'ļ' | 'ľ' => 'l',
        'ď' | 'đ' => 'd',
        'ť' | 'ţ' | 'ŧ' => 't',
        _ => ch,
    }
}

fn normalize_alnum(input: &str) -> Vec<char> {
    input
        .to_lowercase()
        .chars()
        .map(fold_latin_char)
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn levenshtein_chars(a: &[char], b: &[char]) -> usize {
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0usize; b.len() + 1];
    for (i, &ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

fn string_dist_basic(s1: &str, s2: &str) -> f64 {
    let a = normalize_alnum(s1);
    let b = normalize_alnum(s2);
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let max_len = a.len().max(b.len());
    levenshtein_chars(&a, &b) as f64 / max_len as f64
}

fn strip_paired_delimited(input: &str, open: char, close: char) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth = 0usize;
    for ch in input.chars() {
        if ch == open {
            depth += 1;
        } else if ch == close && depth > 0 {
            depth -= 1;
        } else if depth == 0 {
            out.push(ch);
        }
    }
    out
}

fn strip_ep_single_tag(input: &str) -> String {
    let mut s = input.to_string();
    for tag in ["[ep]", "(ep)", "[single]", "(single)"] {
        s = s.replace(tag, "");
    }
    let trimmed = s.trim_end();
    for suffix in [" ep", " single"] {
        if let Some(prefix) = trimmed.strip_suffix(suffix) {
            return prefix.to_string();
        }
    }
    s
}

fn strip_feat_suffix(input: &str) -> String {
    let lower = input;
    for marker in [" featuring ", " feat. ", " feat ", " ft. ", " ft "] {
        if let Some(idx) = lower.find(marker) {
            return input[..idx].to_string();
        }
    }
    for marker in ["(feat.", "(feat ", "(ft.", "(ft ", "(featuring ", "[feat.", "[feat ", "[ft."] {
        if let Some(idx) = lower.find(marker) {
            return input[..idx].to_string();
        }
    }
    input.to_string()
}

fn strip_part_suffix(input: &str) -> String {
    for marker in [", pt. ", ", pt ", ", part ", " pt. ", " part "] {
        if let Some(idx) = input.find(marker) {
            return input[..idx].to_string();
        }
    }
    input.to_string()
}

fn strip_rip_noise(input: &str) -> String {
    let mut s = input.to_string();
    for tag in [
        "[cd rip]",
        "(cd rip)",
        "[cd-rip]",
        "(cd-rip)",
        "[cdrip]",
        "(cdrip)",
        "[eac]",
        "(eac)",
        "[flac]",
        "(flac)",
        "[lossless]",
        "(lossless)",
        "[web]",
        "(web)",
        "[web-dl]",
        "(web-dl)",
        "[sacd]",
        "(sacd)",
        "[dsd]",
        "(dsd)",
        "[24bit]",
        "(24bit)",
        "[24-bit]",
        "(24-bit)",
        "[320kbps]",
        "(320kbps)",
        "[v0]",
        "(v0)",
    ] {
        if s.contains(tag) {
            s = s.replace(tag, "");
        }
    }
    let trimmed = s.trim_end();
    for suffix in [" - cd rip", " - cd-rip", " cd rip", " cd-rip"] {
        if let Some(prefix) = trimmed.strip_suffix(suffix) {
            return prefix.trim_end().to_string();
        }
    }
    trimmed.to_string()
}

/// Port of Beets' `string_dist` (`beets/autotag/distance.py`), preserving Unicode letters.
pub fn string_dist(str1: Option<&str>, str2: Option<&str>) -> f64 {
    let (Some(s1), Some(s2)) = (str1, str2) else {
        return match (str1, str2) {
            (None, None) => 0.0,
            _ => 1.0,
        };
    };

    let move_end_word = |mut s: String| -> String {
        for word in ["the", "a", "an"] {
            let suffix = format!(", {word}");
            if s.ends_with(&suffix) {
                let prefix_len = s.len() - suffix.len();
                s = format!("{word} {}", &s[..prefix_len]);
                break;
            }
        }
        s
    };

    let mut cur1 = move_end_word(s1.to_lowercase()).replace('&', "and");
    let mut cur2 = move_end_word(s2.to_lowercase()).replace('&', "and");

    let mut base_dist = string_dist_basic(&cur1, &cur2);
    let mut penalty = 0.0;

    let steps: Vec<(fn(&str) -> String, f64)> = vec![
        (|s| s.strip_prefix("the ").unwrap_or(s).to_string(), 0.1),
        (strip_ep_single_tag, 0.0),
        (strip_rip_noise, 0.05),
        (strip_feat_suffix, 0.1),
        (|s| strip_paired_delimited(s, '(', ')'), 0.3),
        (|s| strip_paired_delimited(s, '[', ']'), 0.3),
        (strip_part_suffix, 0.2),
    ];

    for (transform, weight) in steps {
        let next1 = transform(&cur1);
        let next2 = transform(&cur2);
        if next1 != cur1 || next2 != cur2 {
            let case_dist = string_dist_basic(&next1, &next2);
            let case_delta = (base_dist - case_dist).max(0.0);
            if case_delta > 0.0 {
                cur1 = next1;
                cur2 = next2;
                base_dist = case_dist;
                penalty += weight * case_delta;
            }
        }
    }

    (base_dist + penalty).min(1.0)
}

#[derive(Clone, Debug, Default)]
pub struct Distance {
    penalties: BTreeMap<String, Vec<f64>>,
}

impl Distance {
    fn weight(key: &str) -> f64 {
        match key {
            "data_source" => 2.0,
            "artist" => 3.0,
            "album" => 3.0,
            "mediums" => 1.0,
            "year" => 1.0,
            "tracks" => 2.0,
            "missing_tracks" => 0.9,
            "unmatched_tracks" => 0.6,
            "track_title" => 3.0,
            "track_artist" => 2.0,
            "track_index" => 1.0,
            "track_length" => 2.0,
            "track_id" => 5.0,
            "medium" => 1.0,
            _ => 1.0,
        }
    }

    pub fn add(&mut self, key: &str, dist: f64) {
        self.penalties
            .entry(key.to_string())
            .or_default()
            .push(dist.clamp(0.0, 1.0));
    }

    pub fn add_expr(&mut self, key: &str, expr: bool) {
        self.add(key, if expr { 1.0 } else { 0.0 });
    }

    pub fn add_ratio(&mut self, key: &str, number1: f64, number2: f64) {
        if number2 <= 0.0 {
            self.add(key, 0.0);
        } else {
            let clamped = number1.clamp(0.0, number2);
            self.add(key, clamped / number2);
        }
    }

    pub fn add_string(&mut self, key: &str, s1: Option<&str>, s2: Option<&str>) {
        self.add(key, string_dist(s1, s2));
    }

    pub fn raw_distance(&self) -> f64 {
        self.penalties
            .iter()
            .map(|(k, vals)| vals.iter().sum::<f64>() * Self::weight(k))
            .sum()
    }

    pub fn max_distance(&self) -> f64 {
        self.penalties
            .iter()
            .map(|(k, vals)| vals.len() as f64 * Self::weight(k))
            .sum()
    }

    pub fn distance(&self) -> f64 {
        let max_d = self.max_distance();
        if max_d > 0.0 {
            self.raw_distance() / max_d
        } else {
            0.0
        }
    }

    pub fn penalty_breakdown(&self) -> BTreeMap<String, f64> {
        let max_d = self.max_distance();
        let mut out = BTreeMap::new();
        if max_d <= 0.0 {
            return out;
        }
        for (k, vals) in &self.penalties {
            let weighted = (vals.iter().sum::<f64>() * Self::weight(k)) / max_d;
            if weighted > 1e-6 {
                out.insert(k.clone(), (weighted * 10_000.0).round() / 10_000.0);
            }
        }
        out
    }
}

pub fn track_distance(
    local: &LocalTrack,
    cand: &CandidateTrack,
    incl_artist: bool,
) -> Distance {
    let mut d = Distance::default();
    if let Some(cand_len) = cand.duration_secs.filter(|&v| v > 0.0) {
        if local.duration_secs > 0.0 {
            let diff = (local.duration_secs - cand_len).abs() - TRACK_LENGTH_GRACE_SECS;
            d.add_ratio("track_length", diff, TRACK_LENGTH_MAX_SECS);
        }
    }
    if !is_placeholder_value(&local.title) {
        d.add_string("track_title", Some(&local.title), Some(&cand.title));
    } else {
        // Placeholder track title cannot corroborate by title alone, penalize mildly if empty
        d.add("track_title", 0.0);
    }
    if incl_artist
        && !cand.artist.trim().is_empty()
        && !is_va_artist(&local.artist)
        && !is_placeholder_value(&local.artist)
    {
        d.add_string("track_artist", Some(&local.artist), Some(&cand.artist));
    }
    if cand.index > 0 {
        if let Some(local_trk) = local.track_number.filter(|&t| t > 0) {
            let index_changed = local_trk != cand.medium_index && local_trk != cand.index;
            d.add_expr("track_index", index_changed);
        }
    }
    if cand.medium > 0 {
        if let Some(local_disc) = local.disc_number.filter(|&v| v > 0) {
            d.add_expr("medium", local_disc != cand.medium);
        }
    }
    if let (Some(ref l_id), Some(ref c_id)) = (&local.mb_recording_id, &cand.track_id) {
        if !l_id.trim().is_empty() && !c_id.trim().is_empty() {
            d.add_expr("track_id", l_id != c_id);
        }
    }
    d
}

/// Exact Hungarian (Kuhn-Munkres) minimum-weight assignment for rectangular cost matrices.
fn hungarian_assign(costs: &[Vec<f64>]) -> Vec<Option<usize>> {
    let rows = costs.len();
    if rows == 0 {
        return Vec::new();
    }
    let cols = costs[0].len();
    if cols == 0 {
        return vec![None; rows];
    }
    let n = rows.max(cols);
    let mut a = vec![vec![0.0_f64; n + 1]; n + 1];
    for r in 0..n {
        for c in 0..n {
            a[r + 1][c + 1] = if r < rows && c < cols {
                costs[r][c]
            } else {
                1.0
            };
        }
    }

    let mut u = vec![0.0_f64; n + 1];
    let mut v = vec![0.0_f64; n + 1];
    let mut p = vec![0usize; n + 1];
    let mut way = vec![0usize; n + 1];

    for i in 1..=n {
        p[0] = i;
        let mut j0 = 0usize;
        let mut minv = vec![f64::INFINITY; n + 1];
        let mut used = vec![false; n + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = f64::INFINITY;
            let mut j1 = 0usize;
            for j in 1..=n {
                if !used[j] {
                    let cur = a[i0][j] - u[i0] - v[j];
                    if cur < minv[j] {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            for j in 0..=n {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }

    let mut result = vec![None; rows];
    for j in 1..=n {
        if p[j] >= 1 && p[j] <= rows && j <= cols {
            result[p[j] - 1] = Some(j - 1);
        }
    }
    result
}

pub fn assign_tracks(
    local_tracks: &[LocalTrack],
    cand_tracks: &[CandidateTrack],
    incl_artist: bool,
) -> (Vec<(usize, usize, Distance)>, Vec<usize>, Vec<usize>) {
    if local_tracks.is_empty() || cand_tracks.is_empty() {
        return (
            Vec::new(),
            (0..local_tracks.len()).collect(),
            (0..cand_tracks.len()).collect(),
        );
    }
    let costs: Vec<Vec<f64>> = local_tracks
        .iter()
        .map(|lt| {
            cand_tracks
                .iter()
                .map(|ct| track_distance(lt, ct, incl_artist).distance())
                .collect()
        })
        .collect();
    let assigned = hungarian_assign(&costs);
    let mut pairs = Vec::new();
    let mut extra_local = Vec::new();
    let mut used_cand = HashSet::new();
    for (li, opt_ci) in assigned.into_iter().enumerate() {
        if let Some(ci) = opt_ci {
            used_cand.insert(ci);
            let td = track_distance(&local_tracks[li], &cand_tracks[ci], incl_artist);
            pairs.push((li, ci, td));
        } else {
            extra_local.push(li);
        }
    }
    let extra_cand: Vec<usize> = (0..cand_tracks.len())
        .filter(|ci| !used_cand.contains(ci))
        .collect();
    (pairs, extra_local, extra_cand)
}

fn data_source_penalty(provider: &str) -> f64 {
    match provider {
        "musicbrainz" => 0.0,
        "apple_music" => 0.35,
        _ => 0.5,
    }
}

fn compute_album_distance_pair(
    local: &LocalAlbum,
    cand: &CandidateAlbum,
    pairs: &[(usize, usize, Distance)],
    unmatched_local_count: usize,
) -> (Distance, Distance) {
    let mut strict = Distance::default();
    let mut relaxed = Distance::default();

    if !cand.is_va && !is_placeholder_value(&local.artist) {
        let sd = string_dist(Some(&local.artist), Some(&cand.artist));
        strict.add("artist", sd);
        relaxed.add("artist", sd);
    }

    if !is_placeholder_value(&local.title) {
        let sd = string_dist(Some(&local.title), Some(&cand.album));
        strict.add("album", sd);
        relaxed.add("album", sd);
    }

    if local.discs_total > 0 && cand.mediums > 0 {
        let diff = (local.discs_total as i32 - cand.mediums as i32).unsigned_abs();
        if diff == 0 {
            strict.add("mediums", 0.0);
            relaxed.add("mediums", 0.0);
        } else {
            for _ in 0..diff {
                strict.add("mediums", 1.0);
                relaxed.add("mediums", 1.0);
            }
        }
    }

    if let (Some(ly), Some(cy)) = (local.year.filter(|&y| y >= 1889), cand.year) {
        let hit = ly == cy || Some(ly) == cand.original_year;
        let y_pen = if hit {
            0.0
        } else if let Some(orig) = cand.original_year {
            let max_span = (2026 - orig).abs().max(1) as f64;
            ((ly - cy).abs() as f64 / max_span).clamp(0.0, 1.0)
        } else {
            1.0
        };
        strict.add("year", y_pen);
        relaxed.add("year", y_pen);
    }

    for (_, _, td) in pairs {
        let d = td.distance();
        strict.add("tracks", d);
        relaxed.add("tracks", d);
    }

    let missing_count = cand.tracks.len().saturating_sub(pairs.len());
    for _ in 0..missing_count {
        strict.add("missing_tracks", 1.0);
        relaxed.add("missing_tracks", 1.0);
    }

    for _ in 0..unmatched_local_count {
        strict.add("unmatched_tracks", 1.0);
        relaxed.add("unmatched_tracks", 1.0);
    }

    let ds_pen = data_source_penalty(&cand.provider);
    strict.add("data_source", ds_pen);
    relaxed.add("data_source", ds_pen);

    (strict, relaxed)
}

fn has_multi_soundtrack_cues(local: &LocalAlbum) -> bool {
    let orig_albums: HashSet<String> = local
        .tracks
        .iter()
        .filter_map(|t| t.original_album.as_deref())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if orig_albums.len() > 1 {
        return true;
    }
    let title = local.title.trim();
    if title.contains(" / ") && title.split(" / ").filter(|p| !p.trim().is_empty()).count() >= 2 {
        return true;
    }
    false
}

fn has_strong_track_corroboration(
    local: &LocalAlbum,
    cand: &CandidateAlbum,
    pairs: &[(usize, usize, Distance)],
) -> bool {
    if pairs.is_empty() || pairs.len() != local.tracks.len() || pairs.len() != cand.tracks.len() {
        return false;
    }
    let avg_td = pairs.iter().map(|(_, _, td)| td.distance()).sum::<f64>() / pairs.len() as f64;
    let non_placeholder_titles = pairs
        .iter()
        .filter(|(li, _, _)| !is_placeholder_value(&local.tracks[*li].title))
        .count();
    let mut duration_checks = 0usize;
    let mut duration_close = 0usize;
    for (li, ci, _) in pairs {
        if let Some(cd) = cand.tracks[*ci].duration_secs.filter(|&d| d > 0.0) {
            let ld = local.tracks[*li].duration_secs;
            if ld > 0.0 {
                duration_checks += 1;
                if (ld - cd).abs() <= 5.0 {
                    duration_close += 1;
                }
            }
        }
    }
    if pairs.len() >= 2 {
        return avg_td <= 0.12 && (non_placeholder_titles >= 2 || duration_close == pairs.len());
    }
    non_placeholder_titles == 1 && duration_checks == 1 && duration_close == 1 && avg_td <= 0.12
}

struct ScoredCandidate<'a> {
    cand: &'a CandidateAlbum,
    pairs: Vec<(usize, usize, Distance)>,
    strict_dist: Distance,
    relaxed_dist: Distance,
}

pub fn evaluate_album_candidates(
    local: &LocalAlbum,
    candidates: &[CandidateAlbum],
) -> MatchEvaluation {
    if candidates.is_empty() || local.tracks.is_empty() {
        return MatchEvaluation {
            outcome: MatchOutcome::NoMatch,
            distance: 1.0,
            effective_distance: 1.0,
            runner_up_distance: None,
            vetoes: Vec::new(),
            proposal: None,
        };
    }

    let mut scored: Vec<ScoredCandidate<'_>> = candidates
        .iter()
        .filter(|c| !c.tracks.is_empty())
        .map(|cand| {
            let (pairs, extra_local, _) = assign_tracks(&local.tracks, &cand.tracks, cand.is_va);
            let (strict_dist, relaxed_dist) =
                compute_album_distance_pair(local, cand, &pairs, extra_local.len());
            ScoredCandidate {
                cand,
                pairs,
                strict_dist,
                relaxed_dist,
            }
        })
        .collect();

    if scored.is_empty() {
        return MatchEvaluation {
            outcome: MatchOutcome::NoMatch,
            distance: 1.0,
            effective_distance: 1.0,
            runner_up_distance: None,
            vetoes: Vec::new(),
            proposal: None,
        };
    }

    scored.sort_by(|a, b| {
        a.relaxed_dist
            .distance()
            .partial_cmp(&b.relaxed_dist.distance())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                a.strict_dist
                    .distance()
                    .partial_cmp(&b.strict_dist.distance())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let best = &scored[0];
    let strict_d = best.strict_dist.distance();
    let relaxed_d = best.relaxed_dist.distance();
    let runner_up = scored.get(1);
    let runner_up_distance = runner_up.map(|r| r.relaxed_dist.distance());

    let local_is_va_or_comp =
        local.is_compilation || is_va_artist(&local.artist) || has_multi_soundtrack_cues(local);

    let mut vetoes = Vec::new();

    // Veto 1: Track count mismatch
    if local.tracks.len() != best.cand.tracks.len() || best.pairs.len() != local.tracks.len() {
        vetoes.push(VetoReason {
            code: VetoCode::TrackCountMismatch,
            message: format!(
                "Track count mismatch (local {} vs candidate {})",
                local.tracks.len(),
                best.cand.tracks.len()
            ),
        });
    }

    // Veto 2: Duration mismatch
    let mut max_dur_diff = 0.0_f64;
    let mut outside_grace = 0usize;
    let mut checked_dur = 0usize;
    for &(li, ci, _) in &best.pairs {
        let ld = local.tracks[li].duration_secs;
        if let Some(cd) = best.cand.tracks[ci].duration_secs.filter(|&d| d > 0.0) {
            if ld > 0.0 {
                checked_dur += 1;
                let diff = (ld - cd).abs();
                max_dur_diff = max_dur_diff.max(diff);
                if diff > TRACK_LENGTH_GRACE_SECS {
                    outside_grace += 1;
                }
            }
        }
    }
    if max_dur_diff > TRACK_LENGTH_HARD_VETO_SECS
        || (checked_dur > 0 && (outside_grace as f64 / checked_dur as f64) > 0.25)
    {
        vetoes.push(VetoReason {
            code: VetoCode::DurationMismatch,
            message: format!(
                "Track duration drift exceeds safety bounds (max diff {:.1}s, {}/{} outside 10s grace)",
                max_dur_diff, outside_grace, checked_dur
            ),
        });
    }

    // Veto 3: Ambiguous runner-up
    let has_missing_release_fields =
        is_placeholder_value(&local.title) || is_placeholder_value(&local.artist);
    let gap_thresh = if has_missing_release_fields {
        RELAXED_RUNNER_UP_GAP
    } else {
        STRICT_RUNNER_UP_GAP
    };
    if let Some(ru) = runner_up {
        let gap = ru.relaxed_dist.distance() - relaxed_d;
        let conflicting_identity =
            string_dist(Some(&best.cand.album), Some(&ru.cand.album)) > 0.08
                || string_dist(Some(&best.cand.artist), Some(&ru.cand.artist)) > 0.08;
        if gap < gap_thresh && conflicting_identity {
            vetoes.push(VetoReason {
                code: VetoCode::AmbiguousRunnerUp,
                message: format!(
                    "Runner-up candidate '{}-{}' is too close (gap {:.3} < {:.2})",
                    ru.cand.artist, ru.cand.album, gap, gap_thresh
                ),
            });
        }
    }

    // Veto 4: Compilation / VA / Multi-soundtrack flip
    if (local_is_va_or_comp != best.cand.is_va) || has_multi_soundtrack_cues(local) {
        vetoes.push(VetoReason {
            code: VetoCode::CompilationOrVaFlip,
            message: "Refusing automatic change across Compilation / Various Artists / multi-soundtrack boundary".into(),
        });
    }

    // Veto 5: Destructive empty/placeholder replacement
    let mut destructive = false;
    if !is_placeholder_value(&local.title) && is_placeholder_value(&best.cand.album) {
        destructive = true;
    }
    if !is_placeholder_value(&local.artist) && is_placeholder_value(&best.cand.artist) {
        destructive = true;
    }
    for &(li, ci, _) in &best.pairs {
        if !is_placeholder_value(&local.tracks[li].artist)
            && is_placeholder_value(&best.cand.tracks[ci].artist)
        {
            destructive = true;
            break;
        }
    }
    if destructive {
        vetoes.push(VetoReason {
            code: VetoCode::DestructiveOrEmptyReplacement,
            message: "Candidate would replace a populated tag with an empty or placeholder value".into(),
        });
    }

    // Veto 6: Severe text divergence on populated album / album artist without strong track proof
    let avg_track_dist = if best.pairs.is_empty() {
        1.0
    } else {
        best.pairs.iter().map(|(_, _, td)| td.distance()).sum::<f64>() / best.pairs.len() as f64
    };
    let album_div = if !is_placeholder_value(&local.title) {
        string_dist(Some(&local.title), Some(&best.cand.album))
    } else {
        0.0
    };
    let artist_div = if !is_placeholder_value(&local.artist) && !best.cand.is_va {
        string_dist(Some(&local.artist), Some(&best.cand.artist))
    } else {
        0.0
    };
    let strongly_corroborated =
        local.tracks.len() >= 3 && avg_track_dist <= 0.08 && max_dur_diff <= 5.0;
    if (album_div > 0.50 || artist_div > 0.50) && !strongly_corroborated {
        vetoes.push(VetoReason {
            code: VetoCode::SevereTextDivergence,
            message: format!(
                "Candidate diverges sharply from existing tags (album {:.2}, artist {:.2})",
                album_div, artist_div
            ),
        });
    }

    // Veto 7: User action history lock
    if local.album_locked {
        vetoes.push(VetoReason {
            code: VetoCode::UserHistoryLocked,
            message: "Album has explicit user edit/revert history locking automated updates".into(),
        });
    }

    let corroborates_missing = has_strong_track_corroboration(local, best.cand, &best.pairs);

    // Evaluate per-field decisions with asymmetric thresholds
    let mut auto_apply_release_fields = Vec::new();
    let mut review_release_fields = Vec::new();

    let eval_release_field = |field_key: &str,
                              local_val: &str,
                              cand_val: &str,
                              auto_fields: &mut Vec<String>,
                              rev_fields: &mut Vec<String>| {
        if cand_val.trim().is_empty() || is_placeholder_value(cand_val) {
            return;
        }
        if local_val.trim() == cand_val.trim() {
            return;
        }
        if local.locked_release_fields.contains(field_key) || local.album_locked {
            return;
        }
        let is_missing = is_placeholder_value(local_val);
        let eligible = if is_missing {
            relaxed_d <= RELAXED_MISSING_THRESHOLD && corroborates_missing
        } else {
            strict_d <= STRICT_OVERWRITE_THRESHOLD
        };
        if vetoes.is_empty() && eligible {
            auto_fields.push(field_key.to_string());
        } else {
            rev_fields.push(field_key.to_string());
        }
    };

    eval_release_field(
        "album",
        &local.title,
        &best.cand.album,
        &mut auto_apply_release_fields,
        &mut review_release_fields,
    );
    eval_release_field(
        "album_artist",
        &local.artist,
        &best.cand.artist,
        &mut auto_apply_release_fields,
        &mut review_release_fields,
    );

    if let Some(cy) = best.cand.year.or(best.cand.original_year) {
        if local.year.unwrap_or(0) < 1889 && !local.locked_release_fields.contains("year") && !local.album_locked {
            if vetoes.is_empty() && relaxed_d <= RELAXED_MISSING_THRESHOLD && corroborates_missing {
                auto_apply_release_fields.push("year".to_string());
            } else {
                review_release_fields.push("year".to_string());
            }
        }
        let _ = cy;
    }

    let mut track_proposals = Vec::with_capacity(best.pairs.len());
    let mut any_track_auto = false;
    let mut any_track_review = false;

    for &(li, ci, ref td) in &best.pairs {
        let lt = &local.tracks[li];
        let ct = &best.cand.tracks[ci];
        let mut auto_fields = Vec::new();
        let mut rev_fields = Vec::new();

        if !ct.artist.trim().is_empty()
            && !is_placeholder_value(&ct.artist)
            && lt.artist.trim() != ct.artist.trim()
            && !lt.locked_fields.contains("track_artist")
            && !local.album_locked
        {
            let is_missing = is_placeholder_value(&lt.artist);
            let eligible = if is_missing {
                relaxed_d <= RELAXED_MISSING_THRESHOLD && corroborates_missing
            } else {
                strict_d <= STRICT_OVERWRITE_THRESHOLD
            };
            if vetoes.is_empty() && eligible {
                auto_fields.push("track_artist".to_string());
                any_track_auto = true;
            } else {
                rev_fields.push("track_artist".to_string());
                any_track_review = true;
            }
        }

        // Track title is auto-filled ONLY when currently empty/placeholder
        if !ct.title.trim().is_empty()
            && !is_placeholder_value(&ct.title)
            && is_placeholder_value(&lt.title)
            && lt.title.trim() != ct.title.trim()
            && !lt.locked_fields.contains("track_title")
            && !local.album_locked
        {
            if vetoes.is_empty() && relaxed_d <= RELAXED_MISSING_THRESHOLD && corroborates_missing {
                auto_fields.push("track_title".to_string());
                any_track_auto = true;
            } else {
                rev_fields.push("track_title".to_string());
                any_track_review = true;
            }
        }

        track_proposals.push(TrackProposal {
            local_track_id: lt.track_id.clone(),
            candidate_title: ct.title.clone(),
            candidate_artist: ct.artist.clone(),
            proposed_title: (lt.title.trim() != ct.title.trim()).then(|| ct.title.clone()),
            proposed_artist: (lt.artist.trim() != ct.artist.trim()).then(|| ct.artist.clone()),
            track_distance: (td.distance() * 10_000.0).round() / 10_000.0,
            auto_apply_fields: auto_fields,
            review_fields: rev_fields,
        });
    }

    let in_review_band = relaxed_d <= REVIEW_THRESHOLD || strict_d <= REVIEW_THRESHOLD || !vetoes.is_empty();
    let has_auto_changes = !auto_apply_release_fields.is_empty() || any_track_auto;
    let has_review_changes = !review_release_fields.is_empty() || any_track_review;

    let outcome = if relaxed_d > REVIEW_THRESHOLD && strict_d > REVIEW_THRESHOLD && vetoes.iter().all(|v| v.code != VetoCode::UserHistoryLocked) {
        MatchOutcome::NoMatch
    } else if has_review_changes || (!vetoes.is_empty() && in_review_band) {
        // Note: if `has_auto_changes` is also true (e.g., empty fields fixed while overwrite fields wait for review),
        // the worker applies `auto_apply_*` fields AND marks album `needs_review` so the user can approve overwrite fields.
        MatchOutcome::NeedsReview
    } else if vetoes.is_empty() && (has_auto_changes || strict_d <= STRICT_OVERWRITE_THRESHOLD || (relaxed_d <= RELAXED_MISSING_THRESHOLD && corroborates_missing)) {
        MatchOutcome::AutoApply
    } else {
        MatchOutcome::NoMatch
    };

    let proposal = if matches!(outcome, MatchOutcome::AutoApply | MatchOutcome::NeedsReview) {
        Some(AlbumProposal {
            provider: best.cand.provider.clone(),
            external_release_id: best.cand.external_release_id.clone(),
            album: Some(best.cand.album.clone()),
            album_artist: Some(best.cand.artist.clone()),
            year: best.cand.year.or(best.cand.original_year),
            composer: best.cand.composer.clone(),
            genre: best.cand.genre.clone(),
            artwork_url: best.cand.artwork_url.clone(),
            auto_apply_release_fields,
            review_release_fields,
            tracks: track_proposals,
            penalties: best.strict_dist.penalty_breakdown(),
        })
    } else {
        None
    };

    MatchEvaluation {
        outcome,
        distance: (strict_d * 10_000.0).round() / 10_000.0,
        effective_distance: (relaxed_d * 10_000.0).round() / 10_000.0,
        runner_up_distance: runner_up_distance.map(|d| (d * 10_000.0).round() / 10_000.0),
        vetoes,
        proposal,
    }
}
