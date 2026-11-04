//! Explicit, reversible Inspector repair for standalone Windows installations.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    FUSE_SENTINEL, NODE_CLI_INSPECT_FUSE_INDEX, normalized_digest, open_runtime_exclusive,
    scan_fuse_wire,
};

pub(crate) struct InspectorRepairPlan {
    binary: PathBuf,
    backup: PathBuf,
    cache: PathBuf,
    inspection: Inspection,
    identity: (
        u64,
        Option<std::time::SystemTime>,
        Option<std::time::SystemTime>,
    ),
    app_identity: Option<(PathBuf, String)>,
}

impl InspectorRepairPlan {
    pub(crate) fn requires_change(&self) -> bool {
        self.inspection.current == b'0'
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectorRepairOutcome {
    pub(crate) changed: bool,
    pub(crate) binary: PathBuf,
    pub(crate) backup: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
struct Inspection {
    offset: u64,
    current: u8,
    digest: String,
    normalized: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    format: u8,
    binary: PathBuf,
    offset: u64,
    original: u8,
    original_sha256: String,
    normalized_sha256: String,
}

fn digest(file: &mut File) -> Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn inspect(file: &mut File) -> Result<Inspection> {
    file.seek(SeekFrom::Start(0))?;
    let (sentinel, wire) = scan_fuse_wire(file, true)?.context("运行时没有 Electron fuse wire")?;
    anyhow::ensure!(
        wire.version == 1 && (4..=9).contains(&wire.states.len()),
        "不支持的 Electron fuse wire 版本或长度，未修改运行时"
    );
    let current = wire.states.as_bytes()[NODE_CLI_INSPECT_FUSE_INDEX];
    anyhow::ensure!(
        matches!(current, b'0' | b'1'),
        "Inspector fuse 已移除，无法修复"
    );
    let offset = sentinel + FUSE_SENTINEL.len() as u64 + 2 + NODE_CLI_INSPECT_FUSE_INDEX as u64;
    let digest = digest(file)?;
    let normalized = if current == b'0' {
        digest.clone()
    } else {
        normalized_digest(file, offset)?
    };
    Ok(Inspection {
        offset,
        current,
        digest,
        normalized,
    })
}

fn reject_store(path: &Path) -> Result<()> {
    anyhow::ensure!(
        !path.components().any(|part| part
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("WindowsApps")),
        "Microsoft Store 安装不支持 Inspector 修复，请选择独立安装的 Codex"
    );
    Ok(())
}

pub(crate) fn prepare_inspector_repair(app_dir: &Path) -> Result<InspectorRepairPlan> {
    let app_dir = codey_runtime_core::app_paths::normalize_codex_app_path(app_dir)
        .context("无效的 Codex 安装目录")?;
    let app_dir = fs::canonicalize(app_dir).context("找不到 Codex 安装目录")?;
    reject_store(&app_dir)?;
    codey_runtime_core::app_paths::validate_codex_app_dir(&app_dir)?;
    anyhow::ensure!(
        app_dir
            .extension()
            .is_none_or(|extension| extension != "app")
            && codey_runtime_core::app_paths::packaged_app_full_name(&app_dir).is_none(),
        "Inspector 修复仅支持 Windows 独立安装"
    );
    let version = codey_runtime_core::app_paths::codex_app_version(&app_dir)
        .context("无法确认 Codex 应用版本")?;
    let (binary, _, _) = super::electron_runtime_with_wire(&app_dir, None)?;
    let binary = fs::canonicalize(binary).context("找不到 Electron 运行时")?;
    reject_store(&binary)?;
    anyhow::ensure!(
        binary.starts_with(&app_dir),
        "Electron 运行时不在所选 Codex 目录中"
    );
    let state = codey_runtime_core::paths::default_app_state_dir();
    let backup = state
        .join("inspector-backups")
        .join(crate::fs_util::sha256_hex_str(&binary.to_string_lossy()));
    let mut plan = prepare(
        binary,
        |inspection| backup.join(&inspection.normalized),
        state.join(super::CACHE_FILE),
    )?;
    plan.app_identity = Some((app_dir, version));
    Ok(plan)
}

fn prepare(
    binary: PathBuf,
    backup: impl FnOnce(&Inspection) -> PathBuf,
    cache: PathBuf,
) -> Result<InspectorRepairPlan> {
    let mut file = File::open(&binary).context("读取 Electron 运行时失败")?;
    let identity = identity(&file)?;
    let inspection = inspect(&mut file)?;
    anyhow::ensure!(
        identity == self::identity(&file)?,
        "预检期间 Electron 运行时已变化"
    );
    let backup = backup(&inspection);
    if backup.try_exists()? {
        validate_backup(&binary, &backup, &inspection)?;
    }
    Ok(InspectorRepairPlan {
        binary,
        backup,
        cache,
        inspection,
        identity,
        app_identity: None,
    })
}

fn identity(
    file: &File,
) -> Result<(
    u64,
    Option<std::time::SystemTime>,
    Option<std::time::SystemTime>,
)> {
    let metadata = file.metadata()?;
    anyhow::ensure!(metadata.is_file(), "Electron 运行时不是普通文件");
    Ok((
        metadata.len(),
        metadata.created().ok(),
        metadata.modified().ok(),
    ))
}

fn reopen(plan: &InspectorRepairPlan) -> Result<File> {
    if let Some((directory, version)) = &plan.app_identity {
        codey_runtime_core::app_paths::validate_codex_app_dir(directory)?;
        anyhow::ensure!(
            codey_runtime_core::app_paths::codex_app_version(directory).as_ref() == Some(version),
            "预检后 Codex 应用版本已变化，请重新检查"
        );
    }
    anyhow::ensure!(
        fs::canonicalize(&plan.binary)? == plan.binary,
        "Electron 运行时路径已变化"
    );
    let file = open_runtime_exclusive(&plan.binary)
        .context("无法独占运行时；请关闭 Codex 并确认文件写入权限")?;
    anyhow::ensure!(
        identity(&file)? == plan.identity,
        "预检后 Electron 运行时文件身份已变化，请重新检查"
    );
    Ok(file)
}

fn validate_backup(binary: &Path, backup: &Path, current: &Inspection) -> Result<Backup> {
    anyhow::ensure!(
        fs::symlink_metadata(backup)?.is_dir()
            && !fs::symlink_metadata(backup)?.file_type().is_symlink(),
        "Inspector 备份目录无效，未修改运行时"
    );
    let saved: Backup = serde_json::from_slice(&crate::fs_util::read_bounded(
        &backup.join("metadata.json"),
        super::MAX_CACHE_BYTES,
    )?)
    .context("Inspector 备份元数据损坏，未修改运行时")?;
    anyhow::ensure!(
        saved.format == 1
            && saved.original == b'0'
            && saved.binary == binary
            && saved.offset == current.offset
            && saved.normalized_sha256 == current.normalized,
        "Inspector 备份与当前运行时不匹配（文件可能已更新），未修改运行时"
    );
    let original = backup.join("original.bin");
    let metadata = fs::symlink_metadata(&original)?;
    anyhow::ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Inspector 完整备份不是普通文件"
    );
    let original = inspect(&mut File::open(original)?)?;
    anyhow::ensure!(
        original.current == saved.original
            && original.offset == saved.offset
            && original.digest == saved.original_sha256
            && original.normalized == saved.normalized_sha256,
        "Inspector 完整备份损坏，未修改运行时"
    );
    Ok(saved)
}

fn save_backup(plan: &InspectorRepairPlan, file: &mut File) -> Result<()> {
    if plan.backup.try_exists()? {
        validate_backup(&plan.binary, &plan.backup, &plan.inspection)?;
        return Ok(());
    }
    let parent = plan.backup.parent().context("Inspector 备份路径无效")?;
    fs::create_dir_all(parent).context("创建 Inspector 备份目录失败")?;
    let staging = crate::fs_util::unique_temp_path(&plan.backup);
    fs::create_dir(&staging)?;
    let result = (|| -> Result<()> {
        let original = staging.join("original.bin");
        let mut destination = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&original)?;
        file.seek(SeekFrom::Start(0))?;
        std::io::copy(file, &mut destination)?;
        destination.sync_all()?;
        anyhow::ensure!(
            digest(&mut destination)? == plan.inspection.digest,
            "Inspector 完整备份校验失败"
        );
        drop(destination);
        let saved = Backup {
            format: 1,
            binary: plan.binary.clone(),
            offset: plan.inspection.offset,
            original: plan.inspection.current,
            original_sha256: plan.inspection.digest.clone(),
            normalized_sha256: plan.inspection.normalized.clone(),
        };
        crate::fs_util::atomic_write_private(
            &staging.join("metadata.json"),
            &serde_json::to_vec(&saved)?,
        )?;
        if let Ok(directory) = File::open(&staging) {
            let _ = directory.sync_all();
        }
        anyhow::ensure!(
            !plan.backup.try_exists()?,
            "Inspector 备份已被其他任务创建，未覆盖"
        );
        fs::rename(&staging, &plan.backup).context("持久化 Inspector 完整备份失败")?;
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn invalidate_cache(cache: &Path) -> Result<()> {
    crate::fs_util::remove_file_if_exists(cache)
        .context("清除 Electron fuse 缓存失败，未修改运行时")
}

fn write_verified(
    file: &mut File,
    before: &Inspection,
    desired: u8,
    mut sync: impl FnMut(&mut File) -> Result<()>,
) -> Result<()> {
    let write = |file: &mut File, byte| -> Result<()> {
        file.seek(SeekFrom::Start(before.offset))?;
        file.write_all(&[byte])?;
        Ok(())
    };
    let result = (|| -> Result<()> {
        write(file, desired)?;
        sync(file)?;
        let after = inspect(file)?;
        anyhow::ensure!(
            after.offset == before.offset
                && after.current == desired
                && after.normalized == before.normalized,
            "Inspector 写入后校验失败"
        );
        Ok(())
    })();
    if let Err(error) = result {
        let rollback = (|| -> Result<()> {
            write(file, before.current)?;
            file.sync_all()?;
            anyhow::ensure!(digest(file)? == before.digest, "回滚摘要不匹配");
            Ok(())
        })();
        return match rollback {
            Ok(()) => Err(error).context("Inspector 修改失败，已还原原始字节"),
            Err(rollback) => anyhow::bail!(
                "Inspector 修改失败：{error:#}；回滚失败：{rollback:#}；请保留完整备份"
            ),
        };
    }
    Ok(())
}

pub(crate) fn apply_inspector_repair(plan: &InspectorRepairPlan) -> Result<InspectorRepairOutcome> {
    let mut file = reopen(plan)?;
    let current = inspect(&mut file)?;
    anyhow::ensure!(
        current == plan.inspection,
        "预检后 Electron 运行时已变化，请重新检查后修复"
    );
    if plan.requires_change() {
        save_backup(plan, &mut file)?;
    }
    invalidate_cache(&plan.cache)?;
    if plan.requires_change() {
        write_verified(&mut file, &current, b'1', |file| Ok(file.sync_all()?))?;
    }
    Ok(InspectorRepairOutcome {
        changed: plan.requires_change(),
        binary: plan.binary.clone(),
        backup: plan.backup.clone(),
    })
}

#[cfg(windows)]
pub(crate) fn restore_inspector(app_dir: &Path) -> Result<InspectorRepairOutcome> {
    restore(&prepare_inspector_repair(app_dir)?)
}

fn restore(plan: &InspectorRepairPlan) -> Result<InspectorRepairOutcome> {
    let mut file = reopen(plan)?;
    let current = inspect(&mut file)?;
    anyhow::ensure!(
        current == plan.inspection,
        "预检后 Electron 运行时已变化，未恢复"
    );
    let saved = validate_backup(&plan.binary, &plan.backup, &current)
        .context("无法使用 Inspector 完整备份恢复")?;
    invalidate_cache(&plan.cache)?;
    let changed = current.current != saved.original;
    if changed {
        write_verified(&mut file, &current, saved.original, |file| {
            Ok(file.sync_all()?)
        })?;
    }
    Ok(InspectorRepairOutcome {
        changed,
        binary: plan.binary.clone(),
        backup: plan.backup.clone(),
    })
}

#[cfg(windows)]
pub(super) fn run_restore_if_requested(args: &[std::ffi::OsString]) -> Result<bool> {
    if args
        .first()
        .is_none_or(|arg| arg != "--restore-codex-inspector")
    {
        return Ok(false);
    }
    anyhow::ensure!(
        args.len() <= 2,
        "用法：--restore-codex-inspector [Codex 安装目录]"
    );
    let processes =
        codey_runtime_core::windows_enumerate_processes().context("无法检查 Codex 运行状态")?;
    anyhow::ensure!(
        !processes
            .iter()
            .any(|process| process.process_id != std::process::id()
                && ["chatgpt.exe", "codex.exe", "codey.exe"]
                    .iter()
                    .any(|name| process.exe_file.eq_ignore_ascii_case(name))),
        "请先退出 Codex 和其他 CodeyX 进程，再恢复 Inspector"
    );
    let directory = if let Some(directory) = args.get(1) {
        PathBuf::from(directory)
    } else {
        PathBuf::from(crate::config::ConfigStore::default().load()?.codex_app_path)
    };
    let outcome = restore_inspector(&directory)?;
    println!(
        "Inspector 已恢复原始状态。运行时：{}；完整备份：{}",
        outcome.binary.display(),
        outcome.backup.display()
    );
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(states: &str) -> (tempfile::TempDir, InspectorRepairPlan, Vec<u8>) {
        let temp = tempfile::tempdir().unwrap();
        let binary = temp.path().join("chrome.dll");
        let mut bytes = b"prefix".to_vec();
        bytes.extend(super::super::tests::wire_bytes(states));
        bytes.extend(b"suffix");
        fs::write(&binary, &bytes).unwrap();
        let binary = fs::canonicalize(binary).unwrap();
        let plan = prepare(
            binary,
            |_| temp.path().join("backup"),
            temp.path().join("cache"),
        )
        .unwrap();
        (temp, plan, bytes)
    }

    fn reprepare(plan: &InspectorRepairPlan) -> InspectorRepairPlan {
        prepare(
            plan.binary.clone(),
            |_| plan.backup.clone(),
            plan.cache.clone(),
        )
        .unwrap()
    }

    #[test]
    fn inspection_hashes_preserve_full_runtime_validation() {
        let (_temp, plan, original) = fixture("010011001");
        let original_digest = crate::fs_util::sha256_hex(&original);
        assert_eq!(plan.inspection.digest, original_digest);
        assert_eq!(plan.inspection.normalized, original_digest);

        let mut enabled = original;
        enabled[plan.inspection.offset as usize] = b'1';
        fs::write(&plan.binary, &enabled).unwrap();
        let inspection = inspect(&mut File::open(&plan.binary).unwrap()).unwrap();
        assert_eq!(inspection.digest, crate::fs_util::sha256_hex(&enabled));
        assert_eq!(inspection.normalized, original_digest);

        enabled[0] ^= 1;
        fs::write(&plan.binary, &enabled).unwrap();
        let inspection = inspect(&mut File::open(&plan.binary).unwrap()).unwrap();
        assert_ne!(inspection.normalized, original_digest);
    }

    #[test]
    fn preflight_validates_application_identity_without_creating_backup() {
        let (temp, plan, original) = fixture("010011001");
        fs::write(temp.path().join("ChatGPT.exe"), b"launcher").unwrap();
        assert!(prepare_inspector_repair(temp.path()).is_err());
        let package = temp.path().join("resources/app/package.json");
        fs::create_dir_all(package.parent().unwrap()).unwrap();
        fs::write(
            &package,
            br#"{"name":"openai-codex-electron","version":"26.1016.61520"}"#,
        )
        .unwrap();
        let prepared = prepare_inspector_repair(temp.path()).unwrap();
        assert!(prepared.requires_change());
        assert!(!prepared.backup.exists());
        assert_eq!(fs::read(&plan.binary).unwrap(), original);
        fs::write(
            package,
            br#"{"name":"unrelated-app","version":"26.1016.61520"}"#,
        )
        .unwrap();
        assert!(prepare_inspector_repair(temp.path()).is_err());
    }

    #[test]
    fn runtime_updates_get_distinct_backups_without_creating_or_reusing_old_files() {
        let (temp, plan, mut original) = fixture("010011001");
        fs::write(temp.path().join("ChatGPT.exe"), b"launcher").unwrap();
        let package = temp.path().join("resources/app/package.json");
        fs::create_dir_all(package.parent().unwrap()).unwrap();
        fs::write(
            &package,
            br#"{"name":"openai-codex-electron","version":"26.1016.61520"}"#,
        )
        .unwrap();
        let first = prepare_inspector_repair(temp.path()).unwrap();
        original[0] = b'X';
        fs::write(&plan.binary, &original).unwrap();
        let updated = prepare_inspector_repair(temp.path()).unwrap();
        assert_ne!(updated.backup, first.backup);
        assert!(!first.backup.exists());
        assert!(!updated.backup.exists());
        original[updated.inspection.offset as usize] = b'1';
        fs::write(&plan.binary, &original).unwrap();
        let enabled = prepare_inspector_repair(temp.path()).unwrap();
        assert_eq!(enabled.backup, updated.backup);
        assert!(!enabled.requires_change());
    }

    #[test]
    fn repair_changes_only_inspector_and_restores_full_original() {
        let (_temp, plan, original) = fixture("010011001");
        fs::write(&plan.cache, b"stale cache").unwrap();
        assert!(plan.requires_change());
        assert!(!plan.backup.exists());
        let outcome = apply_inspector_repair(&plan).unwrap();
        assert!(outcome.changed);
        assert!(!plan.cache.exists());
        assert_eq!(
            fs::read(plan.backup.join("original.bin")).unwrap(),
            original
        );
        let mut expected = original.clone();
        expected[plan.inspection.offset as usize] = b'1';
        assert_eq!(fs::read(&plan.binary).unwrap(), expected);
        assert!(!apply_inspector_repair(&reprepare(&plan)).unwrap().changed);
        assert!(restore(&reprepare(&plan)).unwrap().changed);
        assert_eq!(fs::read(&plan.binary).unwrap(), original);
        assert!(!restore(&reprepare(&plan)).unwrap().changed);
    }

    #[test]
    fn enabled_runtime_needs_no_backup_and_missing_restore_is_rejected() {
        let (_temp, plan, original) = fixture("010111001");
        assert!(!plan.requires_change());
        assert!(!apply_inspector_repair(&plan).unwrap().changed);
        assert!(!plan.backup.exists());
        assert!(restore(&reprepare(&plan)).is_err());
        assert_eq!(fs::read(&plan.binary).unwrap(), original);
    }

    #[test]
    fn unsupported_ambiguous_and_missing_wires_are_rejected_without_writes() {
        let (temp, plan, _) = fixture("010011001");
        let mut duplicate = super::super::tests::wire_bytes("010011001");
        duplicate.extend(super::super::tests::wire_bytes("010011001"));
        let mut unknown = super::super::tests::wire_bytes("010011001");
        unknown[FUSE_SENTINEL.len()] = 2;
        for bytes in [
            duplicate,
            unknown,
            super::super::tests::wire_bytes("010r11001"),
            super::super::tests::wire_bytes("0100110011"),
            FUSE_SENTINEL.to_vec(),
            b"absent".to_vec(),
        ] {
            fs::write(&plan.binary, &bytes).unwrap();
            assert!(
                prepare(
                    plan.binary.clone(),
                    |_| plan.backup.clone(),
                    plan.cache.clone()
                )
                .is_err()
            );
            assert_eq!(fs::read(&plan.binary).unwrap(), bytes);
            assert!(!temp.path().join("backup").exists());
        }
        assert!(reject_store(Path::new("C:/Program Files/WindowsApps/Codex")).is_err());
    }

    #[test]
    fn changes_after_preflight_are_rejected() {
        let (_temp, plan, mut original) = fixture("010011001");
        original[0] = b'X';
        fs::write(&plan.binary, &original).unwrap();
        assert!(apply_inspector_repair(&plan).is_err());
        assert_eq!(fs::read(&plan.binary).unwrap(), original);
        assert!(!plan.backup.exists());
    }

    #[test]
    fn damaged_foreign_and_stale_backups_are_never_overwritten() {
        let (_temp, plan, original) = fixture("010011001");
        fs::create_dir(&plan.backup).unwrap();
        fs::write(plan.backup.join("metadata.json"), b"foreign").unwrap();
        assert!(apply_inspector_repair(&plan).is_err());
        assert_eq!(
            fs::read(plan.backup.join("metadata.json")).unwrap(),
            b"foreign"
        );
        assert_eq!(fs::read(&plan.binary).unwrap(), original);
        fs::remove_file(plan.backup.join("metadata.json")).unwrap();
        fs::remove_dir(&plan.backup).unwrap();
        apply_inspector_repair(&plan).unwrap();
        fs::write(plan.backup.join("original.bin"), b"damaged").unwrap();
        assert!(
            prepare(
                plan.binary.clone(),
                |_| plan.backup.clone(),
                plan.cache.clone()
            )
            .is_err()
        );
        fs::write(plan.backup.join("original.bin"), &original).unwrap();
        let mut updated = fs::read(&plan.binary).unwrap();
        updated[0] = b'X';
        fs::write(&plan.binary, &updated).unwrap();
        assert!(
            prepare(
                plan.binary.clone(),
                |_| plan.backup.clone(),
                plan.cache.clone()
            )
            .is_err()
        );
        assert_eq!(fs::read(&plan.binary).unwrap(), updated);
    }

    #[test]
    fn cache_failure_prevents_patch_and_sync_failure_rolls_back() {
        let (_temp, plan, original) = fixture("010011001");
        fs::create_dir(&plan.cache).unwrap();
        assert!(apply_inspector_repair(&plan).is_err());
        assert_eq!(fs::read(&plan.binary).unwrap(), original);
        fs::remove_dir(&plan.cache).unwrap();
        let mut file = open_runtime_exclusive(&plan.binary).unwrap();
        let error = write_verified(&mut file, &plan.inspection, b'1', |_| {
            anyhow::bail!("injected sync failure")
        })
        .unwrap_err();
        assert!(format!("{error:#}").contains("已还原原始字节"));
        drop(file);
        assert_eq!(fs::read(&plan.binary).unwrap(), original);
    }

    #[cfg(windows)]
    #[test]
    fn occupied_runtime_is_rejected_before_backup() {
        let (_temp, plan, _) = fixture("010011001");
        let _reader = File::open(&plan.binary).unwrap();
        assert!(apply_inspector_repair(&plan).is_err());
        assert!(!plan.backup.exists());
    }
}
