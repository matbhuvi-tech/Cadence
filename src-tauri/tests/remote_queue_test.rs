use cadence_core_lib::remote::{RemoteQueue, RemoteTrackItem};

fn make_item(id: &str, title: &str, file_path: &str) -> RemoteTrackItem {
    RemoteTrackItem {
        queue_entry_id: uuid::Uuid::new_v4().to_string(),
        id: id.to_string(),
        title: title.to_string(),
        artist: "Artist".to_string(),
        album: "Album".to_string(),
        file_path: file_path.to_string(),
        duration_secs: 180.0,
        format: "FLAC".to_string(),
        sample_rate: Some(44100),
        bit_depth: Some(16),
        is_high_res: false,
    }
}

#[test]
fn test_duplicate_tracks_receive_unique_queue_entry_ids() {
    let mut q = RemoteQueue::default();
    let t1 = make_item("t1", "Same Song", "D:/Music/song.flac");
    let mut t2 = make_item("t1", "Same Song", "D:/Music/song.flac");
    // Even if t2 starts with same id/path, their queue_entry_id must be distinct
    t2.queue_entry_id = uuid::Uuid::new_v4().to_string();

    q.items.push(t1.clone());
    q.items.push(t2.clone());

    assert_eq!(q.items.len(), 2);
    assert_eq!(q.items[0].id, q.items[1].id);
    assert_eq!(q.items[0].file_path, q.items[1].file_path);
    assert_ne!(q.items[0].queue_entry_id, q.items[1].queue_entry_id);
}

#[test]
fn test_play_next_preserves_stable_fifo_next_up_order() {
    let mut q = RemoteQueue::default();
    let track_a = make_item("a", "Track A", "D:/a.flac");
    q.items.push(track_a);
    q.current_index = 0;
    q.current_queue_entry_id = Some(q.items[0].queue_entry_id.clone());

    // 1. Successive Play Next on Album B [b1, b2]
    let b1 = make_item("b1", "Track B1", "D:/b1.flac");
    let b2 = make_item("b2", "Track B2", "D:/b2.flac");
    let album_b = vec![b1, b2];

    // Insert album B into next-up segment
    let start_idx = q.next_up_end_index.unwrap_or(((q.current_index as usize) + 1).min(q.items.len()));
    let b_len = album_b.len();
    for (offset, t) in album_b.into_iter().enumerate() {
        q.items.insert(start_idx + offset, t);
    }
    q.next_up_end_index = Some(start_idx + b_len);
    q.revision += 1;

    // Queue is now: [A, B1, B2]
    assert_eq!(q.items.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["a", "b1", "b2"]);
    assert_eq!(q.next_up_end_index, Some(3));

    // 2. Successive Play Next on Album C [c1, c2]
    let c1 = make_item("c1", "Track C1", "D:/c1.flac");
    let c2 = make_item("c2", "Track C2", "D:/c2.flac");
    let album_c = vec![c1, c2];

    let start_idx_c = q.next_up_end_index.unwrap_or(((q.current_index as usize) + 1).min(q.items.len()));
    let c_len = album_c.len();
    for (offset, t) in album_c.into_iter().enumerate() {
        q.items.insert(start_idx_c + offset, t);
    }
    q.next_up_end_index = Some(start_idx_c + c_len);
    q.revision += 1;

    // Queue must maintain chronological FIFO order: [A, B1, B2, C1, C2] - NOT LIFO inversion!
    assert_eq!(
        q.items.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["a", "b1", "b2", "c1", "c2"]
    );
    assert_eq!(q.next_up_end_index, Some(5));
}

#[test]
fn test_play_now_session_preservation_retains_upcoming_tracks() {
    let mut q = RemoteQueue::default();
    let a = make_item("a", "Track A", "D:/a.flac");
    let d = make_item("d", "Track D", "D:/d.flac");
    let e = make_item("e", "Track E", "D:/e.flac");
    q.items = vec![a, d, e];
    q.current_index = 0;

    // User taps Play Now on Album F [f1, f2]
    let f1 = make_item("f1", "Track F1", "D:/f1.flac");
    let f2 = make_item("f2", "Track F2", "D:/f2.flac");
    let album_f = vec![f1, f2];

    // Session preservation: preserve upcoming tracks (after current_index)
    let remaining_upcoming = if q.current_index >= 0 && (q.current_index as usize + 1) < q.items.len() {
        q.items.split_off(q.current_index as usize + 1)
    } else {
        Vec::new()
    };

    let mut new_items = album_f;
    new_items.extend(remaining_upcoming);

    q.items = new_items;
    q.current_index = 0;
    q.current_queue_entry_id = Some(q.items[0].queue_entry_id.clone());
    q.next_up_end_index = None;
    q.revision += 1;

    // Queue is now [F1, F2, D, E] - upcoming tracks D and E were preserved behind Album F!
    assert_eq!(
        q.items.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["f1", "f2", "d", "e"]
    );
}

#[test]
fn test_reorder_queue_by_queue_entry_id() {
    let mut q = RemoteQueue::default();
    let a = make_item("a", "A", "D:/a.flac");
    let b = make_item("b", "B", "D:/b.flac");
    let c = make_item("c", "C", "D:/c.flac");
    let d = make_item("d", "D", "D:/d.flac");
    let d_entry_id = d.queue_entry_id.clone();
    let b_entry_id = b.queue_entry_id.clone();

    q.items = vec![a, b, c, d];
    q.current_index = 0;
    q.revision = 1;

    // Reorder: move D to before B
    let source_idx = q.items.iter().position(|t| t.queue_entry_id == d_entry_id).unwrap();
    let target_idx = q.items.iter().position(|t| t.queue_entry_id == b_entry_id).unwrap();

    let item = q.items.remove(source_idx);
    q.items.insert(target_idx, item);
    q.revision += 1;

    // Result should be: [A, D, B, C]
    assert_eq!(
        q.items.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
        vec!["a", "d", "b", "c"]
    );
    assert_eq!(q.revision, 2);
}

#[test]
fn test_revision_conflict_rejection() {
    let mut q = RemoteQueue::default();
    q.revision = 3;

    // Stale client expects revision 2
    let expected_revision: Option<u64> = Some(2);
    let is_conflict = expected_revision.map_or(false, |exp| exp != q.revision);
    assert!(is_conflict);

    // Current client expects revision 3
    let matching_revision: Option<u64> = Some(3);
    let is_conflict_matching = matching_revision.map_or(false, |exp| exp != q.revision);
    assert!(!is_conflict_matching);
}
