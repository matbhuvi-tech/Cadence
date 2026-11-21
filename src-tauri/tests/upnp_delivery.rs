use cadence_core_lib::core_runtime::upnp_delivery::{DeliveryHistory, DeliveryWriter};
use std::time::{Duration, Instant};

#[test]
fn capture_is_opt_in_bounded_and_stale_writers_cannot_pollute_it() {
    let history = DeliveryHistory::default();
    let now = Instant::now();
    let mut writer = DeliveryWriter::new(&history);
    writer.record_at(&history, now, 16000, 2800000);
    assert!(history.snapshot_at(now).is_none());
    let id = history.start_at(now);
    writer.record_at(&history, now + Duration::from_millis(1), 16000, 2800000);
    writer.record_at(&history, now + Duration::from_millis(201), 16000, 2800000);
    let snap = history
        .snapshot_at(now + Duration::from_millis(300))
        .unwrap();
    assert_eq!(snap.bins.len(), 3);
    assert_eq!(snap.bins[0].bytes, 16000);
    assert_eq!(snap.bins[1].bytes, 0);
    assert_eq!(snap.bins[2].max_gap_us, 200000);
    assert!(snap.bins[2].max_delay_us > 190000);
    assert!(!history.stop(id + 1));
    assert!(history.stop_at(id, now + Duration::from_millis(300)));
    writer.record_at(&history, now + Duration::from_millis(400), 16000, 2800000);
    assert_eq!(
        history
            .snapshot_at(now + Duration::from_millis(500))
            .unwrap()
            .bins
            .len(),
        3
    );
    let _new_writer = DeliveryWriter::new(&history);
    let id2 = history.start_at(now + Duration::from_secs(1));
    assert_ne!(id2, id);
    writer.record_at(&history, now + Duration::from_secs(2), 16000, 2800000);
    assert!(history
        .snapshot_at(now + Duration::from_secs(2))
        .unwrap()
        .bins
        .iter()
        .all(|b| b.bytes == 0));
    assert!(
        history
            .snapshot_at(now + Duration::from_secs(70))
            .unwrap()
            .complete
    );
    assert!(
        history
            .snapshot_at(now + Duration::from_secs(70))
            .unwrap()
            .bins
            .len()
            <= 600
    );
}

#[test]
fn intentional_low_bitrate_chunk_spacing_is_not_a_delivery_delay() {
    let history = DeliveryHistory::default();
    let now = Instant::now();
    let mut writer = DeliveryWriter::new(&history);
    history.start_at(now);
    writer.record_at(&history, now, 16384, 176400);
    writer.record_at(&history, now + Duration::from_micros(92880), 16384, 176400);
    let capture = history
        .snapshot_at(now + Duration::from_millis(100))
        .unwrap();
    assert!(capture.bins[0].max_gap_us > 90000);
    assert!(capture.bins[0].max_delay_us < 10);
}

#[test]
fn expired_capture_and_restart_are_isolated() {
    let history = DeliveryHistory::default();
    let now = Instant::now();
    let mut writer = DeliveryWriter::new(&history);
    history.start_at(now);
    writer.record_at(&history, now + Duration::from_secs(61), 16000, 1);
    assert!(history
        .snapshot_at(now + Duration::from_secs(62))
        .unwrap()
        .bins
        .iter()
        .all(|b| b.bytes == 0));
    history.start_at(now + Duration::from_secs(63));
    writer.record_at(&history, now + Duration::from_millis(63001), 1000, 10000);
    let capture = history
        .snapshot_at(now + Duration::from_millis(63050))
        .unwrap();
    assert_eq!(capture.bins[0].bytes, 1000);
    assert_eq!(capture.bins[0].max_gap_us, 0);
}
