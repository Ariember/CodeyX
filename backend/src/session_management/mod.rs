use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use serde::{Deserialize, Serialize};

mod database;
mod files;
mod retention;
#[cfg(test)]
mod tests;

pub(crate) use retention::{SavePolicyRequest, automatic_cleanup, save_policy};

const PENDING: &str = ".codey-session-cleanup-v1.json";
static OPERATION: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionEntry {
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub updated_at: i64,
    pub archived: bool,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inventory {
    sessions: Vec<SessionEntry>,
    revision: String,
    pending_count: usize,
    cleanup_policy: retention::CleanupPolicy,
    cleanup_policy_revision: String,
}

struct SessionScan {
    sessions: Vec<SessionEntry>,
    revision: String,
    pending_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeleteRequest {
    ids: Vec<String>,
    revision: String,
    confirmed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupResult {
    selected_count: usize,
    restart_required: bool,
    pub(crate) errors: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    version: u32,
    ids: BTreeSet<String>,
}

fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|value| value.to_string() == id)
}

fn read_pending(home: &Path) -> Result<Pending> {
    let path = home.join(PENDING);
    if !files::exists(&path)? {
        return Ok(Pending {
            version: 1,
            ..Pending::default()
        });
    }
    files::checked(home, &path)?;
    let pending: Pending =
        serde_json::from_slice(&fs::read(path)?).context("会话清理任务文件损坏，已停止清理")?;
    ensure!(
        pending.version == 1 && pending.ids.iter().all(|id| valid_id(id)),
        "会话清理任务格式不受支持"
    );
    Ok(pending)
}

fn scan(home: &Path) -> Result<SessionScan> {
    let mut entries = BTreeMap::new();
    files::inventory(home, &mut entries)?;
    database::inventory(home, &mut entries)?;
    let pending = read_pending(home)?;
    // 正常写入不改变清理范围；仅会话集合与归档状态变化需要重新确认。
    let scope = entries
        .iter()
        .map(|(id, entry)| (id, entry.archived))
        .collect::<Vec<_>>();
    let revision = crate::fs_util::sha256_hex(&serde_json::to_vec(&scope)?);
    let mut sessions = entries.into_values().collect::<Vec<_>>();
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
    Ok(SessionScan {
        sessions,
        revision,
        pending_count: pending.ids.len(),
    })
}

pub(crate) fn list(home: &Path) -> Result<Inventory> {
    let _guard = OPERATION
        .lock()
        .map_err(|_| anyhow::anyhow!("会话管理锁不可用"))?;
    let scanned = scan(home)?;
    let cleanup_policy = retention::read_policy(home)?;
    let cleanup_policy_revision = retention::policy_revision(&cleanup_policy)?;
    Ok(Inventory {
        sessions: scanned.sessions,
        revision: scanned.revision,
        pending_count: scanned.pending_count,
        cleanup_policy,
        cleanup_policy_revision,
    })
}

fn lock(home: &Path) -> Result<fs::File> {
    let path = home.join(".codey-session-cleanup.lock");
    if files::exists(&path)? {
        files::checked(home, &path)?;
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    file.try_lock_exclusive()
        .context("其他会话清理操作正在执行，请稍后刷新")?;
    Ok(file)
}

pub(crate) fn remove(home: &Path, request: DeleteRequest) -> Result<CleanupResult> {
    ensure!(request.confirmed, "请先确认永久清理会话");
    ensure!(
        !request.ids.is_empty() && request.ids.len() <= 100_000,
        "请选择要清理的会话"
    );
    ensure!(request.ids.iter().all(|id| valid_id(id)), "会话标识无效");
    let _guard = OPERATION
        .lock()
        .map_err(|_| anyhow::anyhow!("会话管理锁不可用"))?;
    let _file = lock(home)?;
    let inventory = scan(home)?;
    ensure!(
        request.revision == inventory.revision,
        "会话列表已变化，请刷新并重新确认清理范围"
    );
    let known = inventory
        .sessions
        .iter()
        .map(|entry| &entry.id)
        .collect::<BTreeSet<_>>();
    ensure!(
        request.ids.iter().all(|id| known.contains(id)),
        "所选会话已变化，请刷新列表"
    );
    let ids = request.ids.into_iter().collect::<BTreeSet<_>>();
    remove_selected(home, &ids)
}

fn remove_selected(home: &Path, ids: &BTreeSet<String>) -> Result<CleanupResult> {
    // 先固定删除集合；重启时绝不把新建会话追加到“全部”中。
    let mut pending = read_pending(home)?;
    pending.ids.extend(ids.iter().cloned());
    let pending_path = home.join(PENDING);
    if files::exists(&pending_path)? {
        files::checked(home, &pending_path)?;
    }
    crate::fs_util::atomic_write_private(&pending_path, &serde_json::to_vec(&pending)?)?;
    let errors = clean(home, ids, false);
    Ok(CleanupResult {
        selected_count: ids.len(),
        restart_required: true,
        errors,
    })
}

fn clean(home: &Path, ids: &BTreeSet<String>, stopped: bool) -> Vec<String> {
    let mut errors = Vec::new();
    // 每步可重入。部分失败保留任务，不能把部分删除误报为全部完成。
    for result in [
        files::clean(home, ids, stopped),
        database::clean(home, ids, stopped),
    ] {
        if let Err(error) = result {
            errors.push(format!("{error:#}"));
        }
    }
    errors
}

/// 仅由已停止旧 Codex 写入进程的启动维护调用。
pub(crate) fn finish_pending(home: &Path) -> Result<()> {
    let _guard = OPERATION
        .lock()
        .map_err(|_| anyhow::anyhow!("会话管理锁不可用"))?;
    if !files::exists(&home.join(PENDING))? {
        return Ok(());
    }
    let _file = lock(home)?;
    let pending = read_pending(home)?;
    let errors = clean(home, &pending.ids, true);
    ensure!(errors.is_empty(), "会话清理尚未完成：{}", errors.join("；"));
    // 验证所有可枚举存储都不再包含目标，然后才移除重试任务。
    let remaining = scan(home)?;
    ensure!(
        !remaining
            .sessions
            .iter()
            .any(|entry| pending.ids.contains(&entry.id)),
        "仍存在待清理会话，已保留清理任务"
    );
    fs::remove_file(home.join(PENDING)).context("移除已完成的会话清理任务失败")?;
    Ok(())
}

fn entry<'a>(
    entries: &'a mut BTreeMap<String, SessionEntry>,
    id: &str,
) -> Result<&'a mut SessionEntry> {
    ensure!(valid_id(id), "发现不受支持的本地会话标识，已停止扫描");
    Ok(entries
        .entry(id.to_owned())
        .or_insert_with(|| SessionEntry {
            id: id.to_owned(),
            title: "未命名会话".into(),
            ..SessionEntry::default()
        }))
}
