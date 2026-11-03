#[cfg(target_os = "macos")]
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::USER_AGENT;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::AppState;
use crate::config::{CodeyUpdateDownloadSource, ConfigStore};

const UPDATE_CHECK_CACHE_TTL: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_RELEASE_RESPONSE_BYTES: usize = 5 * 1024 * 1024;
const RELEASES_PER_PAGE: usize = 100;
const MAX_RELEASE_PAGES: usize = 10;

#[derive(Clone, Copy)]
enum UpdateRequestMode {
    Automatic,
    Manual,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct UpdateManifest {
    schema_version: u32,
    version: String,
    tag: String,
    #[serde(default, alias = "releaseNotes")]
    release_notes: Option<String>,
    assets: Vec<UpdateManifestAsset>,
}

#[derive(Clone, Debug, Deserialize)]
struct UpdateManifestAsset {
    platform: String,
    arch: String,
    package_type: String,
    file_name: String,
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheck {
    pub(crate) current_version: String,
    pub(crate) latest_version: String,
    pub(crate) update_available: bool,
    pub(crate) selected_asset: Option<UpdateAssetInfo>,
    #[serde(default)]
    pub(crate) release_notes: Option<String>,
    #[serde(default)]
    pub(crate) release_title: Option<String>,
    #[serde(default)]
    pub(crate) release_url: Option<String>,
    #[serde(default)]
    pub(crate) release_id: Option<String>,
    #[serde(default)]
    pub(crate) prerelease: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateAssetInfo {
    pub(crate) platform: String,
    pub(crate) arch: String,
    pub(crate) package_type: String,
    pub(crate) file_name: String,
    pub(crate) url: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateDownload {
    pub(crate) latest_version: String,
    pub(crate) file_path: String,
    pub(crate) file_name: String,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    pub(crate) asset: UpdateAssetInfo,
    #[serde(default)]
    pub(crate) release_id: Option<String>,
    #[serde(default)]
    pub(crate) prerelease: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubRelease {
    id: u64,
    tag_name: String,
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    name: Option<String>,
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Clone, Debug, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
    size: u64,
    state: String,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct UpdateCandidate {
    pub(crate) check: UpdateCheck,
}

#[derive(Debug)]
struct VerifiedDownloadedUpdate {
    path: PathBuf,
    asset: UpdateAssetInfo,
}

pub(super) struct CachedUpdateCandidate {
    releases_url: String,
    candidate: UpdateCandidate,
    checked_at: Instant,
}

pub(super) async fn invoke(
    state: &Arc<AppState>,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    match command {
        "check_for_updates" => {
            let force_refresh = args
                .get("forceRefresh")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let manual = args.get("manual").and_then(Value::as_bool).unwrap_or(false);
            check_for_updates(state, force_refresh, manual).await
        }
        "download_update" => download_update(state, args).await,
        "update_install_report" => update_install_report(state).await,
        "install_downloaded_update" => {
            install_downloaded_update(state, super::string_argument(args, "filePath")?).await
        }
        _ => Err(format!("未知 Codey API 命令：{command}")),
    }
}

pub async fn check_for_updates(
    state: &Arc<AppState>,
    force_refresh: bool,
    manual: bool,
) -> Result<Value, String> {
    let mode = if manual {
        UpdateRequestMode::Manual
    } else {
        UpdateRequestMode::Automatic
    };
    let cache_ttl = if force_refresh {
        Duration::ZERO
    } else {
        UPDATE_CHECK_CACHE_TTL
    };
    let candidate = update_candidate_with_ttl(state, cache_ttl, mode).await?;
    serde_json::to_value(candidate.check).map_err(|error| error.to_string())
}

pub async fn download_update(state: &Arc<AppState>, args: &Value) -> Result<Value, String> {
    let candidate =
        update_candidate_with_ttl(state, UPDATE_DOWNLOAD_CACHE_TTL, UpdateRequestMode::Manual)
            .await?;
    if args.get("expectedVersion").and_then(Value::as_str)
        != Some(candidate.check.latest_version.as_str())
        || args.get("expectedReleaseId").and_then(Value::as_str)
            != candidate.check.release_id.as_deref()
        || args.get("expectedSha256").and_then(Value::as_str)
            != candidate
                .check
                .selected_asset
                .as_ref()
                .map(|asset| asset.sha256.as_str())
    {
        return Err("更新目标已变化，请重新检查并确认更新".to_string());
    }
    let download =
        download_update_candidate_with_mode(state, &candidate, UpdateRequestMode::Manual).await?;
    serde_json::to_value(download).map_err(|error| error.to_string())
}

/// 读取上一次更新安装留给本次启动的结果，读完即清除，保证只提示一次。
pub async fn update_install_report(state: &Arc<AppState>) -> Result<Value, String> {
    let config_path = state.store.path().to_path_buf();
    let Some(report) = crate::update_helper::read_update_install_report(&config_path) else {
        return Ok(Value::Null);
    };
    if report.is_stale(crate::update_helper::current_unix_timestamp()) {
        crate::update_helper::clear_update_install_report(&config_path);
        return Ok(Value::Null);
    }
    crate::update_helper::clear_update_install_report(&config_path);
    serde_json::to_value(report).map_err(|error| error.to_string())
}

pub(crate) async fn check_for_update_candidate(
    state: &Arc<AppState>,
) -> Result<UpdateCandidate, String> {
    update_candidate_with_ttl(state, UPDATE_CHECK_CACHE_TTL, UpdateRequestMode::Automatic).await
}

async fn update_candidate_with_ttl(
    state: &Arc<AppState>,
    cache_ttl: Duration,
    mode: UpdateRequestMode,
) -> Result<UpdateCandidate, String> {
    let policy = update_policy(state, mode).await?;
    let releases_url = configured_github_releases_url(state).await?;
    let cache_key = format!("{}:{releases_url}", policy.as_str());
    let mut cache = state.update_candidate_cache.lock().await;
    if update_policy(state, mode).await? != policy {
        return Err("更新策略已变化，请重新检查更新".to_string());
    }
    let now = Instant::now();
    if let Some(candidate) = reusable_update_candidate(cache.as_ref(), &cache_key, now, cache_ttl) {
        return Ok(candidate);
    }

    let check = fetch_github_update(state, &releases_url).await?;
    let check = filter_update_policy(check, policy)?;
    if update_policy(state, mode).await? != policy {
        return Err("更新策略已变化，请重新检查更新".to_string());
    }
    *state.available_update.write().await = check.update_available.then(|| check.clone());
    let candidate = UpdateCandidate { check };
    *cache = Some(CachedUpdateCandidate {
        releases_url: cache_key,
        candidate: candidate.clone(),
        checked_at: Instant::now(),
    });
    Ok(candidate)
}

async fn update_policy(
    state: &AppState,
    mode: UpdateRequestMode,
) -> Result<crate::config::CodeyUpdatePolicy, String> {
    let policy = state.config.read().await.codey_update_policy;
    if policy == crate::config::CodeyUpdatePolicy::Off {
        return match mode {
            UpdateRequestMode::Automatic => Err("已关闭自动检查更新".to_string()),
            UpdateRequestMode::Manual => Ok(crate::config::CodeyUpdatePolicy::Stable),
        };
    }
    Ok(policy)
}

fn filter_update_policy(
    mut check: UpdateCheck,
    policy: crate::config::CodeyUpdatePolicy,
) -> Result<UpdateCheck, String> {
    if policy == crate::config::CodeyUpdatePolicy::Stable
        && (check.prerelease
            || !Version::parse(&check.latest_version)
                .map_err(|error| error.to_string())?
                .pre
                .is_empty())
    {
        check.update_available = false;
        check.latest_version = check.current_version.clone();
        check.selected_asset = None;
        check.release_notes = None;
        check.release_id = None;
        check.prerelease = false;
    }
    Ok(check)
}

fn github_releases_repository(releases_url: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(releases_url)
        .map_err(|_| "更新地址必须是有效的 HTTPS URL".to_string())?;
    if url.scheme() != "https" {
        return Err("更新地址必须使用 HTTPS".to_string());
    }
    let segments: Vec<_> = url.path_segments().into_iter().flatten().collect();
    if url.host_str() != Some("api.github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || segments.len() != 4
        || segments[0] != "repos"
        || segments[3] != "releases"
        || segments[1..3].iter().any(|part| {
            part.is_empty()
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        })
    {
        return Err("更新地址必须指向本项目的 GitHub Releases API".to_string());
    }
    Ok(format!("{}/{}", segments[1], segments[2]))
}

async fn fetch_github_update(state: &AppState, releases_url: &str) -> Result<UpdateCheck, String> {
    let repository = github_releases_repository(releases_url)?;
    let fetch = async {
        let mut releases = Vec::new();
        for page in 1..=MAX_RELEASE_PAGES {
            let response = state
                .http_client
                .current(releases_url)
                .await
                .get(releases_url)
                .query(&[("per_page", RELEASES_PER_PAGE), ("page", page)])
                .header(
                    USER_AGENT,
                    format!("CodeyX/{} update-check", env!("CARGO_PKG_VERSION")),
                )
                .header(reqwest::header::ACCEPT, "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2026-03-10")
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .map_err(|error| format!("检查 GitHub Releases 失败：{error}"))?;
            match response.status() {
                reqwest::StatusCode::NOT_FOUND => {
                    return Err(
                        "无法读取本项目的 Releases，请确认 GitHub 仓库已公开且地址正确".to_string(),
                    );
                }
                reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::TOO_MANY_REQUESTS => {
                    return Err("GitHub 更新检查受限，请稍后重试".to_string());
                }
                _ => {}
            }
            let response = response
                .error_for_status()
                .map_err(|error| format!("GitHub Releases 返回异常：{error}"))?;
            if response.url().scheme() != "https"
                || response.url().host_str() != Some("api.github.com")
                || response.url().path() != format!("/repos/{repository}/releases")
            {
                return Err("更新地址重定向到了非预期的 GitHub 仓库".to_string());
            }
            let body = crate::http_response::read_bounded_body(
                response,
                MAX_RELEASE_RESPONSE_BYTES,
                "GitHub Releases 响应",
            )
            .await
            .map_err(|error| format!("读取 Releases 失败：{error:#}"))?;
            let mut batch: Vec<GitHubRelease> = serde_json::from_slice(&body)
                .map_err(|error| format!("GitHub Releases 格式无效：{error}"))?;
            let has_more = batch.len() == RELEASES_PER_PAGE;
            releases.append(&mut batch);
            if !has_more {
                return assess_github_releases(env!("CARGO_PKG_VERSION"), &releases, &repository);
            }
        }
        Err("GitHub Releases 数量超过检查上限，请从发布页确认最新版本".to_string())
    };
    tokio::time::timeout(Duration::from_secs(10), fetch)
        .await
        .map_err(|_| "检查 GitHub Releases 超时，请稍后重试".to_string())?
}

fn assess_github_releases(
    current_version: &str,
    releases: &[GitHubRelease],
    repository: &str,
) -> Result<UpdateCheck, String> {
    let latest = releases
        .iter()
        .filter_map(|release| {
            let tag = release
                .tag_name
                .strip_prefix('v')
                .or_else(|| release.tag_name.strip_prefix('V'))
                .unwrap_or(&release.tag_name);
            let version = Version::parse(tag).ok()?;
            if release.draft || release.prerelease || !version.pre.is_empty() {
                return None;
            }
            Some((version, release))
        })
        .max_by(|(left, _), (right, _)| left.cmp_precedence(right));
    let Some((version, release)) = latest else {
        let current = Version::parse(current_version)
            .map_err(|error| error.to_string())?
            .to_string();
        return Ok(UpdateCheck {
            current_version: current.clone(),
            latest_version: current,
            update_available: false,
            selected_asset: None,
            release_notes: None,
            release_title: None,
            release_url: None,
            release_id: None,
            prerelease: false,
        });
    };
    let asset = github_release_asset(
        release,
        &version,
        repository,
        current_update_platform(),
        current_update_arch(),
    )?;
    let manifest = UpdateManifest {
        schema_version: 1,
        version: version.to_string(),
        tag: format!("v{version}"),
        release_notes: release.body.clone(),
        assets: asset.into_iter().collect(),
    };
    let mut check = assess_update_manifest(current_version, &manifest)?;
    check.release_title = release
        .name
        .clone()
        .filter(|title| !title.trim().is_empty());
    check.release_url = Some(format!(
        "https://github.com/{repository}/releases/tag/{}",
        release.tag_name
    ));
    check.release_id = Some(release.id.to_string());
    check.prerelease = release.prerelease || !version.pre.is_empty();
    Ok(check)
}

fn github_release_asset(
    release: &GitHubRelease,
    version: &Version,
    repository: &str,
    platform: &str,
    arch: &str,
) -> Result<Option<UpdateManifestAsset>, String> {
    let (package_type, suffix) = match platform {
        "windows" => ("nsis", format!("windows-{arch}-setup.exe")),
        "macos" => ("app-zip", format!("macos-{arch}-unsigned.zip")),
        _ => return Ok(None),
    };
    let asset = ["CodeyX", "Codey"].into_iter().find_map(|prefix| {
        let name = format!("{prefix}-{version}-{suffix}");
        release
            .assets
            .iter()
            .find(|asset| asset.name == name && asset.state == "uploaded")
    });
    let Some(asset) = asset else { return Ok(None) };
    let expected_url = format!(
        "https://github.com/{repository}/releases/download/{}/{}",
        release.tag_name, asset.name,
    );
    if asset
        .browser_download_url
        .replace("%2B", "+")
        .replace("%2b", "+")
        != expected_url
    {
        return Err("安装包必须来自本项目对应的 GitHub Release".to_string());
    }
    let sha256 = asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .ok_or_else(|| "Release 安装包缺少 GitHub SHA-256 摘要，请重新上传安装包".to_string())?;
    let asset = UpdateManifestAsset {
        platform: platform.to_string(),
        arch: arch.to_string(),
        package_type: package_type.to_string(),
        file_name: asset.name.clone(),
        url: asset.browser_download_url.clone(),
        sha256: sha256.to_ascii_lowercase(),
        size: asset.size,
    };
    validate_update_asset(&asset)?;
    Ok(Some(asset))
}

fn validate_same_update(approved: &UpdateCheck, current: &UpdateCheck) -> Result<(), String> {
    if !current.update_available
        || approved.latest_version != current.latest_version
        || approved.release_id != current.release_id
        || approved.prerelease != current.prerelease
        || approved.selected_asset != current.selected_asset
    {
        return Err("Release 或安装包已变化，请重新检查并确认更新".to_string());
    }
    Ok(())
}

fn reusable_update_candidate(
    cached: Option<&CachedUpdateCandidate>,
    releases_url: &str,
    now: Instant,
    cache_ttl: Duration,
) -> Option<UpdateCandidate> {
    let cached = cached?;
    (cached.releases_url == releases_url
        && now.saturating_duration_since(cached.checked_at) < cache_ttl)
        .then(|| cached.candidate.clone())
}

pub(crate) async fn download_update_candidate(
    state: &Arc<AppState>,
    candidate: &UpdateCandidate,
) -> Result<UpdateDownload, String> {
    download_update_candidate_with_mode(state, candidate, UpdateRequestMode::Automatic).await
}

async fn download_update_candidate_with_mode(
    state: &Arc<AppState>,
    candidate: &UpdateCandidate,
    mode: UpdateRequestMode,
) -> Result<UpdateDownload, String> {
    let policy = update_policy(state, mode).await?;
    if !filter_update_policy(candidate.check.clone(), policy)?.update_available {
        return Err("更新目标不符合当前更新策略".to_string());
    }
    let fresh = resolve_expected_update(state, mode).await?;
    validate_same_update(&candidate.check, &fresh)?;
    if !candidate.check.update_available {
        return Err(format!(
            "当前已是最新版本 v{}",
            candidate.check.current_version
        ));
    }
    let asset = candidate
        .check
        .selected_asset
        .as_ref()
        .ok_or_else(|| "没有适用于当前系统的可安装更新包".to_string())?;
    let download_source = state.config.read().await.codey_update_download_source;
    let file_path = download_update_asset(
        &state.http_client.current(&asset.url).await,
        &state.store,
        &candidate.check.latest_version,
        asset,
        download_source,
    )
    .await?;
    // 保存用户确认的版本与安装包，进程重启后也要检查同一份确认。
    let approval = serde_json::to_vec(&candidate.check).map_err(|e| e.to_string())?;
    tokio::fs::write(file_path.with_extension("approval.json"), approval)
        .await
        .map_err(|e| format!("保存更新确认信息失败：{e}"))?;
    Ok(UpdateDownload {
        latest_version: candidate.check.latest_version.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        file_name: asset.file_name.clone(),
        size: asset.size,
        sha256: asset.sha256.clone(),
        asset: asset.clone(),
        release_id: candidate.check.release_id.clone(),
        prerelease: candidate.check.prerelease,
    })
}

pub async fn install_downloaded_update(
    state: &Arc<AppState>,
    file_path: String,
) -> Result<Value, String> {
    // 旧一轮的报告先清掉，否则下面的启动握手会把残留文件误认为助手已接手。
    crate::update_helper::clear_update_install_report(state.store.path());
    start_downloaded_update_with_mode(state, &file_path, UpdateRequestMode::Manual).await?;

    #[cfg(target_os = "windows")]
    {
        // 助手自己也要能被创建出来。若它在真正开始前就夭折（被安全软件拦下、
        // 更新缓存被清理等），这里保持主进程存活并把错误交给前端，用户就不会
        // 看到"Codey 消失、版本没变、也没有任何提示"。
        let config_path = state.store.path().to_path_buf();
        let started = tokio::task::spawn_blocking(move || {
            crate::update_helper::wait_for_helper_start(&config_path, HELPER_START_TIMEOUT)
        })
        .await
        .unwrap_or(false);
        if !started {
            crate::update_helper::clear_update_install_report(state.store.path());
            return Err("更新助手未能启动，请重新打开 Codey 后重试".to_string());
        }
    }

    let shutdown_state = Arc::clone(state);
    tokio::spawn(async move {
        // Let the bridge deliver the response before Codex/Codey starts
        // normal shutdown and releases the executable for replacement.
        tokio::time::sleep(Duration::from_millis(250)).await;
        shutdown_state.request_update_shutdown();
    });
    Ok(json!({"status":"installing"}))
}

/// 等待助手写下启动记录的窗口。助手要做的是复制一份自身并落一份 JSON，正常
/// 情况瞬间完成；慢磁盘和首次的杀毒扫描可能拖慢，给到 20 秒仍然留有余量。
#[cfg(target_os = "windows")]
const HELPER_START_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) async fn start_downloaded_update(
    state: &AppState,
    file_path: &str,
) -> Result<(), String> {
    start_downloaded_update_with_mode(state, file_path, UpdateRequestMode::Automatic).await
}

async fn start_downloaded_update_with_mode(
    state: &AppState,
    file_path: &str,
    mode: UpdateRequestMode,
) -> Result<(), String> {
    let expected_update = resolve_expected_update(state, mode).await?;
    let verified = verify_downloaded_update(&state.store, file_path, &expected_update).await?;
    let bytes = tokio::fs::read(verified.path.with_extension("approval.json"))
        .await
        .map_err(|_| "缺少更新确认信息，请重新下载并确认更新".to_string())?;
    let approved: UpdateCheck =
        serde_json::from_slice(&bytes).map_err(|_| "更新确认信息无效，请重新下载".to_string())?;
    validate_same_update(&approved, &expected_update)?;
    // 哈希校验可能耗时，启动安装器前再确认当前策略。
    let fresh = resolve_expected_update(state, mode).await?;
    validate_same_update(&approved, &fresh)?;
    if !filter_update_policy(expected_update, update_policy(state, mode).await?)?.update_available {
        return Err("更新目标不符合当前更新策略".to_string());
    }
    spawn_update_installer(&verified.path, &verified.asset)
}

/// Release 更新每次安装前重新校验，连接失败时停止安装。
async fn resolve_expected_update(
    state: &AppState,
    mode: UpdateRequestMode,
) -> Result<UpdateCheck, String> {
    let policy = update_policy(state, mode).await?;
    let releases_url = configured_github_releases_url(state).await?;
    let check = fetch_github_update(state, &releases_url).await?;
    if update_policy(state, mode).await? != policy {
        return Err("更新策略已变化，请重新检查更新".to_string());
    }
    let check = filter_update_policy(check, policy)?;
    if !check.update_available {
        return Err("当前没有符合更新策略的新版 Release，请重新检查更新".to_string());
    }
    Ok(check)
}

async fn configured_github_releases_url(state: &AppState) -> Result<String, String> {
    let releases_url = state
        .config
        .read()
        .await
        .github_releases_url
        .trim()
        .to_string();
    if releases_url.is_empty() {
        return Err("内置更新地址未配置，请检查构建配置".to_string());
    }
    Ok(releases_url)
}

pub(super) fn assess_update_manifest(
    current_version: &str,
    manifest: &UpdateManifest,
) -> Result<UpdateCheck, String> {
    if manifest.schema_version != 1 {
        return Err(format!("不支持的更新清单版本：{}", manifest.schema_version));
    }
    if manifest.tag != format!("v{}", manifest.version) {
        return Err("更新清单的版本和标签不一致".to_string());
    }
    for asset in &manifest.assets {
        validate_update_asset(asset)?;
    }

    let current =
        Version::parse(current_version).map_err(|error| format!("当前版本格式无效：{error}"))?;
    let latest = Version::parse(&manifest.version)
        .map_err(|error| format!("更新清单版本格式无效：{error}"))?;
    Ok(UpdateCheck {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        update_available: latest.cmp_precedence(&current).is_gt(),
        selected_asset: selected_update_asset(&manifest.assets).map(|asset| asset_info(&asset)),
        release_notes: manifest.release_notes.clone(),
        release_title: None,
        release_url: None,
        release_id: None,
        prerelease: !latest.pre.is_empty(),
    })
}

fn validate_update_asset(asset: &UpdateManifestAsset) -> Result<(), String> {
    validate_update_asset_fields(
        &asset.platform,
        &asset.arch,
        &asset.package_type,
        &asset.file_name,
        &asset.url,
        &asset.sha256,
        asset.size,
    )
}

pub(super) fn current_update_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        std::env::consts::OS
    }
}

pub(super) fn current_update_arch() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    }
}

fn installable_package_priority(asset: &UpdateManifestAsset) -> Option<u8> {
    match (
        current_update_platform(),
        asset.package_type.trim().to_ascii_lowercase().as_str(),
    ) {
        ("windows", "nsis") => Some(0),
        ("macos", "app-zip") => Some(0),
        _ => None,
    }
}

fn selected_update_asset(assets: &[UpdateManifestAsset]) -> Option<UpdateManifestAsset> {
    let platform = current_update_platform();
    let arch = current_update_arch();
    assets
        .iter()
        .filter_map(|asset| {
            if !asset.platform.eq_ignore_ascii_case(platform)
                || !asset.arch.eq_ignore_ascii_case(arch)
            {
                return None;
            }
            installable_package_priority(asset).map(|priority| (priority, asset))
        })
        .min_by_key(|(priority, _)| *priority)
        .map(|(_, asset)| asset.clone())
}

fn asset_info(asset: &UpdateManifestAsset) -> UpdateAssetInfo {
    UpdateAssetInfo {
        platform: asset.platform.clone(),
        arch: asset.arch.clone(),
        package_type: asset.package_type.clone(),
        file_name: asset.file_name.clone(),
        url: asset.url.clone(),
        sha256: asset.sha256.clone(),
        size: asset.size,
    }
}

fn update_download_dir(store: &ConfigStore) -> Result<PathBuf, String> {
    let parent = store
        .path()
        .parent()
        .ok_or_else(|| "Codey 配置路径无父目录，无法创建更新缓存".to_string())?;
    Ok(parent.join("updates"))
}

async fn download_update_asset(
    client: &reqwest::Client,
    store: &ConfigStore,
    version: &str,
    asset: &UpdateAssetInfo,
    source: CodeyUpdateDownloadSource,
) -> Result<PathBuf, String> {
    download_update_asset_with_request(store, version, asset, source, |url| async move {
        let response = client
            .get(url)
            .header(
                USER_AGENT,
                format!("Codey/{} update-download", env!("CARGO_PKG_VERSION")),
            )
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .map_err(|error| format!("下载更新失败：{error}"))?;
        if response.url().scheme() != "https" {
            return Err("安装包地址重定向到了非 HTTPS 地址".to_string());
        }
        Ok(response)
    })
    .await
}

fn update_download_urls(asset: &UpdateAssetInfo, source: CodeyUpdateDownloadSource) -> Vec<String> {
    let mut urls = Vec::new();
    if source == CodeyUpdateDownloadSource::GhProxy {
        urls.push(format!("https://gh-proxy.com/{}", asset.url));
    }
    urls.push(asset.url.clone());
    urls
}

async fn download_update_asset_with_request<F, Fut>(
    store: &ConfigStore,
    version: &str,
    asset: &UpdateAssetInfo,
    source: CodeyUpdateDownloadSource,
    mut request: F,
) -> Result<PathBuf, String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<reqwest::Response, String>>,
{
    validate_update_asset_info(asset)?;
    let version = Version::parse(version).map_err(|error| format!("更新版本无效：{error}"))?;
    let directory = update_download_dir(store)?.join(format!("v{version}"));
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("创建更新缓存目录失败：{error}"))?;
    let destination = directory.join(&asset.file_name);
    let temporary = directory.join(format!(".{}.download", asset.file_name));
    let _ = tokio::fs::remove_file(&temporary).await;
    if verify_update_file(&destination, asset).await.is_ok() {
        return Ok(destination);
    }

    // 留出更新元数据检查和桥接响应时间，两个下载源共用预算。
    let download = tokio::time::timeout(Duration::from_secs(270), async {
        let urls = update_download_urls(asset, source);
        let mut last_error = String::new();
        for (index, url) in urls.iter().enumerate() {
            let attempt = async {
                let response = request(url.clone())
                    .await?
                    .error_for_status()
                    .map_err(|error| format!("下载安装包失败：{error}"))?;
                write_update_download(response, &temporary, asset).await
            };
            let result = if index + 1 < urls.len() {
                tokio::time::timeout(Duration::from_secs(135), attempt)
                    .await
                    .unwrap_or_else(|_| Err("GH-Proxy 下载超时，已尝试 GitHub 官方源".to_string()))
            } else {
                attempt.await
            };
            match result {
                Ok(()) => return Ok(()),
                Err(error) => {
                    last_error = error;
                    let _ = tokio::fs::remove_file(&temporary).await;
                }
            }
        }
        Err(last_error)
    })
    .await
    .unwrap_or_else(|_| Err("下载更新超时，请稍后重试".to_string()));
    if let Err(error) = download {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    let _ = tokio::fs::remove_file(&destination).await;
    if let Err(error) = tokio::fs::rename(&temporary, &destination).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(format!("保存更新安装包失败：{error}"));
    }
    Ok(destination)
}

async fn write_update_download(
    response: reqwest::Response,
    temporary: &Path,
    asset: &UpdateAssetInfo,
) -> Result<(), String> {
    let mut file = tokio::fs::File::create(temporary)
        .await
        .map_err(|error| format!("创建更新缓存文件失败：{error}"))?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut bytes_written = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取更新下载数据失败：{error}"))?;
        bytes_written += chunk.len() as u64;
        if bytes_written > asset.size {
            return Err("下载的安装包大小超过更新清单声明".to_string());
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("写入更新缓存文件失败：{error}"))?;
    }
    file.flush()
        .await
        .map_err(|error| format!("刷新更新缓存文件失败：{error}"))?;
    drop(file);

    if bytes_written != asset.size {
        return Err(format!(
            "安装包大小不一致：期望 {} 字节，实际 {} 字节",
            asset.size, bytes_written
        ));
    }
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if !actual_sha256.eq_ignore_ascii_case(&asset.sha256) {
        return Err("安装包 SHA-256 校验失败".to_string());
    }
    Ok(())
}

fn validate_update_asset_info(asset: &UpdateAssetInfo) -> Result<(), String> {
    validate_update_asset_fields(
        &asset.platform,
        &asset.arch,
        &asset.package_type,
        &asset.file_name,
        &asset.url,
        &asset.sha256,
        asset.size,
    )
}

fn validate_update_asset_fields(
    platform: &str,
    arch: &str,
    package_type: &str,
    file_name: &str,
    url: &str,
    sha256: &str,
    size: u64,
) -> Result<(), String> {
    if platform.trim().is_empty()
        || arch.trim().is_empty()
        || package_type.trim().is_empty()
        || file_name.trim().is_empty()
        || size == 0
    {
        return Err("更新清单包含不完整的安装包信息".to_string());
    }
    if file_name.contains(['/', '\\']) || Path::new(file_name).components().count() != 1 {
        return Err(format!("安装包文件名无效：{file_name}"));
    }
    let url = reqwest::Url::parse(url).map_err(|_| format!("安装包地址无效：{file_name}"))?;
    if url.scheme() != "https" {
        return Err(format!("安装包地址必须使用 HTTPS：{file_name}"));
    }
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("安装包 SHA-256 无效：{file_name}"));
    }
    Ok(())
}

fn validate_downloaded_update_path(
    store: &ConfigStore,
    file_path: &str,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(file_path);
    if !path.is_absolute() {
        return Err("更新安装包路径必须是绝对路径".to_string());
    }
    let root = update_download_dir(store)?
        .canonicalize()
        .map_err(|error| format!("读取更新缓存目录失败：{error}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("读取更新安装包失败：{error}"))?;
    if !canonical.starts_with(&root) {
        return Err("只能安装 Codey 下载缓存中的更新包".to_string());
    }
    if !canonical.is_file() {
        return Err("更新安装包路径必须指向文件".to_string());
    }
    Ok(canonical)
}

async fn verify_downloaded_update(
    store: &ConfigStore,
    file_path: &str,
    expected_update: &UpdateCheck,
) -> Result<VerifiedDownloadedUpdate, String> {
    if !expected_update.update_available {
        return Err("当前没有可安装的更新".to_string());
    }
    let asset = expected_update
        .selected_asset
        .as_ref()
        .ok_or_else(|| "没有适用于当前系统的可安装更新包".to_string())?;
    validate_update_asset_info(asset)?;
    let version = Version::parse(&expected_update.latest_version)
        .map_err(|error| format!("待安装更新版本无效：{error}"))?;
    let update_path = validate_downloaded_update_path(store, file_path)?;
    let expected_directory = update_download_dir(store)?
        .join(format!("v{version}"))
        .canonicalize()
        .map_err(|error| format!("读取预期更新缓存目录失败：{error}"))?;
    let expected_path = expected_directory.join(&asset.file_name);
    if update_path != expected_path {
        return Err("更新安装包与最近下载的版本不匹配，请重新下载".to_string());
    }

    verify_update_file(&update_path, asset).await?;
    Ok(VerifiedDownloadedUpdate {
        path: update_path,
        asset: asset.clone(),
    })
}

async fn verify_update_file(update_path: &Path, asset: &UpdateAssetInfo) -> Result<(), String> {
    let metadata = tokio::fs::symlink_metadata(update_path)
        .await
        .map_err(|error| format!("读取更新安装包信息失败：{error}"))?;
    if !metadata.is_file() || metadata.len() != asset.size {
        return Err(format!(
            "安装前校验失败：安装包大小应为 {} 字节，实际为 {} 字节",
            asset.size,
            metadata.len()
        ));
    }

    // The cache can be modified after the original download completed. Hash
    // the final on-disk bytes again immediately before launching the installer.
    let mut file = tokio::fs::File::open(update_path)
        .await
        .map_err(|error| format!("打开更新安装包失败：{error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut bytes_read = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("安装前读取更新安装包失败：{error}"))?;
        if read == 0 {
            break;
        }
        bytes_read = bytes_read.saturating_add(read as u64);
        if bytes_read > asset.size {
            return Err("安装前校验失败：安装包大小超过更新清单声明".to_string());
        }
        hasher.update(&buffer[..read]);
    }
    if bytes_read != asset.size {
        return Err(format!(
            "安装前校验失败：安装包大小应为 {} 字节，实际为 {} 字节",
            asset.size, bytes_read
        ));
    }
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if !actual_sha256.eq_ignore_ascii_case(&asset.sha256) {
        return Err("安装前校验失败：安装包 SHA-256 不匹配，请重新下载".to_string());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn spawn_update_installer(update_path: &Path, asset: &UpdateAssetInfo) -> Result<(), String> {
    crate::update_helper::spawn_update_installer(update_path, asset.size, &asset.sha256)
}

#[cfg(target_os = "macos")]
fn spawn_update_installer(update_path: &Path, asset: &UpdateAssetInfo) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    if !update_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("macOS 更新安装包必须是 .zip".to_string());
    }
    let app_bundle = current_macos_app_bundle()
        .ok_or_else(|| "当前 Codey 不是从 .app 包运行，无法自动替换".to_string())?;
    let script_path = update_path
        .parent()
        .ok_or_else(|| "更新安装包路径无父目录".to_string())?
        .join(format!(
            ".install-codey-update-{}-{}.sh",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
    let mut script = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&script_path)
        .map_err(|error| format!("创建更新安装脚本失败：{error}"))?;
    if let Err(error) = script.write_all(
        r#"#!/bin/sh
set -eu
rm -f "$0"
parent_pid="$1"
archive="$2"
app_bundle="$3"
app_parent="$(dirname "$app_bundle")"
app_name="$(basename "$app_bundle")"
stage_dir=""
tmp_dir=""
backup_bundle=""
replacement_committed=0
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$replacement_committed" -ne 1 ] && [ -n "$backup_bundle" ] && [ -e "$backup_bundle" ]; then
    rm -rf "$app_bundle"
    /bin/mv "$backup_bundle" "$app_bundle" || true
  fi
  if [ -n "$stage_dir" ]; then rm -rf "$stage_dir"; fi
  if [ -n "$tmp_dir" ]; then rm -rf "$tmp_dir"; fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
while kill -0 "$parent_pid" 2>/dev/null; do
  sleep 0.2
done
expected_size="$4"
expected_sha256="$5"
archive_parent="$(dirname "$archive")"
archive_name="$(basename "$archive")"
stage_dir="$(/usr/bin/mktemp -d "$archive_parent/.codey-update-stage.XXXXXX")"
/bin/chmod 700 "$stage_dir"
staged_archive="$stage_dir/$archive_name"
/bin/mv "$archive" "$staged_archive"
/bin/chmod 400 "$staged_archive"
actual_size="$(/usr/bin/stat -f '%z' "$staged_archive")"
test "$actual_size" = "$expected_size"
actual_sha256="$(/usr/bin/shasum -a 256 "$staged_archive" | /usr/bin/awk '{print $1}')"
test "$(printf '%s' "$actual_sha256" | /usr/bin/tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$expected_sha256" | /usr/bin/tr '[:upper:]' '[:lower:]')"
tmp_dir="$app_parent/.${app_name}.codey-update.$$"
rm -rf "$tmp_dir"
mkdir -p "$tmp_dir"
/usr/bin/ditto -x -k "$staged_archive" "$tmp_dir"
test -d "$tmp_dir/$app_name"
backup_bundle="$app_parent/.${app_name}.codey-backup.$$"
rm -rf "$backup_bundle"
if [ -e "$app_bundle" ]; then
  /bin/mv "$app_bundle" "$backup_bundle"
fi
if ! /bin/mv "$tmp_dir/$app_name" "$app_bundle"; then
  exit 1
fi
if ! /usr/bin/open "$app_bundle"; then
  exit 1
fi
replacement_committed=1
if [ -e "$backup_bundle" ]; then rm -rf "$backup_bundle"; fi
"#
        .as_bytes(),
    ) {
        let _ = fs::remove_file(&script_path);
        return Err(format!("写入更新安装脚本失败：{error}"));
    }
    if let Err(error) = script.sync_all() {
        let _ = fs::remove_file(&script_path);
        return Err(format!("刷新更新安装脚本失败：{error}"));
    }
    drop(script);
    if let Err(error) = fs::set_permissions(&script_path, fs::Permissions::from_mode(0o700)) {
        let _ = fs::remove_file(&script_path);
        return Err(format!("设置更新安装脚本权限失败：{error}"));
    }
    let spawn_result = std::process::Command::new("/bin/sh")
        .arg(&script_path)
        .arg(std::process::id().to_string())
        .arg(update_path)
        .arg(app_bundle)
        .arg(asset.size.to_string())
        .arg(&asset.sha256)
        .spawn();
    if let Err(error) = spawn_result {
        let _ = fs::remove_file(&script_path);
        return Err(format!("启动更新安装脚本失败：{error}"));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn current_macos_app_bundle() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()?
        .ancestors()
        .find(|path| path.extension().and_then(|value| value.to_str()) == Some("app"))
        .map(Path::to_path_buf)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn spawn_update_installer(_update_path: &Path, _asset: &UpdateAssetInfo) -> Result<(), String> {
    Err("当前平台暂不支持自动安装更新".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPOSITORY: &str = "fraternity-z/CodeyX";

    fn download_asset() -> UpdateAssetInfo {
        let body = b"verified installer";
        UpdateAssetInfo {
            platform: "windows".into(),
            arch: "x64".into(),
            package_type: "nsis".into(),
            file_name: "CodeyX-2.0.0-windows-x64-setup.exe".into(),
            url: format!(
                "https://github.com/{REPOSITORY}/releases/download/v2.0.0/CodeyX-2.0.0-windows-x64-setup.exe"
            ),
            size: body.len() as u64,
            sha256: format!("{:x}", Sha256::digest(body)),
        }
    }

    fn download_response(status: u16, body: &[u8]) -> reqwest::Response {
        hyper::http::Response::builder()
            .status(status)
            .body(body.to_vec())
            .unwrap()
            .into()
    }

    #[tokio::test]
    async fn update_download_sources_map_urls_and_reuse_verified_cache() {
        let asset = download_asset();
        for source in [
            CodeyUpdateDownloadSource::Github,
            CodeyUpdateDownloadSource::GhProxy,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store = ConfigStore::new(directory.path().join("config.json"));
            let mut requests = Vec::new();
            let path = download_update_asset_with_request(&store, "2.0.0", &asset, source, |url| {
                requests.push(url);
                std::future::ready(Ok(download_response(200, b"verified installer")))
            })
            .await
            .unwrap();
            let expected = if source == CodeyUpdateDownloadSource::GhProxy {
                format!("https://gh-proxy.com/{}", asset.url)
            } else {
                asset.url.clone()
            };
            assert_eq!(requests, vec![expected]);
            assert_eq!(tokio::fs::read(&path).await.unwrap(), b"verified installer");
            assert_eq!(
                download_update_asset_with_request(&store, "2.0.0", &asset, source, |_| {
                    std::future::ready(Err(
                        "valid cached installer must not be fetched again".to_string()
                    ))
                })
                .await
                .unwrap(),
                path
            );
        }
    }

    #[tokio::test]
    async fn gh_proxy_download_failure_falls_back_once_and_cleans_partial_file() {
        let asset = download_asset();
        // Transport errors, HTTP errors, hash mismatches and both size limits share fallback.
        for failure in 0..5 {
            let directory = tempfile::tempdir().unwrap();
            let store = ConfigStore::new(directory.path().join("config.json"));
            let mut requests = Vec::new();
            let path = download_update_asset_with_request(
                &store,
                "2.0.0",
                &asset,
                CodeyUpdateDownloadSource::GhProxy,
                |url| {
                    requests.push(url);
                    let response = if requests.len() == 2 {
                        Ok(download_response(200, b"verified installer"))
                    } else {
                        match failure {
                            0 => Err("mock connection failure".to_string()),
                            1 => Ok(download_response(503, b"unavailable")),
                            2 => Ok(download_response(200, b"corrupt! installer")),
                            3 => Ok(download_response(200, b"short")),
                            _ => Ok(download_response(200, b"installer larger than expected")),
                        }
                    };
                    std::future::ready(response)
                },
            )
            .await
            .unwrap();
            assert_eq!(
                requests,
                update_download_urls(&asset, CodeyUpdateDownloadSource::GhProxy)
            );
            assert_eq!(tokio::fs::read(&path).await.unwrap(), b"verified installer");
            assert!(
                !path
                    .parent()
                    .unwrap()
                    .join(format!(".{}.download", asset.file_name))
                    .exists()
            );
        }
    }

    #[tokio::test]
    async fn update_download_rejects_bad_bodies_and_replaces_invalid_cache() {
        let asset = download_asset();
        for source in [
            CodeyUpdateDownloadSource::Github,
            CodeyUpdateDownloadSource::GhProxy,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store = ConfigStore::new(directory.path().join("config.json"));
            let cache = update_download_dir(&store).unwrap().join("v2.0.0");
            tokio::fs::create_dir_all(&cache).await.unwrap();
            let destination = cache.join(&asset.file_name);
            tokio::fs::write(&destination, b"corrupt! installer")
                .await
                .unwrap();
            let mut calls = 0;
            let error = download_update_asset_with_request(&store, "2.0.0", &asset, source, |_| {
                calls += 1;
                std::future::ready(Ok(download_response(200, b"corrupt! installer")))
            })
            .await
            .unwrap_err();
            assert!(error.contains("SHA-256"), "{error}");
            assert_eq!(
                calls,
                if source == CodeyUpdateDownloadSource::GhProxy {
                    2
                } else {
                    1
                }
            );
            assert!(
                !cache
                    .join(format!(".{}.download", asset.file_name))
                    .exists()
            );
            assert_eq!(
                tokio::fs::read(&destination).await.unwrap(),
                b"corrupt! installer"
            );
            download_update_asset_with_request(&store, "2.0.0", &asset, source, |_| {
                std::future::ready(Ok(download_response(200, b"verified installer")))
            })
            .await
            .unwrap();
            assert_eq!(
                tokio::fs::read(&destination).await.unwrap(),
                b"verified installer"
            );
        }
    }

    fn github_release(version: &str) -> GitHubRelease {
        let assets: Vec<_> = ["windows-x64-setup.exe", "macos-arm64-unsigned.zip"]
            .into_iter().map(|suffix| {
                let name = format!("CodeyX-{version}-{suffix}");
                json!({
                    "name": name,
                    "browser_download_url": format!("https://github.com/{REPOSITORY}/releases/download/v{version}/{name}"),
                    "size": 42,
                    "state": "uploaded",
                    "digest": format!("sha256:{}", "a".repeat(64)),
                })
            }).collect();
        serde_json::from_value(json!({
            "id": 123,
            "tag_name": format!("v{version}"),
            "name": format!("CodeyX v{version} · 更新公告"),
            "html_url": "https://other.example/untrusted-release",
            "draft": false,
            "prerelease": version.contains('-'),
            "body": "- Release 发布说明",
            "assets": assets,
        }))
        .unwrap()
    }

    #[test]
    fn github_update_source_requires_a_public_repository_endpoint() {
        assert_eq!(
            github_releases_repository("https://api.github.com/repos/fraternity-z/CodeyX/releases")
                .unwrap(),
            REPOSITORY,
        );
        for url in [
            "http://api.github.com/repos/fraternity-z/CodeyX/releases",
            "https://other.example/repos/fraternity-z/CodeyX/releases",
            "https://user@api.github.com/repos/fraternity-z/CodeyX/releases",
            "https://api.github.com/repos/fraternity-z/CodeyX/releases?token=value",
            "https://api.github.com/repos/fraternity-z/CodeyX/releases#fragment",
            "https://api.github.com/repos/fraternity-z/CodeyX/releases/latest",
        ] {
            assert!(github_releases_repository(url).is_err(), "{url}");
        }
    }

    #[test]
    fn github_release_announcements_keep_the_full_body_and_trusted_source() {
        let mut release = github_release("2.0.0");
        let body = "    保留代码缩进\n\n## 更新亮点\n\n![截图](https://example.test/image.png)\n\n<details><summary>完整变更</summary>正文</details>\n";
        release.body = Some(body.to_string());
        let check = assess_github_releases("1.0.0", &[release], REPOSITORY).unwrap();
        let value = serde_json::to_value(check).unwrap();
        assert_eq!(value["releaseNotes"], body);
        assert_eq!(value["releaseTitle"], "CodeyX v2.0.0 · 更新公告");
        assert_eq!(
            value["releaseUrl"],
            "https://github.com/fraternity-z/CodeyX/releases/tag/v2.0.0"
        );
    }

    #[test]
    fn github_releases_use_semver_and_filter_drafts_and_prereleases() {
        let mut draft = github_release("9.0.0");
        draft.draft = true;
        let mut marked_prerelease = github_release("3.0.0");
        marked_prerelease.prerelease = true;
        let mut unmarked_prerelease = github_release("4.0.0-beta.1");
        unmarked_prerelease.prerelease = false;
        let releases = vec![
            draft,
            marked_prerelease,
            github_release("nightly"),
            github_release("1.10.0"),
            unmarked_prerelease,
            github_release("1.9.0"),
        ];
        let stable = assess_github_releases("1.0.0", &releases, REPOSITORY).unwrap();
        assert_eq!(stable.latest_version, "1.10.0");
        assert_eq!(stable.release_notes.as_deref(), Some("- Release 发布说明"));
        assert_eq!(stable.release_id.as_deref(), Some("123"));
        assert!(stable.update_available);
        assert!(!stable.prerelease);
        let flagged = assess_github_releases("1.0.0", &releases[1..2], REPOSITORY).unwrap();
        assert!(!flagged.update_available);
    }

    #[test]
    fn github_releases_never_downgrade_or_update_only_for_build_metadata() {
        for (current, published) in [
            ("2.0.0", "1.9.0"),
            ("2.0.0", "2.0.0"),
            ("2.0.0-beta.2", "1.9.0"),
            ("2.0.0+one", "2.0.0+two"),
        ] {
            let check =
                assess_github_releases(current, &[github_release(published)], REPOSITORY).unwrap();
            assert!(!check.update_available, "{current} -> {published}");
        }
        let check =
            assess_github_releases("2.0.0-beta.2", &[github_release("2.0.0")], REPOSITORY).unwrap();
        assert!(check.update_available);
        let empty = assess_github_releases("1.0.0", &[], REPOSITORY).unwrap();
        assert!(!empty.update_available);
        assert_eq!(empty.latest_version, "1.0.0");
        assert!(empty.selected_asset.is_none());
    }

    #[test]
    fn github_assets_match_platform_architecture_and_support_existing_package_names() {
        let mut release = github_release("2.0.0");
        let version = Version::parse("2.0.0").unwrap();
        let windows = github_release_asset(&release, &version, REPOSITORY, "windows", "x64")
            .unwrap()
            .unwrap();
        assert_eq!(windows.package_type, "nsis");
        assert_eq!(windows.sha256, "a".repeat(64));
        assert_eq!(windows.size, 42);
        assert!(
            github_release_asset(&release, &version, REPOSITORY, "windows", "arm64")
                .unwrap()
                .is_none()
        );
        let macos = github_release_asset(&release, &version, REPOSITORY, "macos", "arm64")
            .unwrap()
            .unwrap();
        assert_eq!(macos.package_type, "app-zip");
        release.assets[0].name = release.assets[0].name.replace("CodeyX-", "Codey-");
        release.assets[0].browser_download_url = release.assets[0]
            .browser_download_url
            .replace("/CodeyX-", "/Codey-");
        let legacy = github_release_asset(&release, &version, REPOSITORY, "windows", "x64")
            .unwrap()
            .unwrap();
        assert!(legacy.file_name.starts_with("Codey-"));
        release.assets[0].state = "open".into();
        assert!(
            github_release_asset(&release, &version, REPOSITORY, "windows", "x64")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn github_assets_require_the_same_release_and_valid_digest() {
        let version = Version::parse("2.0.0").unwrap();
        for digest in [None, Some("md5:abc".into()), Some("sha256:invalid".into())] {
            let mut release = github_release("2.0.0");
            release.assets[0].digest = digest;
            assert!(
                github_release_asset(&release, &version, REPOSITORY, "windows", "x64")
                    .unwrap_err()
                    .contains("SHA-256")
            );
        }
        for url in [
            "https://other.example/setup.exe",
            "https://github.com/other/repo/releases/download/v2.0.0/CodeyX-2.0.0-windows-x64-setup.exe",
            "https://github.com/fraternity-z/CodeyX/releases/download/v1.0.0/CodeyX-2.0.0-windows-x64-setup.exe",
        ] {
            let mut release = github_release("2.0.0");
            release.assets[0].browser_download_url = url.into();
            assert!(
                github_release_asset(&release, &version, REPOSITORY, "windows", "x64").is_err()
            );
        }
        let mut release = github_release("2.0.0");
        release.assets[0].size = 0;
        assert!(github_release_asset(&release, &version, REPOSITORY, "windows", "x64").is_err());
        release.assets.clear();
        let check = assess_github_releases("1.0.0", &[release], REPOSITORY).unwrap();
        assert!(check.update_available);
        assert!(check.selected_asset.is_none());
    }

    #[tokio::test]
    async fn retired_device_api_does_not_read_or_rewrite_existing_identity() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState {
            store: ConfigStore::new(directory.path().join("config.json")),
            config: tokio::sync::RwLock::new(crate::config::CodeyConfig::default()),
            ..AppState::default()
        });
        let path = directory.path().join("release-device.json");
        tokio::fs::write(&path, b"existing-user-data")
            .await
            .unwrap();
        assert!(
            invoke(&state, "get_device_machine_no", &Value::Null)
                .await
                .is_err()
        );
        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"existing-user-data");
    }

    fn valid_asset() -> UpdateManifestAsset {
        UpdateManifestAsset {
            platform: current_update_platform().to_string(),
            arch: current_update_arch().to_string(),
            package_type: if cfg!(target_os = "windows") {
                "nsis"
            } else if cfg!(target_os = "macos") {
                "app-zip"
            } else {
                "unsupported"
            }
            .to_string(),
            file_name: "codey-update.pkg".to_string(),
            url: "https://updates.example.test/codey-update.pkg".to_string(),
            sha256: "a".repeat(64),
            size: 42,
        }
    }

    fn valid_manifest(version: &str) -> UpdateManifest {
        UpdateManifest {
            schema_version: 1,
            version: version.to_string(),
            tag: format!("v{version}"),
            release_notes: None,
            assets: vec![valid_asset()],
        }
    }

    fn install_check(version: &str, file_name: &str, contents: &[u8]) -> UpdateCheck {
        let mut asset = asset_info(&valid_asset());
        asset.file_name = file_name.to_string();
        asset.size = contents.len() as u64;
        asset.sha256 = format!("{:x}", Sha256::digest(contents));
        UpdateCheck {
            current_version: "1.0.0".to_string(),
            latest_version: version.to_string(),
            update_available: true,
            selected_asset: Some(asset),
            release_notes: None,
            release_title: None,
            release_url: None,
            release_id: None,
            prerelease: Version::parse(version).is_ok_and(|version| !version.pre.is_empty()),
        }
    }

    #[test]
    fn install_approval_rejects_changed_releases_or_assets() {
        let mut approved = install_check("2.0.0", "Codey.zip", b"package");
        approved.release_id = Some("123".into());
        assert!(validate_same_update(&approved, &approved).is_ok());
        let mut changed = approved.clone();
        changed.update_available = false;
        assert!(validate_same_update(&approved, &changed).is_err());
        let mut changed = approved.clone();
        changed.release_id = Some("456".into());
        assert!(validate_same_update(&approved, &changed).is_err());
        let mut changed = approved.clone();
        changed.prerelease = true;
        assert!(validate_same_update(&approved, &changed).is_err());
        let mut changed = approved.clone();
        changed.selected_asset.as_mut().unwrap().sha256 = "b".repeat(64);
        assert!(validate_same_update(&approved, &changed).is_err());
        let next = install_check("3.0.0", "Codey.zip", b"next");
        assert!(validate_same_update(&approved, &next).is_err());
    }

    #[test]
    fn update_manifest_validation_rejects_invalid_security_fields() {
        let mut manifest = valid_manifest("2.0.0");
        assert!(
            assess_update_manifest("1.0.0", &manifest)
                .unwrap()
                .update_available
        );

        manifest.tag = "v1.0.0".to_string();
        assert!(
            assess_update_manifest("1.0.0", &manifest)
                .unwrap_err()
                .contains("版本和标签不一致")
        );

        manifest = valid_manifest("2.0.0");
        manifest.assets[0].sha256 = "not-a-sha".to_string();
        assert!(
            assess_update_manifest("1.0.0", &manifest)
                .unwrap_err()
                .contains("SHA-256")
        );

        manifest = valid_manifest("2.0.0");
        manifest.assets[0].file_name = "../escape.pkg".to_string();
        assert!(
            assess_update_manifest("1.0.0", &manifest)
                .unwrap_err()
                .contains("文件名无效")
        );
    }

    #[test]
    fn update_manifest_equal_version_is_not_available() {
        let check = assess_update_manifest("2.0.0", &valid_manifest("2.0.0")).unwrap();

        assert!(!check.update_available);
        assert_eq!(check.current_version, "2.0.0");
        assert_eq!(check.latest_version, "2.0.0");
    }

    #[test]
    fn update_candidate_cache_obeys_url_and_ttl() {
        let checked_at = Instant::now();
        let candidate = UpdateCandidate {
            check: assess_update_manifest("1.0.0", &valid_manifest("2.0.0")).unwrap(),
        };
        let cached = CachedUpdateCandidate {
            releases_url: "https://updates.example.test/manifest.json".to_string(),
            candidate: candidate.clone(),
            checked_at,
        };

        assert_eq!(
            reusable_update_candidate(
                Some(&cached),
                "https://updates.example.test/manifest.json",
                checked_at + UPDATE_CHECK_CACHE_TTL - Duration::from_millis(1),
                UPDATE_CHECK_CACHE_TTL,
            )
            .unwrap()
            .check,
            candidate.check,
        );
        assert!(
            reusable_update_candidate(
                Some(&cached),
                "https://updates.example.test/manifest.json",
                checked_at + UPDATE_CHECK_CACHE_TTL,
                UPDATE_CHECK_CACHE_TTL,
            )
            .is_none()
        );
        assert!(
            reusable_update_candidate(
                Some(&cached),
                "https://mirror.example.test/manifest.json",
                checked_at,
                UPDATE_DOWNLOAD_CACHE_TTL,
            )
            .is_none()
        );
        assert!(
            reusable_update_candidate(
                Some(&cached),
                "https://updates.example.test/manifest.json",
                checked_at,
                Duration::ZERO,
            )
            .is_none()
        );
    }

    #[tokio::test]
    async fn manual_update_check_bypasses_fresh_cache() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState {
            store: ConfigStore::new(directory.path().join("config.json")),
            config: tokio::sync::RwLock::new(crate::config::CodeyConfig::default()),
            ..AppState::default()
        });
        // 非 HTTPS 地址让重新获取在校验阶段失败，避免测试依赖外部网络。
        let releases_url = "http://updates.example.test/manifest.json";
        {
            let mut config = state.config.write().await;
            config.codey_update_policy = crate::config::CodeyUpdatePolicy::Stable;
            config.github_releases_url = releases_url.to_string();
        }
        let check = assess_update_manifest("1.0.0", &valid_manifest("2.0.0")).unwrap();
        *state.update_candidate_cache.lock().await = Some(CachedUpdateCandidate {
            releases_url: format!("stable:{releases_url}"),
            candidate: UpdateCandidate {
                check: check.clone(),
            },
            checked_at: Instant::now(),
        });

        for args in [json!({}), json!({ "forceRefresh": false })] {
            assert_eq!(
                invoke(&state, "check_for_updates", &args).await.unwrap(),
                serde_json::to_value(&check).unwrap(),
            );
        }
        let error = invoke(
            &state,
            "check_for_updates",
            &json!({ "forceRefresh": true }),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "更新地址必须使用 HTTPS");
    }

    #[tokio::test]
    async fn disabled_policy_stops_automatic_updates_before_network() {
        let state = Arc::new(AppState::default());
        state.config.write().await.codey_update_policy = crate::config::CodeyUpdatePolicy::Off;
        for refresh in [false, true] {
            assert!(
                check_for_updates(&state, refresh, false)
                    .await
                    .unwrap_err()
                    .contains("自动检查")
            );
        }
        let candidate = UpdateCandidate {
            check: assess_update_manifest("1.0.0", &valid_manifest("2.0.0")).unwrap(),
        };
        assert!(
            download_update_candidate(&state, &candidate)
                .await
                .unwrap_err()
                .contains("自动检查")
        );
        assert!(
            resolve_expected_update(&state, UpdateRequestMode::Automatic)
                .await
                .unwrap_err()
                .contains("自动检查")
        );
        assert!(
            start_downloaded_update(&state, "unused")
                .await
                .unwrap_err()
                .contains("自动检查")
        );
    }

    #[tokio::test]
    async fn disabled_policy_allows_manual_stable_checks_downloads_and_install_validation() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState {
            store: ConfigStore::new(directory.path().join("config.json")),
            config: tokio::sync::RwLock::new(crate::config::CodeyConfig::default()),
            ..AppState::default()
        });
        let releases_url = "http://updates.example.test/manifest.json";
        {
            let mut config = state.config.write().await;
            config.codey_update_policy = crate::config::CodeyUpdatePolicy::Off;
            config.github_releases_url = releases_url.to_string();
        }
        let check = install_check("2.0.0", "codey-update.pkg", b"verified");
        *state.update_candidate_cache.lock().await = Some(CachedUpdateCandidate {
            releases_url: format!("stable:{releases_url}"),
            candidate: UpdateCandidate {
                check: check.clone(),
            },
            checked_at: Instant::now(),
        });
        *state.available_update.write().await = Some(check.clone());
        assert_eq!(
            invoke(&state, "check_for_updates", &json!({"manual": true}))
                .await
                .unwrap(),
            serde_json::to_value(&check).unwrap()
        );
        assert_eq!(
            update_policy(&state, UpdateRequestMode::Manual)
                .await
                .unwrap(),
            crate::config::CodeyUpdatePolicy::Stable,
        );
        assert_eq!(
            resolve_expected_update(&state, UpdateRequestMode::Manual)
                .await
                .unwrap_err(),
            "更新地址必须使用 HTTPS"
        );
        assert_eq!(
            invoke(
                &state,
                "check_for_updates",
                &json!({"manual": true, "forceRefresh": true})
            )
            .await
            .unwrap_err(),
            "更新地址必须使用 HTTPS"
        );
        assert_eq!(
            download_update(&state, &json!({})).await.unwrap_err(),
            "更新目标已变化，请重新检查并确认更新"
        );
        assert_eq!(
            start_downloaded_update_with_mode(&state, "relative.pkg", UpdateRequestMode::Manual)
                .await
                .unwrap_err(),
            "更新地址必须使用 HTTPS"
        );
    }

    #[tokio::test]
    async fn disabled_policy_rejects_manual_prerelease_downloads_and_install_validation() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState {
            store: ConfigStore::new(directory.path().join("config.json")),
            config: tokio::sync::RwLock::new(crate::config::CodeyConfig::default()),
            ..AppState::default()
        });
        {
            let mut config = state.config.write().await;
            config.codey_update_policy = crate::config::CodeyUpdatePolicy::Off;
        }
        let candidate = UpdateCandidate {
            check: install_check("2.0.0-beta.1", "codey-update.pkg", b"verified"),
        };
        *state.available_update.write().await = Some(candidate.check.clone());
        assert_eq!(
            download_update_candidate_with_mode(&state, &candidate, UpdateRequestMode::Manual)
                .await
                .unwrap_err(),
            "更新目标不符合当前更新策略"
        );
        assert!(
            !filter_update_policy(
                candidate.check,
                update_policy(&state, UpdateRequestMode::Manual)
                    .await
                    .unwrap(),
            )
            .unwrap()
            .update_available
        );
    }

    #[test]
    fn stable_policy_filters_prereleases() {
        use crate::config::CodeyUpdatePolicy::Stable;
        let beta = assess_update_manifest("1.0.0", &valid_manifest("2.0.0-beta.1")).unwrap();
        assert!(!filter_update_policy(beta, Stable).unwrap().update_available);
        let stable = assess_update_manifest("2.0.0-beta.2", &valid_manifest("2.0.0")).unwrap();
        assert!(
            filter_update_policy(stable, Stable)
                .unwrap()
                .update_available
        );
    }

    #[test]
    fn downloaded_update_path_must_be_a_file_inside_the_cache() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let update_root = directory.path().join("updates");
        let version_dir = update_root.join("v2.0.0");
        std::fs::create_dir_all(&version_dir).unwrap();
        let update = version_dir.join("codey-update.pkg");
        std::fs::write(&update, b"verified").unwrap();
        let outside = directory.path().join("outside.pkg");
        std::fs::write(&outside, b"outside").unwrap();

        assert_eq!(
            validate_downloaded_update_path(&store, update.to_str().unwrap()).unwrap(),
            update.canonicalize().unwrap()
        );
        assert!(
            validate_downloaded_update_path(&store, "relative.pkg")
                .unwrap_err()
                .contains("绝对路径")
        );
        assert!(
            validate_downloaded_update_path(&store, outside.to_str().unwrap())
                .unwrap_err()
                .contains("下载缓存")
        );
        assert!(
            validate_downloaded_update_path(&store, version_dir.to_str().unwrap())
                .unwrap_err()
                .contains("必须指向文件")
        );
    }

    #[tokio::test]
    async fn downloaded_update_is_reverified_immediately_before_install() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let version_dir = directory.path().join("updates/v2.0.0");
        std::fs::create_dir_all(&version_dir).unwrap();
        let update = version_dir.join("codey-update.pkg");
        let original = b"verified";
        std::fs::write(&update, original).unwrap();
        let check = install_check("2.0.0", "codey-update.pkg", original);

        assert_eq!(
            verify_downloaded_update(&store, update.to_str().unwrap(), &check)
                .await
                .unwrap()
                .path,
            update.canonicalize().unwrap()
        );

        // Keep the byte length unchanged so the digest check, rather than only
        // the metadata check, proves that replacement is rejected.
        std::fs::write(&update, b"tampered").unwrap();
        assert!(
            verify_downloaded_update(&store, update.to_str().unwrap(), &check)
                .await
                .unwrap_err()
                .contains("SHA-256")
        );
    }

    #[tokio::test]
    async fn downloaded_update_must_match_the_selected_version_and_file_name() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let version_dir = directory.path().join("updates/v2.0.0");
        std::fs::create_dir_all(&version_dir).unwrap();
        let unexpected = version_dir.join("other.pkg");
        let contents = b"verified";
        std::fs::write(&unexpected, contents).unwrap();
        let check = install_check("2.0.0", "codey-update.pkg", contents);

        assert!(
            verify_downloaded_update(&store, unexpected.to_str().unwrap(), &check)
                .await
                .unwrap_err()
                .contains("最近下载的版本")
        );
    }

    #[tokio::test]
    async fn downloaded_update_requires_a_current_valid_candidate() {
        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let mut check = install_check("2.0.0", "codey-update.pkg", b"verified");

        check.update_available = false;
        assert!(
            verify_downloaded_update(&store, "unused", &check)
                .await
                .unwrap_err()
                .contains("没有可安装")
        );

        check.update_available = true;
        check.selected_asset = None;
        assert!(
            verify_downloaded_update(&store, "unused", &check)
                .await
                .unwrap_err()
                .contains("适用于当前系统")
        );

        check = install_check("not-a-version", "codey-update.pkg", b"verified");
        assert!(
            verify_downloaded_update(&store, "unused", &check)
                .await
                .unwrap_err()
                .contains("版本无效")
        );
    }

    #[cfg(unix)]
    #[test]
    fn downloaded_update_path_rejects_symlinks_that_escape_the_cache() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(directory.path().join("config.json"));
        let update_root = directory.path().join("updates");
        std::fs::create_dir_all(&update_root).unwrap();
        let outside = directory.path().join("outside.pkg");
        std::fs::write(&outside, b"outside").unwrap();
        let link = update_root.join("linked.pkg");
        symlink(&outside, &link).unwrap();

        assert!(
            validate_downloaded_update_path(&store, link.to_str().unwrap())
                .unwrap_err()
                .contains("下载缓存")
        );
    }
}
