import { memo, useState, useEffect, useRef } from "react";
import { toast } from "@heroui/react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Switch,
} from "../../components/ui";
import {
  IconBook2,
  IconFolderPlus,
  IconPlus,
  IconRefresh,
  IconServer,
} from "@tabler/icons-react";
import { SettingsPageHeader } from "../../SettingsPageHeader";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { SkillCacheDialog } from "./SkillCacheDialog";
import { ExtensionEditor } from "./ExtensionEditor";
import { ExtensionScope, ExtensionFilters } from "./ExtensionToolbar";
import { ExtensionError } from "./ExtensionError";
import { ExtensionList } from "./ExtensionList";
import type { ExtensionTransport } from "./types";
import { useExtensionsPageController } from "./useExtensionsPageController";

function downloadResource(filename: string, content: BlobPart, mediaType: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CodexExtensionsPageComponent({
  kind,
  request,
  container,
  active = true,
}: {
  kind: "mcp" | "skill";
  request?: ExtensionTransport;
  container?: HTMLElement | null;
  active?: boolean;
}) {
  const controller = useExtensionsPageController({ kind, request, active, onDownload: downloadResource });
  const { inventory, scope, busy, loading, unavailable, entries, filtered, currentPage, selected,
    query, filter, source, sort, projectMode, projectPath, draft, comparison, confirmation, discard } = controller;
  const [cacheOpen, setCacheOpen] = useState(false);
  const shownNotice = useRef(0);
  useEffect(() => {
    if (!active || !controller.notice || shownNotice.current === controller.noticeSeq) return;
    shownNotice.current = controller.noticeSeq;
    if (
      controller.notice.includes("未能") ||
      controller.notice.includes("失败")
    ) {
      toast.warning(controller.notice);
    } else {
      toast.success(controller.notice);
    }
  }, [active, controller.notice, controller.noticeSeq]);
  const title = kind === "mcp" ? "MCP 管理" : "Skill 管理";
  if (!active) return null;
  return (
    <section
      className="secondary-section"
      aria-labelledby={`codex-${kind}-title`}
    >
      <SettingsPageHeader
        id={`codex-${kind}-title`}
        title={title}
        icon={
          kind === "mcp" ? <IconServer size={15} /> : <IconBook2 size={15} />
        }
        badge={
          <Badge variant="info">
            {kind === "mcp" ? "Model Context Protocol" : "Codex 增强技能"}
          </Badge>
        }
        description={
          kind === "mcp"
            ? "管理 MCP 服务配置，检查连接与可用性。"
            : "管理本地 Skill，检查配置与可用性。"
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {kind === "skill" && (
              <Button size="sm" variant="outline" onClick={() => setCacheOpen(true)}>
                缓存 Skill 管理
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || loading}
              onClick={() => void controller.refresh()}
            >
              <IconRefresh size={14} aria-hidden="true" />
              刷新
            </Button>
            <Button
              size="sm"
              disabled={unavailable}
              onClick={() => controller.startDraft(kind)}
            >
              <IconPlus size={14} aria-hidden="true" />
              {kind === "mcp" ? "新增 MCP" : "新增 Skill"}
            </Button>
            {kind === "skill" && (
              <Button
                size="sm"
                variant="outline"
                disabled={unavailable}
                onClick={() => controller.startDraft("install")}
              >
                导入目录 / ZIP
              </Button>
            )}
          </div>
        }
      />
      <div className="space-y-4">
        <ExtensionScope
          kind={kind}
          scope={scope}
          inventory={inventory}
          count={entries.length}
          projectMode={projectMode}
          projectPath={projectPath}
          busy={busy}
          onMode={controller.changeMode}
          onPath={controller.setProjectPath}
          onPick={() => void controller.pickProject()}
          onRead={() => controller.changeScope(true)}
        />

        {kind === "mcp" && (
          <div className="codey-card space-y-3 p-4" aria-label="MCP 共享器" aria-busy={controller.sharingLoading || busy}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">启用共享器</span>
                {controller.sharingStatus && <Switch size="sm" aria-label="启用共享器"
                  checked={controller.sharingStatus.enabled}
                  disabled={unavailable || controller.sharingLoading || !!controller.sharingStatusError}
                  onCheckedChange={enabled => void controller.setMcpSchedulerEnabled(enabled)} />}
                <span role="status" className="text-xs text-muted">
                  {controller.busyAction === "set_mcp_scheduler_enabled" ? "正在保存…"
                    : controller.sharingStatus ? controller.sharingStatus.enabled ? "已开启 · 全局" : "已关闭 · 全局"
                      : controller.sharingStatusError ? "状态待确认" : "正在读取状态…"}
                </span>
              </div>
              <Button size="sm" variant="outline" disabled={unavailable || controller.sharingLoading || !controller.sharingStatus || !!controller.sharingStatusError}
                loading={controller.busyAction === "release_mcp_idle"} onClick={() => void controller.releaseMcpIdle()}>
                释放空闲实例
              </Button>
            </div>
            <p className="m-0 text-xs leading-relaxed text-muted">统一管理共享 MCP 的内存；已启用的内置 FastCtx 等服务自动接入。关闭后恢复直连并保留各服务的共享选择。释放会跳过忙碌请求，下次调用按需启动。</p>
            <p className="m-0 text-xs text-muted">配置更新后在新会话中生效；运行中的内置工具可能需要重启 Codex，请以保存结果提示为准。</p>
            {controller.sharingStatusError && <ExtensionError message={controller.sharingStatusError} />}
          </div>
        )}

        {controller.error && !draft && (
          <div className="space-y-2">
            <ExtensionError message={controller.error} />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || loading}
              onClick={() => void controller.refresh()}
            >
              重新读取当前范围
            </Button>
          </div>
        )}
        {inventory?.warnings.map((warning, index) => (
          <p
            key={index}
            role="status"
            className="m-0 break-words text-xs text-warning"
          >
            {warning}
          </p>
        ))}
        <ExtensionFilters
          kind={kind}
          query={query}
          filter={filter}
          source={source}
          sort={sort}
          onQuery={controller.setQuery}
          onFilter={controller.setFilter}
          onSource={controller.setSource}
          onSort={controller.setSort}
          onClear={controller.clearFilters}
        />
        {inventory && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>
              匹配 {filtered.length} / {entries.length} 项
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={unavailable || !controller.canSelectPage}
              title={!unavailable && !controller.canSelectPage && selected.length >= 100 ? "最多同时选择 100 项" : undefined}
              onClick={controller.selectPage}
            >
              {controller.deselectPage ? "取消本页" : "选择本页可操作项"}
            </Button>
            {selected.length > 0 && (
              <>
                <span>已选 {selected.length} 项，最多 100 项</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    unavailable || !controller.canEnable
                  }
                  onClick={() => controller.batch(true)}
                >
                  启用
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={
                    unavailable ||
                    !controller.canDisable
                  }
                  onClick={() => controller.batch(false)}
                >
                  禁用
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={controller.clearSelection}
                >
                  清空选择
                </Button>
              </>
            )}
          </div>
        )}
        {loading && (
          <p role="status" className="p-6 text-center text-muted">
            {inventory ? "正在刷新，暂时显示上次读取结果…" : "正在读取配置…"}
          </p>
        )}
        {inventory && (
          <ExtensionList
            kind={kind}
            entries={currentPage.entries}
            busy={busy || loading}
            busyAction={controller.busyAction}
            onAction={(action, entry) => void controller.onAction(action, entry)}
            selected={selected}
            onSelect={controller.selectEntry}
            checks={controller.checks}
            revision={inventory.revision}
            filtered={!!query.trim() || filter !== "all" || source !== "all"}
            onSharing={(entry, enabled, maxInstances) => void controller.setMcpSharing(entry, enabled, maxInstances)}
            sharingStatus={controller.sharingStatus}
            sharingStatusError={controller.sharingStatusError}
          />
        )}
        {inventory && filtered.length > 0 && (
          <nav
            aria-label="资源分页"
            className="flex flex-wrap items-center justify-end gap-3 text-xs text-muted"
          >
            <span>
              第 {currentPage.page} / {currentPage.pages} 页 · 每页 20 项
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={currentPage.page <= 1}
              onClick={() => controller.setPage(currentPage.page - 1)}
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={currentPage.page >= currentPage.pages}
              onClick={() => controller.setPage(currentPage.page + 1)}
            >
              下一页
            </Button>
          </nav>
        )}
      </div>
      <SkillCacheDialog open={cacheOpen && kind === "skill"} request={request} container={container} onClose={() => setCacheOpen(false)} />
      {draft && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) controller.closeDraft();
          }}
        >
          <DialogContent
            container={container}
            className={draft.kind === "install" ? "sm:w-[560px]" : "sm:w-[760px]"}
            onEscapeKeyDown={(event) => {
              if (busy || discard) event.preventDefault();
            }}
          >
            <DialogHeader>
              <div className="flex items-start gap-3.5">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400">
                  {draft.kind === "mcp" ? (
                    <IconServer size={20} stroke={1.75} aria-hidden="true" />
                  ) : draft.kind === "install" ? (
                    <IconFolderPlus size={20} stroke={1.75} aria-hidden="true" />
                  ) : (
                    <IconBook2 size={20} stroke={1.75} aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <DialogTitle>
                      {draft.kind === "install"
                        ? "新增 Skill"
                        : `${draft.readOnly ? "查看" : draft.isNew ? "新增" : "编辑"} ${draft.kind === "mcp" ? "MCP" : "Skill"}`}
                    </DialogTitle>
                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:bg-blue-500/15 dark:text-blue-400">
                      {draft.kind === "install"
                        ? "本地导入"
                        : draft.kind === "mcp"
                          ? "MCP 服务"
                          : "SKILL.md"}
                    </span>
                  </div>
                  <DialogDescription>
                    {draft.kind === "install"
                      ? "选择本地 Skill 目录或 ZIP 文件进行安装。"
                      : draft.kind === "mcp"
                        ? draft.isNew
                          ? "配置并添加新的 MCP 服务，保存后自动启用并刷新 Codex。"
                          : "查看或修改当前 MCP 服务配置。"
                        : draft.isNew
                          ? "编写 SKILL.md 定义技能元数据与提示词说明，保存后生效。"
                          : draft.readOnly
                            ? "查看当前 Skill 的 SKILL.md 配置与说明内容。"
                            : "编辑当前 Skill 的 SKILL.md 文件，保存后将更新本地文件。"}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="max-h-[72vh] overflow-y-auto pt-2">
              <ExtensionEditor
                draft={draft}
                busy={busy || loading}
                submissionError={controller.error}
                onChange={controller.changeDraft}
                onSave={() => void controller.save()}
                onCancel={controller.closeDraft}
                onPick={() => void controller.pickSkill()}
                inventory={inventory}
                onReload={() => void controller.loadLatest()}
                saving={controller.saving}
              />
              {loading && (
                <p role="status" className="mt-2 text-xs text-muted">
                  正在重新读取当前范围，草稿已保留…
                </p>
              )}
              {controller.uncertain && (
                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || loading}
                    onClick={() => void controller.refresh()}
                  >
                    刷新确认上次操作结果
                  </Button>
                </div>
              )}
              {comparison && (
                <section
                  className="mt-4 space-y-3 rounded-xl border border-black/[0.08] bg-black/[0.02] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]"
                  aria-label="与最新配置比对"
                >
                  <h4 className="m-0 text-sm font-semibold">最新保存内容</h4>
                  <p className="m-0 text-xs text-muted">
                    上方保留了你的草稿。请对照下方最新内容手动合并，确认后再保存。
                  </p>
                  <textarea
                    aria-label="最新保存内容"
                    readOnly
                    value={comparison.content}
                    className="min-h-40 w-full rounded-lg border border-black/[0.12] bg-transparent p-3 font-mono text-xs outline-none dark:border-white/[0.12]"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={controller.adoptComparison}
                  >
                    已比对，使用最新版本作为保存基础
                  </Button>
                </section>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
      {confirmation && (
        <ConfirmationDialog
          {...confirmation}
          busy={busy}
          container={container}
          onCancel={controller.cancelConfirmation}
          onConfirm={() => void controller.confirmAction()}
        />
      )}
      {discard && (
        <ConfirmationDialog
          title="放弃未保存的修改？"
          description="当前草稿尚未保存，继续操作会丢弃这些修改。"
          destructive
          busy={false}
          container={container}
          onCancel={controller.cancelDiscard}
          onConfirm={controller.confirmDiscard}
        />
      )}
    </section>
  );
}

export const CodexExtensionsPage = memo(CodexExtensionsPageComponent);
