use super::schema::ProviderGateSnapshot;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const BREAKER_THRESHOLD: u32 = 5;
pub const BREAKER_PROBE_AFTER: Duration = Duration::from_secs(60);
pub const BREAKER_RECOVERIES: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateOutcome {
    Success,
    NotFound,
    TransientError,
    RetryLater(Duration),
    Cancelled,
}

#[derive(Debug)]
struct Breaker {
    failures: u32,
    opened_at: Option<Instant>,
    recoveries: u32,
    generation: u64,
    probe_after: Option<Duration>,
}

impl Breaker {
    fn new() -> Self {
        Self {
            failures: 0,
            opened_at: None,
            recoveries: 0,
            generation: 0,
            probe_after: None,
        }
    }

    fn allow(&mut self, now: Instant) -> (bool, u64) {
        if self.failures < BREAKER_THRESHOLD {
            return (true, 0);
        }
        let wait = self.probe_after.unwrap_or(BREAKER_PROBE_AFTER);
        if let Some(opened) = self.opened_at {
            if now.saturating_duration_since(opened) >= wait {
                return (true, self.generation);
            }
        }
        (false, 0)
    }

    fn record(&mut self, gen: u64, outcome: GateOutcome, now: Instant) {
        match outcome {
            GateOutcome::Cancelled => {}
            GateOutcome::RetryLater(delay) => {
                let d = delay.max(Duration::from_secs(1));
                self.recoveries = 0;
                self.failures = BREAKER_THRESHOLD;
                self.opened_at = Some(now);
                self.probe_after = Some(d);
                self.generation += 1;
            }
            GateOutcome::TransientError => {
                self.recoveries = 0;
                self.failures = self.failures.saturating_add(1);
                if self.failures >= BREAKER_THRESHOLD {
                    self.opened_at = Some(now);
                    self.probe_after = None;
                    self.generation += 1;
                }
            }
            GateOutcome::Success | GateOutcome::NotFound => {
                if self.failures < BREAKER_THRESHOLD {
                    self.failures = 0;
                    return;
                }
                if gen == 0 || gen != self.generation {
                    return;
                }
                self.recoveries += 1;
                if self.recoveries >= BREAKER_RECOVERIES {
                    self.failures = 0;
                    self.recoveries = 0;
                    self.opened_at = None;
                    self.probe_after = None;
                }
            }
        }
    }

    fn snapshot(&self, provider: &str, now: Instant) -> ProviderGateSnapshot {
        let (circuit, retry_after_secs) = if self.failures < BREAKER_THRESHOLD {
            ("closed".to_string(), None)
        } else {
            let wait = self.probe_after.unwrap_or(BREAKER_PROBE_AFTER);
            let rem = self
                .opened_at
                .map(|o| wait.saturating_sub(now.saturating_duration_since(o)))
                .unwrap_or(Duration::ZERO);
            if rem.is_zero() {
                ("half_open".to_string(), Some(0))
            } else {
                ("open".to_string(), Some(rem.as_secs().max(1)))
            }
        };
        ProviderGateSnapshot {
            provider: provider.to_string(),
            circuit,
            consecutive_failures: self.failures,
            retry_after_secs,
        }
    }
}

#[derive(Debug)]
struct ProviderGateState {
    min_interval: Duration,
    last_call: Option<Instant>,
    breaker: Breaker,
}

#[derive(Debug)]
pub struct GateRegistry {
    providers: Mutex<HashMap<String, ProviderGateState>>,
}

impl Default for GateRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl GateRegistry {
    pub fn new() -> Self {
        let mut map = HashMap::new();
        map.insert(
            "musicbrainz".to_string(),
            ProviderGateState {
                min_interval: Duration::from_millis(1100),
                last_call: None,
                breaker: Breaker::new(),
            },
        );
        map.insert(
            "coverartarchive".to_string(),
            ProviderGateState {
                min_interval: Duration::from_millis(1100),
                last_call: None,
                breaker: Breaker::new(),
            },
        );
        map.insert(
            "apple_music".to_string(),
            ProviderGateState {
                min_interval: Duration::from_millis(1500),
                last_call: None,
                breaker: Breaker::new(),
            },
        );
        map.insert(
            "deezer".to_string(),
            ProviderGateState {
                min_interval: Duration::from_millis(350),
                last_call: None,
                breaker: Breaker::new(),
            },
        );
        map.insert(
            "wikimedia".to_string(),
            ProviderGateState {
                min_interval: Duration::from_millis(500),
                last_call: None,
                breaker: Breaker::new(),
            },
        );
        Self {
            providers: Mutex::new(map),
        }
    }

    pub fn try_acquire_at(&self, provider: &str, now: Instant) -> Result<(Duration, u64), Duration> {
        let mut guard = self.providers.lock();
        let entry = guard
            .entry(provider.to_string())
            .or_insert_with(|| ProviderGateState {
                min_interval: Duration::from_millis(1100),
                last_call: None,
                breaker: Breaker::new(),
            });
        let (allowed, gen) = entry.breaker.allow(now);
        if !allowed {
            let wait = entry
                .breaker
                .probe_after
                .unwrap_or(BREAKER_PROBE_AFTER)
                .saturating_sub(
                    entry
                        .breaker
                        .opened_at
                        .map(|o| now.saturating_duration_since(o))
                        .unwrap_or_default(),
                );
            return Err(wait.max(Duration::from_secs(1)));
        }
        let pace_wait = entry
            .last_call
            .map(|last| entry.min_interval.saturating_sub(now.saturating_duration_since(last)))
            .unwrap_or(Duration::ZERO);
        entry.last_call = Some(now + pace_wait);
        Ok((pace_wait, gen))
    }

    pub fn record_at(&self, provider: &str, gen: u64, outcome: GateOutcome, now: Instant) {
        let mut guard = self.providers.lock();
        if let Some(entry) = guard.get_mut(provider) {
            entry.breaker.record(gen, outcome, now);
        }
    }

    pub fn snapshot(&self) -> Vec<ProviderGateSnapshot> {
        let now = Instant::now();
        let guard = self.providers.lock();
        let mut list: Vec<ProviderGateSnapshot> = guard
            .iter()
            .map(|(name, st)| st.breaker.snapshot(name, now))
            .collect();
        list.sort_by(|a, b| a.provider.cmp(&b.provider));
        list
    }
}
