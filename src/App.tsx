import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  Eraser,
  FileArchive,
  FileImage,
  FileSearch,
  FileText,
  FolderTree,
  FolderOpen,
  HardDrive,
  ExternalLink,
  Github,
  Info,
  Loader2,
  Play,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserRound,
  X,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type RiskLevel = "safe" | "review" | "protected";

type CleanFile = {
  id: string;
  path: string;
  name: string;
  size: number;
  modified: string | null;
  accessed: string | null;
  categories: string[];
  risk: RiskLevel;
  reasons: string[];
  duplicateGroup: string | null;
};

type ScanSummary = {
  scannedFiles: number;
  totalBytes: number;
  candidates: CleanFile[];
  skipped: string[];
};

type ScanProgress = {
  phase: string;
  currentPath: string | null;
  scannedFiles: number;
  totalBytes: number;
};

type DeleteResult = {
  deleted: number;
  deletedPaths: string[];
  deleted_paths?: string[];
  failed: Array<{ path: string; reason: string }>;
};

type FolderGroup = {
  path: string;
  count: number;
  bytes: number;
};

type ScanTarget = {
  id: string;
  label: string;
  path: string;
  enabled: boolean;
};

type AppSettings = {
  scanTargets: ScanTarget[];
  scanRules: ScanRules;
};

type ScanRules = {
  largeFileMb: number;
  oldFileDays: number;
  preciseDuplicateCheck: boolean;
  fileTypeRules: FileTypeRules;
};

type FileTypeRules = {
  installerExtensions: string[];
  archiveExtensions: string[];
  screenshotExtensions: string[];
  videoExtensions: string[];
  logExtensions: string[];
  cachePathKeywords: string[];
};

type CategoryKey =
  | "all"
  | "folders"
  | "extension"
  | "empty"
  | "cache"
  | "log"
  | "large"
  | "duplicate"
  | "installer"
  | "archive"
  | "screenshot"
  | "video"
  | "old";

type UpdateStatus = "idle" | "checking" | "downloading" | "installing" | "latest" | "ready" | "error";

type UpdateState = {
  status: UpdateStatus;
  message: string;
  progress: number;
  version?: string;
  detail?: string;
};

const categories: Array<{
  key: CategoryKey;
  label: string;
  icon: LucideIcon;
}> = [
  { key: "all", label: "全部", icon: FileSearch },
  { key: "folders", label: "按文件夹", icon: FolderTree },
  { key: "extension", label: "后缀扫描", icon: FileSearch },
  { key: "empty", label: "空文件", icon: FileText },
  { key: "cache", label: "缓存目录", icon: Archive },
  { key: "log", label: "日志文件", icon: FileText },
  { key: "large", label: "大文件", icon: HardDrive },
  { key: "duplicate", label: "重复文件", icon: Copy },
  { key: "installer", label: "安装包", icon: Download },
  { key: "archive", label: "压缩包", icon: FileArchive },
  { key: "screenshot", label: "截图", icon: FileImage },
  { key: "video", label: "录屏视频", icon: Video },
  { key: "old", label: "旧文件", icon: Clock3 },
];

const riskLabels: Record<RiskLevel, string> = {
  safe: "安全",
  review: "需确认",
  protected: "高风险",
};

const ROW_HEIGHT = 88;
const FOLDER_ROW_HEIGHT = 54;
const VIRTUAL_OVERSCAN = 8;
const APP_VERSION = __APP_VERSION__;
const REPOSITORY_URL = "https://github.com/yangbuyiya/tidy-mac";
const UPDATE_ENDPOINT = "GitHub Releases / latest.json";

const UPDATE_STATUS_LABELS: Record<UpdateStatus, string> = {
  idle: "尚未检查",
  checking: "检查中",
  downloading: "下载中",
  installing: "安装中",
  latest: "已是最新",
  ready: "待重启",
  error: "检查失败",
};

const INITIAL_UPDATE_STATE: UpdateState = {
  status: "idle",
  message: "尚未检查更新",
  progress: 0,
};

const authorInfoPlaceholders = [
  { label: "作者", value: "杨不易" },
  { label: "主页", value: "https://github.com/yangbuyiya/" },
  { label: "联系方式", value: "WeChat yangbuyiya" },
];

const projectInfoItems = [
  { label: "许可证", value: "待补充" },
  { label: "反馈入口", value: "GitHub Issues" },
  { label: "更新渠道", value: "GitHub Releases" },
];

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function categoryMatches(file: CleanFile, category: CategoryKey): boolean {
  if (category === "all" || category === "folders") return true;
  return file.categories.includes(category);
}

function parentFolder(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "/";
}

function buildFolderGroups(files: CleanFile[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const file of files) {
    const folder = parentFolder(file.path);
    const group = groups.get(folder) ?? { path: folder, count: 0, bytes: 0 };
    group.count += 1;
    group.bytes += file.size;
    groups.set(folder, group);
  }

  return Array.from(groups.values()).sort((a, b) => b.bytes - a.bytes);
}

function formatList(values: string[]): string {
  return values.join(", ");
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeUpdateError(error: unknown): Pick<UpdateState, "message" | "detail"> {
  const raw = String(error);
  if (raw.includes("Could not fetch a valid release JSON")) {
    return {
      message: "还没有发布可用更新",
      detail: "GitHub Releases 里缺少 latest.json 或更新包，发布第一个版本后即可检查。",
    };
  }

  if (raw.includes("signature") || raw.includes("pubkey")) {
    return {
      message: "更新包签名校验失败",
      detail: "请确认 latest.json、签名文件和应用内公钥来自同一把 Tauri 签名密钥。",
    };
  }

  return {
    message: "自动更新检查失败",
    detail: raw,
  };
}

export function App() {
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [folderGroups, setFolderGroups] = useState<FolderGroup[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeCategory, setActiveCategory] = useState<CategoryKey>("all");
  const [isScanning, setIsScanning] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [extensionInput, setExtensionInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(INITIAL_UPDATE_STATE);
  const tableRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [tableHeight, setTableHeight] = useState(520);

  const visibleFiles = useMemo(() => {
    const files = summary?.candidates ?? [];
    return files
      .filter((file) => categoryMatches(file, activeCategory))
      .filter((file) => !selectedFolder || parentFolder(file.path) === selectedFolder)
      .sort((a, b) => b.size - a.size);
  }, [activeCategory, selectedFolder, summary]);

  const selectedFiles = useMemo(() => {
    const files = summary?.candidates ?? [];
    return files.filter((file) => selectedIds.has(file.id));
  }, [selectedIds, summary]);
  const riskSummary = useMemo(() => {
    const files = summary?.candidates ?? [];
    return files.reduce(
      (result, file) => {
        result[file.risk].count += 1;
        result[file.risk].bytes += file.size;
        return result;
      },
      {
        safe: { count: 0, bytes: 0 },
        review: { count: 0, bytes: 0 },
        protected: { count: 0, bytes: 0 },
      } satisfies Record<RiskLevel, { count: number; bytes: number }>,
    );
  }, [summary]);

  const selectedBytes = selectedFiles.reduce((total, file) => total + file.size, 0);
  const updateBusy =
    updateState.status === "checking" ||
    updateState.status === "downloading" ||
    updateState.status === "installing";
  const scannedFilesCount = summary?.scannedFiles ?? scanProgress?.scannedFiles ?? null;
  const scanTotalBytes = scanProgress?.totalBytes ?? summary?.totalBytes ?? 0;
  const safeVisibleIds = visibleFiles
    .filter((file) => file.risk !== "protected")
    .map((file) => file.id);
  const isFolderMode = activeCategory === "folders" && !selectedFolder;
  const folderScrollTop = isFolderMode ? scrollTop : 0;
  const rawFolderVirtualStart = Math.max(
    0,
    Math.floor(Math.max(folderScrollTop - 42, 0) / FOLDER_ROW_HEIGHT) - VIRTUAL_OVERSCAN,
  );
  const folderVirtualStart = Math.min(rawFolderVirtualStart, folderGroups.length);
  const folderVirtualEnd = Math.min(
    folderGroups.length,
    Math.ceil((Math.max(folderScrollTop - 42, 0) + tableHeight) / FOLDER_ROW_HEIGHT) +
      VIRTUAL_OVERSCAN,
  );
  const virtualFolderGroups = folderGroups.slice(folderVirtualStart, folderVirtualEnd);
  const folderBeforeHeight = folderVirtualStart * FOLDER_ROW_HEIGHT;
  const folderAfterHeight = Math.max(
    0,
    (folderGroups.length - folderVirtualEnd) * FOLDER_ROW_HEIGHT,
  );
  const rawVirtualStart = Math.max(
    0,
    Math.floor(Math.max(scrollTop - 42, 0) / ROW_HEIGHT) - VIRTUAL_OVERSCAN,
  );
  const virtualStart = Math.min(rawVirtualStart, visibleFiles.length);
  const virtualEnd = Math.min(
    visibleFiles.length,
    Math.ceil((Math.max(scrollTop - 42, 0) + tableHeight) / ROW_HEIGHT) + VIRTUAL_OVERSCAN,
  );
  const virtualFiles = visibleFiles.slice(virtualStart, virtualEnd);
  const beforeHeight = virtualStart * ROW_HEIGHT;
  const afterHeight = Math.max(0, (visibleFiles.length - virtualEnd) * ROW_HEIGHT);

  useEffect(() => {
    void loadSettings();
  }, []);

  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;

    const updateHeight = () => setTableHeight(table.clientHeight || 520);
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(table);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setScrollTop(0);
    tableRef.current?.scrollTo({ top: 0 });
  }, [activeCategory, summary]);

  useEffect(() => {
    if (activeCategory !== "folders") {
      setSelectedFolder(null);
    }
  }, [activeCategory]);

  async function scan() {
    setSettingsOpen(false);
    await runScan(() => invoke<ScanSummary>("scan_default_locations"), {
      nextCategory: "all",
      completeMessage: (nextSummary) =>
        `扫描完成，发现 ${nextSummary.candidates.length} 个可检查文件。`,
    });
  }

  async function scanExtension() {
    const extension = extensionInput.trim();
    if (!extension) {
      setMessage("请输入要扫描的文件后缀，例如 log、zip、mp4。");
      return;
    }

    setSettingsOpen(false);
    await runScan(
      () =>
        invoke<ScanSummary>("scan_by_extension", {
          extension,
        }),
      {
        nextCategory: "extension",
        completeMessage: (nextSummary) =>
          `后缀扫描完成，发现 ${nextSummary.candidates.length} 个匹配文件。`,
      },
    );
  }

  async function runScan(
    request: () => Promise<ScanSummary>,
    options: {
      nextCategory: CategoryKey;
      completeMessage: (nextSummary: ScanSummary) => string;
    },
  ) {
    setIsScanning(true);
    setMessage(null);
    setSummary(null);
    setFolderGroups([]);
    setScanProgress({
      phase: "准备扫描",
      currentPath: null,
      scannedFiles: 0,
      totalBytes: 0,
    });
    setSelectedIds(new Set());
    const unlisten = await listen<ScanProgress>("scan-progress", (event) => {
      setScanProgress(event.payload);
    });
    const pollTimer = window.setInterval(() => {
      void invoke<ScanProgress>("get_scan_progress")
        .then((progress) => setScanProgress(progress))
        .catch(() => undefined);
    }, 150);
    try {
      const nextSummary = await request();
      setSummary(nextSummary);
      setFolderGroups(buildFolderGroups(nextSummary.candidates));
      setActiveCategory(options.nextCategory);
      setScanProgress({
        phase: "完成",
        currentPath: null,
        scannedFiles: nextSummary.scannedFiles,
        totalBytes: nextSummary.totalBytes,
      });
      setMessage(options.completeMessage(nextSummary));
    } catch (error) {
      setMessage(`扫描失败：${String(error)}`);
    } finally {
      window.clearInterval(pollTimer);
      unlisten();
      setIsScanning(false);
    }
  }

  async function cancelScan() {
    try {
      await invoke("cancel_scan");
      setMessage("正在取消扫描...");
    } catch (error) {
      setMessage(`取消失败：${String(error)}`);
    }
  }

  async function openInFinder(path: string) {
    try {
      await invoke("reveal_in_finder", { path });
    } catch (error) {
      setMessage(`打开失败：${String(error)}`);
    }
  }

  async function openPermissionSettings() {
    try {
      await invoke("open_full_disk_access_settings");
      setMessage("在系统设置里打开“清洁王”的完全磁盘访问权限后，重新启动应用。");
    } catch (error) {
      setMessage(`打开授权设置失败：${String(error)}`);
    }
  }

  async function openRepository() {
    try {
      await invoke("open_project_repository");
    } catch (error) {
      setMessage(`打开仓库失败：${String(error)}`);
    }
  }

  async function checkForUpdates() {
    setUpdateState({
      status: "checking",
      message: "正在检查更新...",
      progress: 0,
    });
    try {
      const update = await check();

      if (!update) {
        setUpdateState({
          status: "latest",
          message: "当前已是最新版本",
          progress: 0,
        });
        setMessage("当前已是最新版本。");
        return;
      }

      let downloaded = 0;
      let total: number | undefined;
      setUpdateState({
        status: "downloading",
        message: `发现新版本 v${update.version}，正在下载...`,
        progress: 0,
        version: update.version,
      });

      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
          downloaded = 0;
        }

        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const progress = total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
          setUpdateState({
            status: "downloading",
            message: total
              ? `正在下载 ${formatBytes(downloaded)} / ${formatBytes(total)}`
              : `正在下载 ${formatBytes(downloaded)}`,
            progress,
            version: update.version,
          });
        }

        if (event.event === "Finished") {
          setUpdateState({
            status: "installing",
            message: "更新已安装，正在重启...",
            progress: 100,
            version: update.version,
          });
        }
      });

      await relaunch();
    } catch (error) {
      const nextError = normalizeUpdateError(error);
      setUpdateState({
        status: "error",
        message: nextError.message,
        detail: nextError.detail,
        progress: 0,
      });
      setMessage(`${nextError.message}：${nextError.detail}`);
    }
  }

  async function loadSettings() {
    try {
      const settings = await invoke<AppSettings>("get_app_settings");
      setAppSettings(settings);
    } catch (error) {
      setMessage(`读取设置失败：${String(error)}`);
    }
  }

  async function updateScanTarget(id: string, enabled: boolean) {
    if (!appSettings) return;

    const nextSettings = {
      ...appSettings,
      scanTargets: appSettings.scanTargets.map((target) =>
        target.id === id ? { ...target, enabled } : target,
      ),
    };
    setAppSettings(nextSettings);

    try {
      const saved = await invoke<AppSettings>("save_app_settings", {
        settings: nextSettings,
      });
      setAppSettings(saved);
      setMessage("设置已保存。");
    } catch (error) {
      setMessage(`保存设置失败：${String(error)}`);
      void loadSettings();
    }
  }

  function deleteSelected() {
    if (selectedFiles.length === 0) {
      setMessage("请先选择要清理的文件。");
      return;
    }

    const protectedCount = selectedFiles.filter((file) => file.risk === "protected").length;
    if (protectedCount > 0) {
      setMessage("高风险文件不能批量清理，请先取消选择。");
      return;
    }

    setDeleteConfirmOpen(true);
  }

  async function confirmDeleteSelected() {
    if (selectedFiles.length === 0) {
      setDeleteConfirmOpen(false);
      setMessage("请先选择要清理的文件。");
      return;
    }

    const protectedCount = selectedFiles.filter((file) => file.risk === "protected").length;
    if (protectedCount > 0) {
      setDeleteConfirmOpen(false);
      setMessage("高风险文件不能批量清理，请先取消选择。");
      return;
    }

    setDeleteConfirmOpen(false);
    setIsDeleting(true);
    setMessage(`正在将 ${selectedFiles.length} 个文件移入废纸篓...`);
    try {
      const result = await invoke<DeleteResult>("move_to_trash", {
        paths: selectedFiles.map((file) => file.path),
      });
      const deletedPaths = new Set(result.deletedPaths ?? result.deleted_paths ?? []);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const file of selectedFiles) {
          if (deletedPaths.has(file.path)) {
            next.delete(file.id);
          }
        }
        return next;
      });
      setSummary((current) => {
        if (!current) return current;
        const nextSummary = {
          ...current,
          candidates: current.candidates.filter((file) => !deletedPaths.has(file.path)),
        };
        setFolderGroups(buildFolderGroups(nextSummary.candidates));
        return nextSummary;
      });
      if (result.failed.length > 0) {
        const firstFailure = result.failed[0];
        setMessage(
          `已移入废纸篓 ${result.deleted} 个，${result.failed.length} 个失败：${firstFailure.reason}`,
        );
      } else {
        setMessage(`已移入废纸篓 ${result.deleted} 个文件。`);
      }
    } catch (error) {
      setMessage(`清理失败：${String(error)}`);
    } finally {
      setIsDeleting(false);
    }
  }

  function toggleFile(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleVisible() {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = safeVisibleIds.every((id) => next.has(id));
      for (const id of safeVisibleIds) {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }

  return (
    <main className="shell">
      <section className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Eraser size={24} />
          </div>
          <div>
            <h1>清洁王</h1>
            <p>本地安全清理</p>
          </div>
        </div>

        <button className="scan-button" onClick={isScanning ? cancelScan : scan}>
          {isScanning ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
          {isScanning ? "取消扫描" : "开始扫描"}
        </button>

        <div className="extension-scan">
          <input
            value={extensionInput}
            disabled={isScanning}
            placeholder="输入后缀，如 log"
            onChange={(event) => setExtensionInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void scanExtension();
              }
            }}
          />
          <button onClick={scanExtension} disabled={isScanning}>
            <FileSearch size={17} />
            扫描后缀
          </button>
        </div>

        <nav className="category-list" aria-label="清理分类">
          {categories.map((category) => {
            const Icon = category.icon;
            const count =
              category.key === "all"
                ? summary?.candidates.length ?? 0
                : summary?.candidates.filter((file) => categoryMatches(file, category.key))
                    .length ??
                  0;

            return (
              <button
                key={category.key}
                className={activeCategory === category.key ? "active" : ""}
                onClick={() => {
                  setActiveCategory(category.key);
                  setSelectedFolder(null);
                }}
              >
                <Icon size={17} />
                <span>{category.label}</span>
                <strong>{count}</strong>
              </button>
            );
          })}
        </nav>

        <button className="settings-button" onClick={() => setSettingsOpen(true)}>
          <Settings size={17} />
          设置
        </button>
      </section>

      <section className="content">
        {settingsOpen ? (
          <section className="settings-page">
            <header className="settings-page-header">
              <div>
                <p className="eyebrow">应用设置</p>
                <h2>设置</h2>
              </div>
              <div className="settings-page-actions">
                <button className="ghost-button" onClick={openRepository}>
                  <Github size={16} />
                  GitHub
                </button>
                <button className="icon-button" title="关闭设置" onClick={() => setSettingsOpen(false)}>
                  <X size={17} />
                </button>
              </div>
            </header>

            <div className="settings-page-body">
              <aside className="settings-rail">
                <div className="settings-app-tile">
                  <div className="brand-mark">
                    <Eraser size={23} />
                  </div>
                  <div>
                    <strong>清洁王</strong>
                    <span>tidy-mac · v{APP_VERSION}</span>
                  </div>
                </div>

                <nav className="settings-nav" aria-label="设置分类">
                  <a href="#settings-permission">
                    <ShieldCheck size={16} />
                    权限
                  </a>
                  <a href="#settings-update">
                    <RefreshCw size={16} />
                    更新
                  </a>
                  <a href="#settings-scan">
                    <FolderTree size={16} />
                    扫描
                  </a>
                  <a href="#settings-about">
                    <Info size={16} />
                    关于
                  </a>
                </nav>
              </aside>

              <div className="settings-workspace">
                <section className="settings-group" id="settings-permission">
                  <div className="settings-group-head">
                    <div>
                      <h3>权限与安全</h3>
                      <p>控制扫描能力和系统授权。</p>
                    </div>
                  </div>

                  <div className="settings-row important-row">
                    <div className="settings-row-icon">
                      <ShieldCheck size={19} />
                    </div>
                    <div>
                      <h4>完全磁盘访问</h4>
                      <p>用于减少 macOS 反复弹权限，并允许扫描你勾选的目录。</p>
                    </div>
                    <button className="settings-action" onClick={openPermissionSettings}>
                      永久授权
                    </button>
                  </div>
                </section>

                <section className="settings-group" id="settings-update">
                  <div className="settings-group-head">
                    <div>
                      <h3>版本更新</h3>
                      <p>通过 GitHub Releases 检查签名更新包。</p>
                    </div>
                    <span className={`settings-status is-${updateState.status}`}>
                      {UPDATE_STATUS_LABELS[updateState.status]}
                    </span>
                  </div>

                  <div className="update-panel">
                    <div className="update-state-card" data-status={updateState.status}>
                      <span className={`update-lamp is-${updateState.status}`} />
                      <div className="update-copy">
                        <strong>{UPDATE_STATUS_LABELS[updateState.status]}</strong>
                        <span>{updateState.message}</span>
                        {updateState.detail ? <small>{updateState.detail}</small> : null}
                      </div>
                    </div>

                    <div className="update-progress" aria-hidden="true">
                      <span style={{ width: `${updateState.progress}%` }} />
                    </div>

                    <div className="update-meta-row">
                      <div>
                        <span>当前版本</span>
                        <strong>v{APP_VERSION}</strong>
                      </div>
                      <div>
                        <span>更新渠道</span>
                        <strong>{UPDATE_ENDPOINT}</strong>
                      </div>
                      {updateState.version ? (
                        <div>
                          <span>发现版本</span>
                          <strong>v{updateState.version}</strong>
                        </div>
                      ) : null}
                    </div>

                    <button
                      className="settings-action secondary-action update-check-button"
                      disabled={updateBusy}
                      onClick={checkForUpdates}
                    >
                      {updateBusy ? "处理中..." : "检查更新"}
                    </button>
                  </div>
                </section>

                <section className="settings-group" id="settings-scan">
                  <div className="settings-group-head">
                    <div>
                      <h3>扫描范围</h3>
                      <p>勾选后会保存到本机。用户目录范围更大，耗时会更长。</p>
                    </div>
                  </div>

                  <div className="scan-target-list settings-scan-list">
                    {appSettings ? (
                      appSettings.scanTargets.map((target) => (
                        <label className="scan-target" key={target.id}>
                          <input
                            type="checkbox"
                            checked={target.enabled}
                            disabled={isScanning}
                            onChange={(event) => updateScanTarget(target.id, event.target.checked)}
                          />
                          <span>
                            <strong>{target.label}</strong>
                            <small>{target.path}</small>
                          </span>
                        </label>
                      ))
                    ) : (
                      <p>正在读取设置...</p>
                    )}
                  </div>
                </section>

                <section className="settings-group" id="settings-about">
                  <div className="settings-group-head">
                    <div>
                      <h3>关于项目</h3>
                      <p>作者、开源仓库和发布信息。</p>
                    </div>
                  </div>

                  <div className="settings-info-grid">
                    <div className="settings-info-box">
                      <UserRound size={17} />
                      <h4>作者信息</h4>
                      {authorInfoPlaceholders.map((item) => (
                        <div className="settings-kv" key={item.label}>
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                        </div>
                      ))}
                    </div>

                    <div className="settings-info-box">
                      <Github size={17} />
                      <h4>开源项目</h4>
                      <button className="settings-link-row" onClick={openRepository}>
                        <span>{REPOSITORY_URL}</span>
                        <ExternalLink size={15} />
                      </button>
                      {projectInfoItems.map((item) => (
                        <div className="settings-kv" key={item.label}>
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </section>
        ) : (
          <>
        <div className="permission-alert">
          <ShieldAlert size={17} />
          <span>反复弹权限时，在设置里开启完全磁盘访问；扫描范围也在设置里调整。</span>
        </div>

        <header className="topbar">
          <div>
            <p className="eyebrow">Mac 文件清理</p>
            <h2>发现占空间、重复、长期未整理的文件</h2>
          </div>
          <div className="summary-strip">
            <div>
              <span>已扫描</span>
              <strong>{scannedFilesCount === null ? "-" : scannedFilesCount.toLocaleString()}</strong>
            </div>
            <div>
              <span>可检查</span>
              <strong>{summary ? summary.candidates.length.toLocaleString() : "-"}</strong>
            </div>
            <div>
              <span>{isScanning ? "扫描空间" : "选中空间"}</span>
              <strong>{formatBytes(isScanning ? scanTotalBytes : selectedBytes)}</strong>
            </div>
          </div>
        </header>

        {message && <div className="message">{message}</div>}

        <section className="toolbar">
          {selectedFolder && (
            <button onClick={() => setSelectedFolder(null)}>
              <FolderTree size={17} />
              返回文件夹
            </button>
          )}
          <button onClick={toggleVisible} disabled={visibleFiles.length === 0}>
            <CheckCircle2 size={17} />
            选择当前分类
          </button>
          <button
            className="danger"
            onClick={deleteSelected}
            disabled={selectedFiles.length === 0 || isDeleting}
          >
            {isDeleting ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
            移入废纸篓
          </button>
        </section>

          <section className="results">
          {isScanning && (
            <div className="empty-state">
              <Loader2 className="spin" size={34} />
              <h3>{scanProgress?.phase ?? "正在扫描默认目录"}</h3>
              <p>
                已扫描 {(scanProgress?.scannedFiles ?? 0).toLocaleString()} 个文件，
                累计 {formatBytes(scanProgress?.totalBytes ?? 0)}
              </p>
              {scanProgress?.currentPath && (
                <p className="progress-path" title={scanProgress.currentPath}>
                  {scanProgress.currentPath}
                </p>
              )}
            </div>
          )}

          {!isScanning && isFolderMode && folderGroups.length > 0 && (
            <div
              className="folder-table"
              ref={tableRef}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            >
              <div className="folder-row folder-head">
                <span>文件夹</span>
                <span>文件数</span>
                <span>可检查空间</span>
                <span></span>
              </div>
              {folderBeforeHeight > 0 && <div style={{ height: folderBeforeHeight }} />}
              {virtualFolderGroups.map((folder) => (
                <button
                  className="folder-row folder-item"
                  key={folder.path}
                  style={{ height: FOLDER_ROW_HEIGHT }}
                  onClick={() => setSelectedFolder(folder.path)}
                >
                  <span title={folder.path}>{folder.path}</span>
                  <strong>{folder.count.toLocaleString()}</strong>
                  <strong>{formatBytes(folder.bytes)}</strong>
                  <FolderOpen size={17} />
                </button>
              ))}
              {folderAfterHeight > 0 && <div style={{ height: folderAfterHeight }} />}
            </div>
          )}

          {!isScanning && !isFolderMode && visibleFiles.length === 0 && (
            <div className="empty-state">
              <Archive size={36} />
              <h3>{summary ? "当前分类没有结果" : "还没有扫描结果"}</h3>
              <p>{summary ? "切换其他分类查看。" : "点击开始扫描，先检查常见杂乱目录。"}</p>
            </div>
          )}

          {!isScanning && !isFolderMode && visibleFiles.length > 0 && (
            <div
              className="file-table"
              ref={tableRef}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            >
              <div className="file-row file-head">
                <span></span>
                <span>文件</span>
                <span>大小</span>
                <span>修改时间</span>
                <span>风险</span>
                <span></span>
              </div>
              {beforeHeight > 0 && <div style={{ height: beforeHeight }} />}
              {virtualFiles.map((file) => (
                <div className="file-row" key={file.id} style={{ height: ROW_HEIGHT }}>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      disabled={file.risk === "protected"}
                      checked={selectedIds.has(file.id)}
                      onChange={() => toggleFile(file.id)}
                    />
                  </label>
                  <div className="file-main">
                    <strong title={file.name}>{file.name}</strong>
                    <p title={file.path}>{file.path}</p>
                    <div className="reason-list">
                      {file.reasons.map((reason) => (
                        <span key={reason}>{reason}</span>
                      ))}
                    </div>
                  </div>
                  <span>{formatBytes(file.size)}</span>
                  <span>{formatDate(file.modified)}</span>
                  <span className={`risk risk-${file.risk}`}>
                    {file.risk === "protected" && <AlertTriangle size={14} />}
                    {riskLabels[file.risk]}
                  </span>
                  <button
                    className="icon-button"
                    title="在 Finder 中显示"
                    onClick={() => openInFinder(file.path)}
                  >
                    <FolderOpen size={17} />
                  </button>
                </div>
              ))}
              {afterHeight > 0 && <div style={{ height: afterHeight }} />}
            </div>
          )}
          </section>
          </>
        )}
      </section>

      {deleteConfirmOpen && (
        <div className="confirm-backdrop" role="presentation">
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <div className="confirm-icon">
              <Trash2 size={22} />
            </div>
            <div>
              <h3 id="delete-title">移入废纸篓</h3>
              <p>
                将 {selectedFiles.length.toLocaleString()} 个文件移入 macOS 废纸篓，预计释放{" "}
                {formatBytes(selectedBytes)}。废纸篓未清空前仍可恢复。
              </p>
            </div>
            <div className="confirm-actions">
              <button onClick={() => setDeleteConfirmOpen(false)} disabled={isDeleting}>
                取消
              </button>
              <button className="danger" onClick={confirmDeleteSelected} disabled={isDeleting}>
                {isDeleting ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
                确认移入
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
