use super::*;
use crate::session_management::tests::{A, B, C, fixture, rollout};
use crate::session_management::{PENDING, finish_pending, list};
use rusqlite::{Connection, params};
use serde_json::json;
use std::time::{Duration, UNIX_EPOCH};

const NOW: i64 = 2_000_000_000_000;

fn age(path: &Path, timestamp: i64) {
    fs::OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(UNIX_EPOCH + Duration::from_millis(timestamp.try_into().unwrap())),
        )
        .unwrap();
}

fn request(home: &Path, enabled: bool, days: u32) -> SavePolicyRequest {
    SavePolicyRequest {
        policy: CleanupPolicy {
            enabled,
            retention_days: days,
        },
        revision: policy_revision(&read_policy(home).unwrap()).unwrap(),
        confirmed: true,
    }
}

fn set_policy(home: &Path, enabled: bool, days: u32) {
    fs::write(
        home.join(POLICY),
        json!({"enabled":enabled,"retentionDays":days}).to_string(),
    )
    .unwrap();
}

#[test]
fn missing_or_disabled_policy_never_scans_or_creates_storage() {
    let home = tempfile::tempdir().unwrap();
    let missing = home.path().join("missing");
    assert!(automatic_cleanup(&missing, NOW).unwrap().is_none());
    assert!(!missing.exists());
    assert_eq!(read_policy(&missing).unwrap(), CleanupPolicy::default());
    fs::write(home.path().join("state_5.sqlite"), "not a database").unwrap();
    set_policy(home.path(), false, 30);
    assert!(automatic_cleanup(home.path(), NOW).unwrap().is_none());
    assert!(!home.path().join(PENDING).exists());
    assert!(!home.path().join(".codey-session-cleanup.lock").exists());
}

#[test]
fn policy_save_round_trips_and_rejects_stale_or_unconfirmed_writes() {
    let home = tempfile::tempdir().unwrap();
    let stale = request(home.path(), true, 30);
    let saved = save_policy(home.path(), request(home.path(), false, 7), NOW).unwrap();
    assert_eq!(saved.policy.retention_days, 7);
    assert_eq!(saved.revision, policy_revision(&saved.policy).unwrap());
    assert!(saved.cleanup.is_none());
    assert!(saved.cleanup_error.is_none());
    assert_eq!(list(home.path()).unwrap().cleanup_policy, saved.policy);
    assert!(save_policy(home.path(), stale, NOW).is_err());
    let mut unconfirmed = request(home.path(), true, 30);
    unconfirmed.confirmed = false;
    assert!(save_policy(home.path(), unconfirmed, NOW).is_err());
    assert_eq!(read_policy(home.path()).unwrap().retention_days, 7);
    assert!(!home.path().join(PENDING).exists());
}

#[test]
fn invalid_policy_is_rejected_before_files_or_deletions() {
    let home = tempfile::tempdir().unwrap();
    for days in [0, 36_501, u32::MAX] {
        let absent = home.path().join(format!("missing-{days}"));
        assert!(save_policy(&absent, request(&absent, true, days), NOW).is_err());
        assert!(!absent.exists());
    }
    for days in [json!(-1), json!(1.5), json!("30"), json!(null)] {
        assert!(
            serde_json::from_value::<SavePolicyRequest>(json!({
                "policy":{"enabled":true,"retentionDays":days},
                "revision":"fixture", "confirmed":true,
            }))
            .is_err()
        );
    }
    save_policy(home.path(), request(home.path(), false, 36_500), NOW).unwrap();
    assert_eq!(read_policy(home.path()).unwrap().retention_days, 36_500);
}

#[test]
fn cutoff_is_strict_and_unknown_and_future_sessions_are_retained() {
    let home = tempfile::tempdir().unwrap();
    let cutoff = NOW - 30 * DAY_MS;
    age(&rollout(home.path(), A, true), cutoff - 1);
    age(&rollout(home.path(), B, false), cutoff);
    age(&rollout(home.path(), C, false), NOW + DAY_MS);
    let unknown = "44444444-4444-4444-8444-444444444444";
    fs::write(
        home.path().join("history.jsonl"),
        format!("{}\n", json!({"session_id":unknown})),
    )
    .unwrap();

    let saved = save_policy(home.path(), request(home.path(), true, 30), NOW).unwrap();
    let result = saved.cleanup.unwrap();
    assert_eq!(result.selected_count, 1);
    assert!(result.restart_required);
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert!(saved.cleanup_error.is_none());
    let sessions = list(home.path()).unwrap().sessions;
    assert!(!sessions.iter().any(|session| session.id == A));
    for id in [B, C, unknown] {
        assert!(sessions.iter().any(|session| session.id == id), "{id}");
    }
    finish_pending(home.path()).unwrap();
    assert!(!home.path().join(PENDING).exists());
    assert!(automatic_cleanup(home.path(), NOW).unwrap().is_none());
}

#[test]
fn latest_database_or_file_activity_protects_both_sources() {
    let home = fixture();
    age(&rollout(home.path(), A, false), NOW - 31 * DAY_MS);
    age(&rollout(home.path(), B, true), NOW - DAY_MS);
    let db = Connection::open(home.path().join("state_5.sqlite")).unwrap();
    db.execute(
        "UPDATE threads SET updated_at=?1 WHERE id=?2",
        params![(NOW - DAY_MS) / 1000, A],
    )
    .unwrap();
    db.execute(
        "UPDATE threads SET updated_at=?1 WHERE id=?2",
        params![(NOW - 31 * DAY_MS) / 1000, B],
    )
    .unwrap();
    drop(db);
    set_policy(home.path(), true, 30);
    assert!(automatic_cleanup(home.path(), NOW).unwrap().is_none());
    assert_eq!(list(home.path()).unwrap().sessions.len(), 2);
    assert!(!home.path().join(PENDING).exists());
}

#[test]
fn database_milliseconds_and_seconds_use_the_same_retention_cutoff() {
    for field in ["updated_at", "updated_at_ms", "source_updated_at"] {
        let home = tempfile::tempdir().unwrap();
        let db = Connection::open(home.path().join("state_5.sqlite")).unwrap();
        db.execute_batch(&format!(
            "CREATE TABLE threads (id TEXT, {field} INTEGER, archived INTEGER)"
        ))
        .unwrap();
        let divisor = if field == "updated_at_ms" { 1 } else { 1000 };
        db.execute(
            "INSERT INTO threads VALUES (?1, ?2, 1)",
            params![A, (NOW - 31 * DAY_MS) / divisor],
        )
        .unwrap();
        db.execute(
            "INSERT INTO threads VALUES (?1, ?2, 0)",
            params![B, (NOW - DAY_MS) / divisor],
        )
        .unwrap();
        drop(db);
        set_policy(home.path(), true, 30);
        let result = automatic_cleanup(home.path(), NOW).unwrap().unwrap();
        assert_eq!(result.selected_count, 1, "{field}");
        assert!(result.errors.is_empty(), "{field}: {:?}", result.errors);
        finish_pending(home.path()).unwrap();
        assert_eq!(list(home.path()).unwrap().sessions[0].id, B);
    }
}

#[test]
fn latest_timestamp_wins_when_database_columns_coexist() {
    let home = tempfile::tempdir().unwrap();
    let recent = NOW - DAY_MS;
    let old = NOW - 31 * DAY_MS;
    for id in [A, B, C] {
        age(&rollout(home.path(), id, false), old);
    }
    let db = Connection::open(home.path().join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE threads (id TEXT, updated_at_ms INTEGER, updated_at INTEGER, source_updated_at INTEGER)").unwrap();
    for (id, millis, seconds, source) in [
        (A, None, recent / 1000, 0),
        (B, Some(old), recent / 1000, 0),
        (C, Some(old), old / 1000, recent / 1000),
    ] {
        db.execute(
            "INSERT INTO threads VALUES (?1, ?2, ?3, ?4)",
            params![id, millis, seconds, source],
        )
        .unwrap();
    }
    drop(db);
    set_policy(home.path(), true, 30);
    assert!(automatic_cleanup(home.path(), NOW).unwrap().is_none());
    let sessions = list(home.path()).unwrap().sessions;
    assert_eq!(sessions.len(), 3);
    assert!(sessions.iter().all(|session| session.updated_at == recent));
    assert!(!home.path().join(PENDING).exists());
}

#[test]
fn periodic_cleanup_reloads_policy_and_preserves_recovery_scope() {
    let home = tempfile::tempdir().unwrap();
    age(&rollout(home.path(), A, false), NOW - 31 * DAY_MS);
    set_policy(home.path(), false, 30);
    assert!(automatic_cleanup(home.path(), NOW).unwrap().is_none());
    set_policy(home.path(), true, 30);
    assert_eq!(
        automatic_cleanup(home.path(), NOW)
            .unwrap()
            .unwrap()
            .selected_count,
        1
    );
    rollout(home.path(), C, false);
    rollout(home.path(), A, true);
    finish_pending(home.path()).unwrap();
    assert_eq!(list(home.path()).unwrap().sessions[0].id, C);
    set_policy(home.path(), false, 30);
    assert!(
        automatic_cleanup(home.path(), NOW + 40 * DAY_MS)
            .unwrap()
            .is_none()
    );
}

#[test]
fn saved_policy_survives_cleanup_failure_without_claiming_save_failed() {
    let home = tempfile::tempdir().unwrap();
    let path = rollout(home.path(), A, false);
    age(&path, NOW - 31 * DAY_MS);
    fs::write(home.path().join("state_5.sqlite"), "not a database").unwrap();
    let result = save_policy(home.path(), request(home.path(), true, 30), NOW).unwrap();
    assert!(result.policy.enabled);
    assert!(read_policy(home.path()).unwrap().enabled);
    assert!(result.cleanup.is_none());
    assert!(result.cleanup_error.is_some());
    assert!(path.exists());
    assert!(!home.path().join(PENDING).exists());
}

#[test]
fn partial_cleanup_keeps_pending_and_reports_errors_after_policy_save() {
    let home = fixture();
    for (id, archived) in [(A, false), (B, true)] {
        age(&rollout(home.path(), id, archived), NOW - 31 * DAY_MS);
    }
    let db = Connection::open(home.path().join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER block_delete BEFORE DELETE ON threads BEGIN SELECT RAISE(ABORT, 'fixture locked'); END;").unwrap();
    let result = save_policy(home.path(), request(home.path(), true, 30), NOW).unwrap();
    assert!(!result.cleanup.unwrap().errors.is_empty());
    assert!(result.cleanup_error.is_none());
    assert!(home.path().join(PENDING).exists());
    db.execute_batch("DROP TRIGGER block_delete").unwrap();
    drop(db);
    // 损坏的自动策略不能阻断已确认删除任务的恢复。
    fs::write(home.path().join(POLICY), "{broken").unwrap();
    finish_pending(home.path()).unwrap();
    assert!(!home.path().join(PENDING).exists());
}

#[test]
fn corrupt_or_unsupported_policy_cannot_delete_or_overwrite_data() {
    for policy in [
        "{broken",
        "{\"enabled\":true,\"retentionDays\":0}",
        "{\"enabled\":true,\"retentionDays\":36501}",
    ] {
        let home = tempfile::tempdir().unwrap();
        let path = rollout(home.path(), A, false);
        age(&path, NOW - 31 * DAY_MS);
        let request = request(home.path(), true, 30);
        fs::write(home.path().join(POLICY), policy).unwrap();
        assert!(automatic_cleanup(home.path(), NOW).is_err());
        assert!(save_policy(home.path(), request, NOW).is_err());
        assert_eq!(
            fs::read_to_string(home.path().join(POLICY)).unwrap(),
            policy
        );
        assert!(path.exists());
        assert!(!home.path().join(PENDING).exists());
    }
}

#[test]
fn failed_policy_save_does_not_start_cleanup() {
    let home = tempfile::tempdir().unwrap();
    let path = rollout(home.path(), A, false);
    age(&path, NOW - 31 * DAY_MS);
    let request = request(home.path(), true, 30);
    fs::create_dir(home.path().join(POLICY)).unwrap();
    assert!(save_policy(home.path(), request, NOW).is_err());
    assert!(path.exists());
    assert!(!home.path().join(PENDING).exists());
}

#[test]
fn linked_policy_is_rejected_without_touching_its_target() {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("policy.json");
    let original = "{\"enabled\":true,\"retentionDays\":30}";
    fs::write(&target, original).unwrap();
    let request = request(home.path(), true, 30);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, home.path().join(POLICY)).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&target, home.path().join(POLICY)).unwrap();
    assert!(automatic_cleanup(home.path(), NOW).is_err());
    assert!(save_policy(home.path(), request, NOW).is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), original);
    assert!(!home.path().join(PENDING).exists());
}
