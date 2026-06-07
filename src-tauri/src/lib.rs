use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration as StdDuration, Instant, SystemTime},
};
use tauri::{Emitter, Manager, State};
use walkdir::{DirEntry, WalkDir};

const MAX_HASH_BYTES: u64 = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES: usize = 64 * 1024;
const PROGRESS_MIN_INTERVAL: StdDuration = StdDuration::from_millis(120);
const SETTINGS_FILE_NAME: &str = "settings.json";
const PROJECT_REPOSITORY_URL: &str = "https://github.com/yangbuyiya/tidy-mac";
const DEFAULT_LARGE_FILE_MB: u64 = 100;
const DEFAULT_OLD_FILE_DAYS: i64 = 180;

#[derive(Clone)]
struct ScannedFile {
    path: PathBuf,
    name: String,
    size: u64,
    modified: Option<DateTime<Utc>>,
    accessed: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanFile {
    id: String,
    path: String,
    name: String,
    size: u64,
    modified: Option<String>,
    accessed: Option<String>,
    categories: Vec<String>,
    risk: String,
    reasons: Vec<String>,
    duplicate_group: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanSummary {
    scanned_files: usize,
    total_bytes: u64,
    candidates: Vec<CleanFile>,
    skipped: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    phase: String,
    current_path: Option<String>,
    scanned_files: usize,
    total_bytes: u64,
}

impl ScanProgress {
    fn idle() -> Self {
        Self {
            phase: "等待扫描".to_string(),
            current_path: None,
            scanned_files: 0,
            total_bytes: 0,
        }
    }
}

#[derive(Clone)]
struct AllowedDeletion {
    size: u64,
    risk: String,
}

struct ScanRuntime {
    progress: ScanProgress,
    is_running: bool,
    active_scan_id: u64,
    cancel_token: Option<Arc<AtomicBool>>,
    allowed_deletions: HashMap<String, AllowedDeletion>,
}

impl ScanRuntime {
    fn new() -> Self {
        Self {
            progress: ScanProgress::idle(),
            is_running: false,
            active_scan_id: 0,
            cancel_token: None,
            allowed_deletions: HashMap::new(),
        }
    }
}

struct ScanRuntimeStore(Mutex<ScanRuntime>);

struct ScanState {
    scanned_files: usize,
    total_bytes: u64,
    last_emit: Instant,
}

impl ScanState {
    fn new() -> Self {
        Self {
            scanned_files: 0,
            total_bytes: 0,
            last_emit: Instant::now() - PROGRESS_MIN_INTERVAL,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteFailure {
    path: String,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteResult {
    deleted: usize,
    deleted_paths: Vec<String>,
    failed: Vec<DeleteFailure>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanTarget {
    id: String,
    label: String,
    path: String,
    enabled: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    #[serde(default)]
    scan_targets: Vec<ScanTarget>,
    #[serde(default = "default_scan_rules")]
    scan_rules: ScanRules,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanRules {
    large_file_mb: u64,
    old_file_days: i64,
    precise_duplicate_check: bool,
    file_type_rules: FileTypeRules,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileTypeRules {
    installer_extensions: Vec<String>,
    archive_extensions: Vec<String>,
    screenshot_extensions: Vec<String>,
    video_extensions: Vec<String>,
    log_extensions: Vec<String>,
    cache_path_keywords: Vec<String>,
}

#[tauri::command]
async fn scan_default_locations(
    app: tauri::AppHandle,
    runtime: State<'_, ScanRuntimeStore>,
) -> Result<ScanSummary, String> {
    run_scan(app, runtime, None).await
}

#[tauri::command]
async fn scan_by_extension(
    app: tauri::AppHandle,
    runtime: State<'_, ScanRuntimeStore>,
    extension: String,
) -> Result<ScanSummary, String> {
    let extension = normalize_requested_extension(&extension)?;
    run_scan(app, runtime, Some(extension)).await
}

async fn run_scan(
    app: tauri::AppHandle,
    runtime: State<'_, ScanRuntimeStore>,
    extension_filter: Option<String>,
) -> Result<ScanSummary, String> {
    let (scan_id, cancel_token) = {
        let mut runtime = runtime
            .0
            .lock()
            .map_err(|_| "扫描状态锁定失败".to_string())?;

        if runtime.is_running {
            return Err("已有扫描正在进行".to_string());
        }

        runtime.active_scan_id += 1;
        runtime.is_running = true;
        runtime.allowed_deletions.clear();
        runtime.progress = ScanProgress {
            phase: "准备扫描".to_string(),
            current_path: None,
            scanned_files: 0,
            total_bytes: 0,
        };

        let cancel_token = Arc::new(AtomicBool::new(false));
        runtime.cancel_token = Some(cancel_token.clone());
        (runtime.active_scan_id, cancel_token)
    };

    tauri::async_runtime::spawn_blocking(move || {
        let result =
            scan_default_locations_inner(app.clone(), scan_id, cancel_token, extension_filter);
        if let Some(runtime) = app.try_state::<ScanRuntimeStore>() {
            if let Ok(mut runtime) = runtime.0.lock() {
                if runtime.active_scan_id == scan_id {
                    runtime.is_running = false;
                    runtime.cancel_token = None;
                }
            }
        }
        result
    })
        .await
        .map_err(|error| format!("扫描线程失败: {error:?}"))?
}

#[tauri::command]
fn get_scan_progress(runtime: State<'_, ScanRuntimeStore>) -> ScanProgress {
    runtime
        .0
        .lock()
        .map(|runtime| runtime.progress.clone())
        .unwrap_or_else(|_| ScanProgress::idle())
}

#[tauri::command]
fn cancel_scan(runtime: State<'_, ScanRuntimeStore>) -> Result<(), String> {
    let runtime = runtime
        .0
        .lock()
        .map_err(|_| "扫描状态锁定失败".to_string())?;

    if let Some(cancel_token) = &runtime.cancel_token {
        cancel_token.store(true, Ordering::Relaxed);
    }

    Ok(())
}

#[tauri::command]
fn get_app_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    load_settings(&app)
}

#[tauri::command]
fn save_app_settings(app: tauri::AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    let settings = sanitize_settings(&app, settings)?;
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())?;
    Ok(settings)
}

fn scan_default_locations_inner(
    app: tauri::AppHandle,
    scan_id: u64,
    cancel_token: Arc<AtomicBool>,
    extension_filter: Option<String>,
) -> Result<ScanSummary, String> {
    let settings = load_settings(&app)?;
    let roots = selected_scan_roots_from(&settings)?;

    let mut scanned = Vec::new();
    let mut skipped = Vec::new();
    let mut state = ScanState::new();

    for root in roots {
        if cancel_token.load(Ordering::Relaxed) {
            return Err("扫描已取消".to_string());
        }
        scan_root(
            &app,
            &root,
            &mut scanned,
            &mut skipped,
            &mut state,
            &cancel_token,
            extension_filter.as_deref(),
        )?;
    }

    let scanned_files = state.scanned_files;
    let total_bytes = state.total_bytes;
    let duplicate_groups = if extension_filter.is_some() {
        HashMap::new()
    } else {
        emit_scan_progress(&app, "查找重复文件", None, scanned_files, total_bytes);
        detect_duplicates(
            &app,
            &scanned,
            scanned_files,
            total_bytes,
            &cancel_token,
            settings.scan_rules.precise_duplicate_check,
        )?
    };
    emit_scan_progress(&app, "生成结果", None, scanned_files, total_bytes);
    let mut candidates = Vec::new();

    for file in &scanned {
        if cancel_token.load(Ordering::Relaxed) {
            return Err("扫描已取消".to_string());
        }
        let candidate = if let Some(extension_filter) = extension_filter.as_deref() {
            Some(classify_extension_match(
                file,
                extension_filter,
                &settings.scan_rules,
            ))
        } else {
            classify_file(file, duplicate_groups.get(&file.path), &settings.scan_rules)
        };

        if let Some(candidate) = candidate {
            candidates.push(candidate);
        }
    }

    candidates.sort_by(|a, b| b.size.cmp(&a.size));
    update_allowed_deletions(&app, scan_id, &candidates);
    emit_scan_progress(&app, "完成", None, scanned_files, total_bytes);

    Ok(ScanSummary {
        scanned_files,
        total_bytes,
        candidates,
        skipped,
    })
}

#[tauri::command]
fn move_to_trash(paths: Vec<String>, runtime: State<'_, ScanRuntimeStore>) -> DeleteResult {
    let mut deleted = 0;
    let mut deleted_paths = Vec::new();
    let mut failed = Vec::new();

    for path in paths {
        let canonical = match fs::canonicalize(&path) {
            Ok(path) => path,
            Err(error) => {
                failed.push(DeleteFailure {
                    path,
                    reason: format!("路径不可访问: {error}"),
                });
                continue;
            }
        };

        if !canonical.is_file() {
            failed.push(DeleteFailure {
                path,
                reason: "只允许清理文件".to_string(),
            });
            continue;
        }

        let canonical_key = canonical.to_string_lossy().to_string();
        let allowed = runtime
            .0
            .lock()
            .ok()
            .and_then(|runtime| runtime.allowed_deletions.get(&canonical_key).cloned());

        let Some(allowed) = allowed else {
            failed.push(DeleteFailure {
                path,
                reason: "只能删除本次扫描结果中的文件".to_string(),
            });
            continue;
        };

        if allowed.risk == "protected" {
            failed.push(DeleteFailure {
                path,
                reason: "高风险文件已被保护".to_string(),
            });
            continue;
        }

        if canonical.metadata().map(|metadata| metadata.len()).unwrap_or(0) != allowed.size {
            failed.push(DeleteFailure {
                path,
                reason: "文件已变化，请重新扫描".to_string(),
            });
            continue;
        }

        match trash::delete(&canonical) {
            Ok(_) => {
                deleted += 1;
                deleted_paths.push(path.clone());
                if let Ok(mut runtime) = runtime.0.lock() {
                    runtime.allowed_deletions.remove(&canonical_key);
                }
            }
            Err(error) => failed.push(DeleteFailure {
                path: canonical_key,
                reason: error.to_string(),
            }),
        }
    }

    DeleteResult {
        deleted,
        deleted_paths,
        failed,
    }
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let status = Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("Finder 打开失败".to_string())
    }
}

#[tauri::command]
fn open_full_disk_access_settings() -> Result<(), String> {
    let status = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("无法打开完全磁盘访问设置".to_string())
    }
}

#[tauri::command]
fn open_project_repository() -> Result<(), String> {
    open::that(PROJECT_REPOSITORY_URL).map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ScanRuntimeStore(Mutex::new(ScanRuntime::new())))
        .invoke_handler(tauri::generate_handler![
            scan_default_locations,
            scan_by_extension,
            get_scan_progress,
            cancel_scan,
            get_app_settings,
            save_app_settings,
            move_to_trash,
            reveal_in_finder,
            open_full_disk_access_settings,
            open_project_repository
        ])
        .run(tauri::generate_context!())
        .expect("error while running tidy-mac");
}

fn scan_root(
    app: &tauri::AppHandle,
    root: &Path,
    scanned: &mut Vec<ScannedFile>,
    skipped: &mut Vec<String>,
    state: &mut ScanState,
    cancel_token: &Arc<AtomicBool>,
    extension_filter: Option<&str>,
) -> Result<(), String> {
    emit_scan_progress(
        app,
        "扫描文件",
        Some(root),
        state.scanned_files,
        state.total_bytes,
    );

    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !should_skip_entry(entry));

    for entry in walker {
        if cancel_token.load(Ordering::Relaxed) {
            return Err("扫描已取消".to_string());
        }

        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                skipped.push(error.to_string());
                continue;
            }
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                skipped.push(format!("{}: {}", entry.path().display(), error));
                continue;
            }
        };

        let path = entry.path().to_path_buf();
        let name = entry
            .file_name()
            .to_string_lossy()
            .trim()
            .to_string();

        if let Some(extension_filter) = extension_filter {
            if !matches_requested_extension(&name, extension_filter) {
                continue;
            }
        }

        let size = metadata.len();
        scanned.push(ScannedFile {
            path,
            name,
            size,
            modified: system_time_to_utc(metadata.modified().ok()),
            accessed: system_time_to_utc(metadata.accessed().ok()),
        });

        state.scanned_files += 1;
        state.total_bytes += size;

        let current = scanned.last().map(|file| file.path.as_path());
        emit_scan_progress_throttled(app, state, "扫描文件", current);
    }

    Ok(())
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(SETTINGS_FILE_NAME))
        .map_err(|error| error.to_string())
}

fn load_settings(app: &tauri::AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(default_settings()?);
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let stored = serde_json::from_str::<AppSettings>(&content).unwrap_or_else(|_| AppSettings {
        scan_targets: Vec::new(),
        scan_rules: default_scan_rules(),
    });
    sanitize_settings(app, stored)
}

fn default_settings() -> Result<AppSettings, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法读取用户主目录".to_string())?;
    let target = |id: &str, label: &str, path: PathBuf, enabled: bool| ScanTarget {
        id: id.to_string(),
        label: label.to_string(),
        path: path.to_string_lossy().to_string(),
        enabled,
    };

    Ok(AppSettings {
        scan_targets: vec![
            target("downloads", "下载", home.join("Downloads"), true),
            target("desktop", "桌面", home.join("Desktop"), true),
            target("documents", "文稿", home.join("Documents"), true),
            target("home", "用户目录", home, false),
        ],
        scan_rules: default_scan_rules(),
    })
}

fn default_scan_rules() -> ScanRules {
    ScanRules {
        large_file_mb: DEFAULT_LARGE_FILE_MB,
        old_file_days: DEFAULT_OLD_FILE_DAYS,
        precise_duplicate_check: false,
        file_type_rules: FileTypeRules {
            installer_extensions: vec![
                "dmg", "pkg", "mpkg", "appinstaller", "exe", "msi", "deb", "rpm",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            archive_extensions: vec!["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz"]
                .into_iter()
                .map(String::from)
                .collect(),
            screenshot_extensions: vec!["png", "jpg", "jpeg", "webp", "heic"]
                .into_iter()
                .map(String::from)
                .collect(),
            video_extensions: vec!["mov", "mp4", "mkv", "avi", "webm"]
                .into_iter()
                .map(String::from)
                .collect(),
            log_extensions: vec!["log", "trace", "out", "err"]
                .into_iter()
                .map(String::from)
                .collect(),
            cache_path_keywords: vec!["/Caches/", "/cache/", "/tmp/", "/temp/"]
                .into_iter()
                .map(String::from)
                .collect(),
        },
    }
}

fn sanitize_settings(
    _app: &tauri::AppHandle,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let defaults = default_settings()?;
    let stored = settings
        .scan_targets
        .into_iter()
        .map(|target| (target.id, target.enabled))
        .collect::<HashMap<_, _>>();

    let scan_targets = defaults
        .scan_targets
        .into_iter()
        .map(|mut target| {
            if let Some(enabled) = stored.get(&target.id) {
                target.enabled = *enabled;
            }
            target
        })
        .collect();

    Ok(AppSettings {
        scan_targets,
        scan_rules: sanitize_scan_rules(settings.scan_rules),
    })
}

fn selected_scan_roots_from(settings: &AppSettings) -> Result<Vec<PathBuf>, String> {
    let mut roots = settings
        .scan_targets
        .iter()
        .filter(|target| target.enabled)
        .map(|target| PathBuf::from(&target.path))
        .filter(|path| path.exists() && path.is_dir())
        .collect::<Vec<_>>();

    if roots.is_empty() {
        return Err("请先在设置里至少勾选一个扫描范围".to_string());
    }

    roots.sort_by(|a, b| {
        a.components()
            .count()
            .cmp(&b.components().count())
            .then_with(|| a.cmp(b))
    });

    let mut pruned = Vec::new();
    'root: for root in roots {
        for parent in &pruned {
            if root.starts_with(parent) {
                continue 'root;
            }
        }
        pruned.push(root);
    }

    Ok(pruned)
}

fn sanitize_scan_rules(rules: ScanRules) -> ScanRules {
    let defaults = default_scan_rules();
    ScanRules {
        large_file_mb: rules.large_file_mb.clamp(1, 1024 * 1024),
        old_file_days: rules.old_file_days.clamp(1, 3650),
        precise_duplicate_check: rules.precise_duplicate_check,
        file_type_rules: FileTypeRules {
            installer_extensions: normalize_extensions(
                rules.file_type_rules.installer_extensions,
                defaults.file_type_rules.installer_extensions,
            ),
            archive_extensions: normalize_extensions(
                rules.file_type_rules.archive_extensions,
                defaults.file_type_rules.archive_extensions,
            ),
            screenshot_extensions: normalize_extensions(
                rules.file_type_rules.screenshot_extensions,
                defaults.file_type_rules.screenshot_extensions,
            ),
            video_extensions: normalize_extensions(
                rules.file_type_rules.video_extensions,
                defaults.file_type_rules.video_extensions,
            ),
            log_extensions: normalize_extensions(
                rules.file_type_rules.log_extensions,
                defaults.file_type_rules.log_extensions,
            ),
            cache_path_keywords: normalize_keywords(
                rules.file_type_rules.cache_path_keywords,
                defaults.file_type_rules.cache_path_keywords,
            ),
        },
    }
}

fn normalize_extensions(values: Vec<String>, fallback: Vec<String>) -> Vec<String> {
    let mut normalized = values
        .into_iter()
        .flat_map(|value| {
            value
                .split(',')
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .map(|value| value.trim().trim_start_matches('.').to_lowercase())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 32
                && value
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        })
        .collect::<Vec<_>>();

    normalized.sort();
    normalized.dedup();

    if normalized.is_empty() {
        fallback
    } else {
        normalized
    }
}

fn normalize_keywords(values: Vec<String>, fallback: Vec<String>) -> Vec<String> {
    let mut normalized = values
        .into_iter()
        .flat_map(|value| {
            value
                .split(',')
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.len() <= 80)
        .collect::<Vec<_>>();

    normalized.sort();
    normalized.dedup();

    if normalized.is_empty() {
        fallback
    } else {
        normalized
    }
}

fn should_skip_entry(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    let path_text = entry.path().to_string_lossy();

    if name == ".DS_Store" {
        return true;
    }

    let protected_names = [
        ".git",
        ".ssh",
        ".gnupg",
        "node_modules",
        "target",
        ".Trash",
    ];

    protected_names.iter().any(|protected| name == *protected)
        || path_text.contains("/Library/Application Support/")
        || path_text.contains("/Library/Keychains/")
}

fn detect_duplicates(
    app: &tauri::AppHandle,
    files: &[ScannedFile],
    scanned_files: usize,
    total_bytes: u64,
    cancel_token: &Arc<AtomicBool>,
    precise: bool,
) -> Result<HashMap<PathBuf, String>, String> {
    let mut by_size: HashMap<u64, Vec<&ScannedFile>> = HashMap::new();
    for file in files {
        if file.size > 0 && file.size <= MAX_HASH_BYTES {
            by_size.entry(file.size).or_default().push(file);
        }
    }

    let mut duplicates = HashMap::new();
    let mut group_index = 1;
    let mut hashed_files = 0;
    let mut last_emit = Instant::now() - PROGRESS_MIN_INTERVAL;

    for same_size_files in by_size.values() {
        if cancel_token.load(Ordering::Relaxed) {
            return Err("扫描已取消".to_string());
        }

        if same_size_files.len() < 2 {
            continue;
        }

        let mut by_quick_hash: HashMap<String, Vec<&ScannedFile>> = HashMap::new();
        for file in same_size_files {
            if cancel_token.load(Ordering::Relaxed) {
                return Err("扫描已取消".to_string());
            }

            if let Ok(hash) = quick_hash_file(file) {
                by_quick_hash.entry(hash).or_default().push(file);
                hashed_files += 1;
                if last_emit.elapsed() >= PROGRESS_MIN_INTERVAL {
                    let phase = format!("查找重复文件 {}", hashed_files);
                    emit_scan_progress(
                        app,
                        &phase,
                        Some(&file.path),
                        scanned_files,
                        total_bytes,
                    );
                    last_emit = Instant::now();
                }
            }
        }

        for quick_group in by_quick_hash.values() {
            if quick_group.len() < 2 {
                continue;
            }

            if precise {
                let mut by_full_hash: HashMap<String, Vec<&ScannedFile>> = HashMap::new();
                for file in quick_group {
                    if cancel_token.load(Ordering::Relaxed) {
                        return Err("扫描已取消".to_string());
                    }

                    if let Ok(hash) = full_hash_file(file) {
                        by_full_hash.entry(hash).or_default().push(file);
                        hashed_files += 1;
                        if last_emit.elapsed() >= PROGRESS_MIN_INTERVAL {
                            let phase = format!("精确确认重复文件 {}", hashed_files);
                            emit_scan_progress(
                                app,
                                &phase,
                                Some(&file.path),
                                scanned_files,
                                total_bytes,
                            );
                            last_emit = Instant::now();
                        }
                    }
                }

                for full_group in by_full_hash.values() {
                    if full_group.len() < 2 {
                        continue;
                    }

                    let group_id = format!("dup-{}", group_index);
                    group_index += 1;
                    for file in full_group {
                        duplicates.insert(file.path.clone(), group_id.clone());
                    }
                }
            } else {
                let group_id = format!("dup-{}", group_index);
                group_index += 1;
                for file in quick_group {
                    duplicates.insert(file.path.clone(), group_id.clone());
                }
            }
        }
    }

    Ok(duplicates)
}

fn emit_scan_progress_throttled(
    app: &tauri::AppHandle,
    state: &mut ScanState,
    phase: &str,
    current_path: Option<&Path>,
) {
    if state.last_emit.elapsed() < PROGRESS_MIN_INTERVAL {
        return;
    }

    emit_scan_progress(
        app,
        phase,
        current_path,
        state.scanned_files,
        state.total_bytes,
    );
    state.last_emit = Instant::now();
}

fn emit_scan_progress(
    app: &tauri::AppHandle,
    phase: &str,
    current_path: Option<&Path>,
    scanned_files: usize,
    total_bytes: u64,
) {
    let progress = ScanProgress {
        phase: phase.to_string(),
        current_path: current_path.map(|path| path.to_string_lossy().to_string()),
        scanned_files,
        total_bytes,
    };

    if let Some(store) = app.try_state::<ScanRuntimeStore>() {
        if let Ok(mut runtime) = store.0.lock() {
            runtime.progress = progress.clone();
        }
    }

    let _ = app.emit("scan-progress", progress);
}

fn update_allowed_deletions(app: &tauri::AppHandle, scan_id: u64, candidates: &[CleanFile]) {
    let Some(runtime) = app.try_state::<ScanRuntimeStore>() else {
        return;
    };

    let allowed_deletions = candidates
        .iter()
        .filter(|file| file.risk != "protected")
        .filter_map(|file| {
            let canonical = fs::canonicalize(&file.path).ok()?;
            if !canonical.is_file() || is_protected_path(&canonical) {
                return None;
            }

            Some((
                canonical.to_string_lossy().to_string(),
                AllowedDeletion {
                    size: file.size,
                    risk: file.risk.clone(),
                },
            ))
        })
        .collect::<HashMap<_, _>>();

    if let Ok(mut runtime) = runtime.0.lock() {
        if runtime.active_scan_id == scan_id {
            runtime.allowed_deletions = allowed_deletions;
        }
    };
}

fn classify_file(
    file: &ScannedFile,
    duplicate_group: Option<&String>,
    rules: &ScanRules,
) -> Option<CleanFile> {
    let extension = file_extension(&file.name);
    let mut reasons = Vec::new();
    let mut categories = Vec::new();
    let large_file_bytes = rules.large_file_mb.saturating_mul(1024 * 1024);

    if file.size == 0 {
        categories.push("empty".to_string());
        reasons.push("空文件，可检查是否需要保留".to_string());
    }

    if duplicate_group.is_some() {
        categories.push("duplicate".to_string());
        if rules.precise_duplicate_check {
            reasons.push("重复文件已通过完整 hash 确认".to_string());
        } else {
            reasons.push("疑似重复文件，需确认".to_string());
        }
    }

    if large_file_bytes > 0 && file.size >= large_file_bytes {
        categories.push("large".to_string());
        reasons.push(format!("文件大于 {}", human_size(large_file_bytes)));
    }

    if is_extension_match(&extension, &rules.file_type_rules.installer_extensions) {
        categories.push("installer".to_string());
        reasons.push("安装包通常安装后不再需要".to_string());
    }

    if is_extension_match(&extension, &rules.file_type_rules.archive_extensions) {
        categories.push("archive".to_string());
        reasons.push("压缩包容易长期堆积".to_string());
    }

    if is_screenshot(file, &extension, rules) {
        categories.push("screenshot".to_string());
        reasons.push("截图文件可集中检查".to_string());
    }

    if is_extension_match(&extension, &rules.file_type_rules.video_extensions)
        && file.size >= 30 * 1024 * 1024
    {
        categories.push("video".to_string());
        reasons.push("视频文件体积较大".to_string());
    }

    if is_extension_match(&extension, &rules.file_type_rules.log_extensions) {
        categories.push("log".to_string());
        reasons.push("日志文件容易长期堆积".to_string());
    }

    if is_cache_file(file, rules) {
        categories.push("cache".to_string());
        reasons.push("位于缓存或临时目录".to_string());
    }

    if is_old_file(file, rules.old_file_days) {
        categories.push("old".to_string());
        reasons.push(format!("超过 {} 天未活跃", rules.old_file_days));
    }

    if categories.is_empty() {
        return None;
    }

    let risk = risk_level(&extension, &file.path, &categories);

    Some(CleanFile {
        id: file.path.to_string_lossy().to_string(),
        path: file.path.to_string_lossy().to_string(),
        name: file.name.clone(),
        size: file.size,
        modified: file.modified.map(|date| date.to_rfc3339()),
        accessed: file.accessed.map(|date| date.to_rfc3339()),
        categories,
        risk,
        reasons,
        duplicate_group: duplicate_group.cloned(),
    })
}

fn normalize_requested_extension(extension: &str) -> Result<String, String> {
    let normalized = extension
        .trim()
        .trim_start_matches('.')
        .trim()
        .to_lowercase();

    if normalized.is_empty() {
        return Err("请输入要扫描的文件后缀，例如 log、zip、mp4".to_string());
    }

    if normalized.len() > 32
        || normalized
            .chars()
            .any(|ch| !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')))
    {
        return Err("后缀只能包含字母、数字、点、下划线或短横线".to_string());
    }

    Ok(normalized)
}

fn matches_requested_extension(name: &str, extension_filter: &str) -> bool {
    let lower_name = name.to_lowercase();
    let suffix = format!(".{extension_filter}");
    lower_name.ends_with(&suffix)
}

fn classify_extension_match(
    file: &ScannedFile,
    extension_filter: &str,
    rules: &ScanRules,
) -> CleanFile {
    let extension = file_extension(&file.name);
    let mut categories = vec!["extension".to_string()];
    let mut reasons = vec![format!("匹配 .{} 后缀", extension_filter)];
    let large_file_bytes = rules.large_file_mb.saturating_mul(1024 * 1024);

    if file.size == 0 {
        categories.push("empty".to_string());
        reasons.push("空文件，可检查是否需要保留".to_string());
    }

    if large_file_bytes > 0 && file.size >= large_file_bytes {
        categories.push("large".to_string());
        reasons.push(format!("文件大于 {}", human_size(large_file_bytes)));
    }

    if is_extension_match(&extension, &rules.file_type_rules.installer_extensions) {
        categories.push("installer".to_string());
        reasons.push("安装包通常安装后不再需要".to_string());
    }

    if is_extension_match(&extension, &rules.file_type_rules.archive_extensions) {
        categories.push("archive".to_string());
        reasons.push("压缩包容易长期堆积".to_string());
    }

    if is_screenshot(file, &extension, rules) {
        categories.push("screenshot".to_string());
        reasons.push("截图文件可集中检查".to_string());
    }

    if is_extension_match(&extension, &rules.file_type_rules.video_extensions)
        && file.size >= 30 * 1024 * 1024
    {
        categories.push("video".to_string());
        reasons.push("视频文件体积较大".to_string());
    }

    if is_extension_match(&extension, &rules.file_type_rules.log_extensions) {
        categories.push("log".to_string());
        reasons.push("日志文件容易长期堆积".to_string());
    }

    if is_cache_file(file, rules) {
        categories.push("cache".to_string());
        reasons.push("位于缓存或临时目录".to_string());
    }

    if is_old_file(file, rules.old_file_days) {
        categories.push("old".to_string());
        reasons.push(format!("超过 {} 天未活跃", rules.old_file_days));
    }

    let risk = risk_level(&extension, &file.path, &categories);

    CleanFile {
        id: file.path.to_string_lossy().to_string(),
        path: file.path.to_string_lossy().to_string(),
        name: file.name.clone(),
        size: file.size,
        modified: file.modified.map(|date| date.to_rfc3339()),
        accessed: file.accessed.map(|date| date.to_rfc3339()),
        categories,
        risk,
        reasons,
        duplicate_group: None,
    }
}

fn risk_level(extension: &str, path: &Path, categories: &[String]) -> String {
    let protected_extensions = [
        "db", "sqlite", "sqlite3", "pem", "key", "p12", "crt", "cer", "env", "yaml", "yml",
        "toml", "ini", "lock", "gradle", "xcodeproj",
    ];

    if protected_extensions.contains(&extension) || is_protected_path(path) {
        return "protected".to_string();
    }

    if categories
        .iter()
        .all(|category| {
            matches!(
                category.as_str(),
                "installer" | "archive" | "screenshot" | "empty" | "cache" | "log"
            )
        })
    {
        "safe".to_string()
    } else {
        "review".to_string()
    }
}

fn is_protected_path(path: &Path) -> bool {
    let path_text = path.to_string_lossy();

    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy();
        matches!(name.as_ref(), ".ssh" | ".git" | ".gnupg" | ".Trash")
    }) || path_text.contains("/Library/Application Support/")
        || path_text.contains("/Library/Keychains/")
}

fn quick_hash_file(file: &ScannedFile) -> Result<String, String> {
    let mut source = File::open(&file.path).map_err(|error| error.to_string())?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&file.size.to_le_bytes());

    let mut buffer = vec![0u8; HASH_CHUNK_BYTES];
    let read = source
        .read(&mut buffer)
        .map_err(|error| error.to_string())?;
    hasher.update(&buffer[..read]);

    if file.size > HASH_CHUNK_BYTES as u64 {
        let tail_offset = file.size.saturating_sub(HASH_CHUNK_BYTES as u64);
        source
            .seek(SeekFrom::Start(tail_offset))
            .map_err(|error| error.to_string())?;
        let read = source
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        hasher.update(&buffer[..read]);
    }

    Ok(hasher.finalize().to_hex().to_string())
}

fn full_hash_file(file: &ScannedFile) -> Result<String, String> {
    let mut source = File::open(&file.path).map_err(|error| error.to_string())?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&file.size.to_le_bytes());

    let mut buffer = vec![0u8; HASH_CHUNK_BYTES];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    Ok(hasher.finalize().to_hex().to_string())
}

fn is_old_file(file: &ScannedFile, old_file_days: i64) -> bool {
    let threshold = Utc::now() - Duration::days(old_file_days);
    file.accessed
        .or(file.modified)
        .map(|date| date < threshold)
        .unwrap_or(false)
}

fn file_extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn is_extension_match(extension: &str, extensions: &[String]) -> bool {
    extensions.iter().any(|value| value == extension)
}

fn is_screenshot(file: &ScannedFile, extension: &str, rules: &ScanRules) -> bool {
    let lower = file.name.to_lowercase();
    is_extension_match(extension, &rules.file_type_rules.screenshot_extensions)
        && (lower.contains("screenshot")
            || lower.contains("screen shot")
            || lower.contains("截屏")
            || lower.contains("截图"))
}

fn is_cache_file(file: &ScannedFile, rules: &ScanRules) -> bool {
    let path_text = file.path.to_string_lossy().to_lowercase();
    rules
        .file_type_rules
        .cache_path_keywords
        .iter()
        .map(|keyword| keyword.to_lowercase())
        .any(|keyword| path_text.contains(&keyword))
}

fn system_time_to_utc(time: Option<SystemTime>) -> Option<DateTime<Utc>> {
    time.map(DateTime::<Utc>::from)
}

fn human_size(bytes: u64) -> String {
    let mb = bytes / 1024 / 1024;
    format!("{} MB", mb)
}
