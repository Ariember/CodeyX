import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useStableEvent } from "../../useStableEvent";
import { extensionRequest } from "./requests";
import { batchTargets, canShareMcp, canToggle, draftChanged, editorError, pageResources, selectResources } from "./state";
import { exportMcpJson, mcpJsonError, NEW_MCP_JSON, selectedMcpJson } from "./mcpJson";
import type { Confirmation, EditorDraft, ExtensionTransport, McpEntry, Scope, SkillEntry } from "./types";
import { useExtensionsController } from "./useExtensionsController";
import { useMcpSharingController } from "./useMcpSharingController";

type Kind = "mcp" | "skill";
type Transition = { kind: "close" } | { kind: "scope"; scope: Scope } | { kind: "draft"; draftKind: EditorDraft["kind"] };
type Options = {
  kind: Kind;
  active: boolean;
  request?: ExtensionTransport;
  onDownload: (filename: string, content: BlobPart, mediaType: string) => void;
};

export function useExtensionsPageController({ kind, active, request = extensionRequest, onDownload }: Options) {
  const controller = useExtensionsController(request, active);
  const { inventory, scope, busy, loading } = controller;
  const sharing = useMcpSharingController(request, scope,
    active && kind === "mcp" && !!inventory, inventory?.revision);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [source, setSource] = useState("all");
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [projectMode, setProjectMode] = useState(false);
  const [projectPath, setProjectPath] = useState("");
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [comparison, setComparison] = useState<{ content: string; revision: string } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [discard, setDiscard] = useState<Transition | null>(null);
  const session = useRef<object | null>(null);
  const draftRef = useRef(draft);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    session.current = active ? {} : null;
    setConfirmation(null);
    setDiscard(null);
    return () => { session.current = null; };
  }, [active, kind, request, scope]);
  useEffect(() => setComparison(null), [draft?.id, draft?.kind]);
  useEffect(() => { setPage(1); setSelected([]); }, [deferredQuery, filter, source, sort, inventory?.revision, scope]);

  const available = () => !!session.current && controller.canRun();
  const unavailable = busy || loading || !inventory;
  const updateDraft = (next: EditorDraft | null) => { draftRef.current = next; setDraft(next); };
  const transition = (next: Transition) => {
    setComparison(null);
    if (next.kind === "scope") {
      updateDraft(null);
      setProjectMode(next.scope.kind === "project");
      controller.setScope(next.scope);
    } else if (next.kind === "close") updateDraft(null);
    else {
      controller.clearError();
      updateDraft({
        kind: next.draftKind, id: next.draftKind === "mcp" ? "my-server" : "", originalId: "",
        content: next.draftKind === "mcp" ? NEW_MCP_JSON
          : next.draftKind === "skill" ? "---\nname: new-skill\ndescription: 描述此技能适用的任务。\n---\n\n# 使用说明\n" : "",
        original: "", revision: inventory?.revision ?? "", readOnly: false, isNew: true,
      });
    }
  };
  const guard = (next: Transition) => {
    if (!available()) return;
    if (draftChanged(draftRef.current)) setDiscard(next);
    else transition(next);
  };
  const startDraft = useStableEvent((draftKind: EditorDraft["kind"]) => {
    if (!unavailable) guard({ kind: "draft", draftKind });
  });
  const closeDraft = useStableEvent(() => guard({ kind: "close" }));
  const changeScope = useStableEvent((project: boolean) => {
    if (project && !projectPath.trim()) return;
    guard({ kind: "scope", scope: project ? { kind: "project", projectPath: projectPath.trim() } : { kind: "user" } });
  });
  const changeMode = useStableEvent((project: boolean) => {
    if (!available()) return;
    if (project) setProjectMode(true);
    else changeScope(false);
  });
  const confirmDiscard = useStableEvent(() => {
    if (!available() || !discard) return;
    setDiscard(null);
    transition(discard);
  });
  const changeDraft = useStableEvent((next: EditorDraft) => {
    if (available() && !loading && draftRef.current) {
      setConfirmation(null);
      updateDraft(next);
    }
  });
  const pickProject = useStableEvent(() => controller.run<{ path: string } | null>(
    { action: "pick_project" }, result => { if (result) setProjectPath(result.path); },
  ));
  const pickSkill = useStableEvent(() => {
    const editing = draftRef.current;
    if (!editing || editing.kind !== "install") return;
    return controller.run<{ path: string } | null>({ action: "pick_skill" }, result => {
      if (result && draftRef.current === editing) updateDraft({ ...editing, content: result.path });
    });
  });

  const edit = (entry: McpEntry | SkillEntry) => {
    if (kind === "mcp") return controller.run<{ id: string; configJson: Record<string, unknown>; revision: string }>(
      { action: "get_mcp", id: entry.id }, result => {
        const content = JSON.stringify(result.configJson, null, 2);
        updateDraft({ kind, id: result.id, originalId: result.id, content, original: content,
          revision: result.revision, readOnly: entry.readOnly || entry.canEdit === false, entry });
      },
    );
    return controller.run<{ id: string; content: string; revision: string; readOnly: boolean }>(
      { action: "read_skill", id: entry.id }, result => updateDraft({ kind, id: result.id, originalId: result.id,
        content: result.content, original: result.content, revision: result.revision,
        readOnly: result.readOnly || entry.canEdit === false || !("ownership" in entry) || entry.ownership !== "managed", entry }),
    );
  };
  const onAction = useStableEvent((action: string, entry: McpEntry | SkillEntry) => {
    if (!available() || unavailable) return;
    if (action === "export") {
      if (kind === "mcp") return controller.run<{ configJson: Record<string, unknown> }>(
        { action: "get_mcp", id: entry.id }, result => onDownload(`${entry.id}.json`, exportMcpJson(entry.id, result.configJson), "application/json"),
      );
      return controller.run<{ filename: string; mediaType: string; dataBase64: string }>(
        { action: "export_skill", id: entry.id }, result => onDownload(result.filename,
          Uint8Array.from(atob(result.dataBase64), char => char.charCodeAt(0)), result.mediaType),
      );
    }
    if (action === "edit") return edit(entry);
    if (action === "check") {
      if (entry.canCheck === false || entry.configurationStatus === "invalid") return;
      if (kind === "skill") return controller.inspect({ action: "validate_skill", id: entry.id });
      setConfirmation({
        title: `测试 ${entry.name}`,
        description: "测试将执行该 MCP 配置的启动命令，或连接远程地址，并完成协议握手。程序可能访问当前用户允许的文件和网络。仅在信任此服务时继续；测试不会调用业务工具。",
        action: { action: "test_mcp", id: entry.id, revision: inventory?.revision, confirmed: true },
      });
    } else if (action === "toggle") {
      if (!canToggle(entry)) return;
      const toggle = { action: `set_${kind}_enabled`, id: entry.id, enabled: !entry.enabled, revision: inventory?.revision, confirmed: true };
      if (entry.enabled) return controller.mutate(toggle);
      setConfirmation({ title: `启用 ${entry.name}`, description: kind === "mcp"
        ? "启用后将自动刷新 Codex 的 MCP 配置。请确认信任其内容和来源。"
        : "启用后 Codex 可能在新会话中加载该资源。请确认信任其内容和来源。", action: toggle });
    } else if (action === "remove" && entry.canRemove !== false) {
      setConfirmation({
        title: `${kind === "mcp" ? "移除" : "卸载"} ${entry.name}`,
        description: kind === "mcp"
          ? "将移除该服务的配置注册并自动刷新 Codex，不删除外部程序。移除后如需再次使用，请重新导入配置。"
          : "ownership" in entry && entry.ownership === "external"
            ? "将直接删除该外部安装目录及其全部资源文件，不经过 CodeyX 托管记录，删除后无法从本页恢复。目录内容无法完整校验时会拒绝删除。"
            : "将删除这份 CodeyX 托管安装及其本地文件，保留原始来源。卸载后如需再次使用，请重新安装。若文件已被外部修改，后端可能拒绝卸载。",
        destructive: true,
        action: { action: kind === "mcp" ? "remove_mcp" : "uninstall_skill", id: entry.id, revision: inventory?.revision, confirmed: true },
      });
    }
  });
  const setMcpSharing = useStableEvent((entry: McpEntry, enabled: boolean, maxInstances: number = entry.sharing?.maxInstances ?? 4) => {
    if (kind !== "mcp" || !available() || unavailable || !canShareMcp(entry, enabled) || !Number.isInteger(maxInstances) || maxInstances < 1 || maxInstances > 8) return;
    const action = { action: "set_mcp_sharing", id: entry.id, enabled, maxInstances, revision: inventory?.revision, confirmed: true };
    if (!enabled || entry.sharing?.enabled) return controller.mutate(action);
    setConfirmation({ title: `共享 ${entry.name} 实例`,
      description: "仅适合已确认无会话状态、可运行多个独立实例的工具型 MCP。不支持客户端回调、资源订阅或持续任务；未知或有状态服务请保持直连。开启后多个会话将复用后端，扩容实例空闲后自动回收。", action });
  });
  const setMcpSchedulerEnabled = useStableEvent(async (enabled: boolean) => {
    if (kind !== "mcp" || !available() || unavailable || sharing.loading || !sharing.status || sharing.error || sharing.status.enabled === enabled) return;
    const currentSession = session.current;
    const outcome = await controller.mutate({ action: "set_mcp_scheduler_enabled", enabled });
    if (outcome === "ok" && session.current === currentSession) sharing.refresh();
  });
  const releaseMcpIdle = useStableEvent(async () => {
    if (kind !== "mcp" || !available() || unavailable || sharing.loading || !sharing.status || sharing.error) return;
    const currentSession = session.current;
    const outcome = await controller.run<{ status: string; message: string }>({ action: "release_mcp_idle" }, result => {
      if (result.status !== "success") throw new Error(result.message || "释放空闲实例失败，请刷新后重试。");
      controller.postNotice(result.message);
    });
    if (outcome === "ok" && session.current === currentSession) sharing.refresh();
  });
  const refresh = useStableEvent(() => {
    if (!available()) return;
    if (kind === "mcp") sharing.refresh();
    return controller.refresh();
  });
  const save = useStableEvent(async () => {
    const editing = draftRef.current;
    if (!available() || unavailable || !editing || editing.readOnly || mcpJsonError(editing) || editorError(editing)) return;
    if (editing.kind === "mcp" && editing.isNew && inventory?.mcps.some(entry => entry.id === editing.id)) return;
    const action = editing.kind === "install" ? { action: "install_skill", sourcePath: editing.content.trim() }
      : editing.kind === "mcp" ? { action: "save_mcp", id: editing.id, configJson: selectedMcpJson(editing).config,
        createOnly: editing.isNew === true, confirmed: editing.isNew === true || (editing.entry !== undefined && "sharing" in editing.entry && editing.entry.sharing?.enabled === true) }
        : { action: editing.isNew ? "create_skill" : "save_skill", id: editing.id, content: editing.content };
    if (editing.kind === "mcp" && !editing.isNew && (editing.entry?.enabled || selectedMcpJson(editing).config.enabled !== false)) {
      setConfirmation({ title: "保存 MCP 配置",
        description: "保存后会立即刷新到 Codex 并生效，无需重启；草稿未显式禁用的服务会被启用。请确认信任修改后的程序或远程地址。",
        action: { ...action, revision: editing.revision, confirmed: true } });
      return;
    }
    const currentSession = session.current;
    const outcome = await controller.mutate({ ...action, revision: editing.revision });
    if (outcome === "ok" && session.current === currentSession && draftRef.current === editing) updateDraft(null);
  });
  const confirmAction = useStableEvent(async () => {
    if (!available() || !confirmation) return;
    const currentSession = session.current;
    const editing = draftRef.current;
    const outcome = await (confirmation.action.action === "test_mcp"
      ? controller.inspect(confirmation.action) : controller.mutate(confirmation.action));
    if (session.current !== currentSession) return;
    setConfirmation(null);
    if (confirmation.action.action === "save_mcp" && outcome === "ok" && draftRef.current === editing) updateDraft(null);
  });
  const loadLatest = useStableEvent(async () => {
    const editing = draftRef.current;
    if (!available() || !editing) return;
    const currentSession = session.current;
    if (editing.isNew || editing.kind === "install") {
      const latest = await controller.refresh();
      if (latest && session.current === currentSession && draftRef.current === editing) updateDraft({ ...editing, revision: latest.revision });
      return;
    }
    return controller.run<{ content?: string; configJson?: Record<string, unknown>; revision: string }>(
      { action: editing.kind === "mcp" ? "get_mcp" : "read_skill", id: editing.id }, result => {
        if (draftRef.current === editing) setComparison({ content: editing.kind === "mcp"
          ? JSON.stringify(result.configJson, null, 2) : result.content ?? "", revision: result.revision });
      },
    );
  });
  const adoptComparison = useStableEvent(() => {
    if (!available() || !draft || !comparison) return;
    updateDraft({ ...draft, revision: comparison.revision, original: comparison.content });
    setComparison(null);
  });

  const entries = useMemo(() => inventory ? kind === "mcp" ? inventory.mcps
    : inventory.skills.filter(entry => entry.ownership !== "plugin" && entry.scope !== "plugin") : [], [inventory, kind]);
  const filtered = useMemo(() => selectResources(entries, deferredQuery, filter, source, sort), [entries, deferredQuery, filter, source, sort]);
  const currentPage = pageResources(filtered, page);
  const enableTargets = batchTargets(entries, selected, true);
  const disableTargets = batchTargets(entries, selected, false);
  const pageToggleIds = currentPage.entries.filter(canToggle).map(entry => entry.id);
  const selectedIds = new Set(selected);
  const canSelectMoreOnPage = selected.length < 100 && pageToggleIds.some(id => !selectedIds.has(id));
  const deselectPage = !canSelectMoreOnPage && pageToggleIds.some(id => selectedIds.has(id));
  const batch = useStableEvent((enabled: boolean) => {
    if (!available() || unavailable) return;
    const ids = enabled ? enableTargets : disableTargets;
    if (!ids.length) return;
    setConfirmation({ title: `${enabled ? "启用" : "禁用"} ${ids.length} 项`,
      description: `选中 ${selected.length} 项，其中 ${ids.length} 项需要变更。${enabled ? "请确认信任这些资源的内容与来源。" : ""}${kind === "mcp" ? "保存后自动刷新 Codex 的 MCP 配置。" : "新会话的实际加载状态需在 Codex 中确认。"}`,
      action: { action: kind === "mcp" ? "set_mcps_enabled" : "set_skills_enabled", ids, enabled, revision: inventory?.revision, confirmed: true } });
  });
  const selectPage = useStableEvent(() => {
    if (!available() || unavailable) return;
    const pageIds = new Set(pageToggleIds);
    setSelected(current => deselectPage
      ? current.filter(id => !pageIds.has(id))
      : [...new Set([...current, ...pageToggleIds])].slice(0, 100));
  });
  const selectEntry = useStableEvent((id: string) => {
    if (!available() || unavailable || !entries.some(entry => entry.id === id && canToggle(entry))) return;
    setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id].slice(0, 100));
  });

  return {
    inventory, scope, busy, loading, unavailable, error: controller.error, uncertain: controller.uncertain,
    notice: controller.notice, noticeSeq: controller.noticeSeq, checks: controller.checks, busyAction: controller.busyAction,
    saving: ["save_mcp", "save_skill", "create_skill", "install_skill"].includes(controller.busyAction),
    refresh, query, filter, source, sort, setQuery, setFilter, setSource, setSort, setPage,
    clearFilters: () => { setQuery(""); setFilter("all"); setSource("all"); },
    selected, entries, filtered, currentPage, canSelectPage: canSelectMoreOnPage || deselectPage, deselectPage, selectPage, selectEntry,
    clearSelection: () => setSelected([]), canEnable: enableTargets.length > 0, canDisable: disableTargets.length > 0, batch,
    projectMode, projectPath, setProjectPath, changeMode, changeScope, pickProject, pickSkill,
    draft, changeDraft, startDraft, closeDraft, save, loadLatest, comparison, adoptComparison,
    confirmation, confirmAction, cancelConfirmation: () => { if (available()) setConfirmation(null); },
    discard, confirmDiscard, cancelDiscard: () => setDiscard(null), onAction,
    setMcpSharing, setMcpSchedulerEnabled, releaseMcpIdle, sharingStatus: sharing.status, sharingStatusError: sharing.error,
    sharingLoading: sharing.loading,
  };
}
