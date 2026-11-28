import { projectDisplayName } from "../projectDisplayName";
import { useEffect, useRef, useState } from "react";
import { listWorkspaceProjects, peekWorkspaceProjects, projectDeleteMode, subscribeWorkspaceProjects, type WorkspaceProject } from "../../backend/workspace";
import { errorMessage } from "../../backend/api";
import { useT } from "../../i18n/I18nProvider";
import { IconButton } from "./workspaceChrome";
import { CanvasIcon } from "../CanvasIcon";
import { ProjectDeleteDialog } from "../ProjectDeleteDialog";
import { shortcutAriaKeys, shortcutKeys } from "../shortcuts";
import logo from "../../assets/open_director_logo.png";

export function DesktopSidebar({ open, currentId, switchingStatus, disabled, onToggle, onCreate, onSelect, onDelete, onSettings }: {
  open: boolean; currentId: string; switchingStatus: string; disabled: boolean; onToggle: () => void;
  onDelete: (project: WorkspaceProject) => Promise<void>;
  onCreate: () => void; onSelect: (project: WorkspaceProject) => Promise<boolean>; onSettings: () => void;
}) {
  const t = useT();
  const [projects, setProjects] = useState<WorkspaceProject[]>(() => peekWorkspaceProjects()?.projects ?? []);
  const [actions, setActions] = useState<{ id: string; top: number; left: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceProject | null>(null);
  const [recycleBin, setRecycleBin] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actions) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRoot.current?.contains(event.target)) setActions(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [actions]);
  useEffect(() => { if (!open) setActions(null); }, [open]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchRoot = useRef<HTMLDivElement>(null);
  const createProject = () => {
    setQuery("");
    setSearching(false);
    onCreate();
  };
  const closeSearch = () => {
    setQuery("");
    setSearching(false);
    requestAnimationFrame(() => searchButton.current?.focus());
  };
  useEffect(() => {
    if (!open || !searching) return;
    // The search field can mount while the sidebar is still sliding into view.
    const timer = window.setTimeout(() => searchInput.current?.focus({ preventScroll: true }), 200);
    return () => window.clearTimeout(timer);
  }, [open, searching]);
  useEffect(() => {
    if (!searching || query.trim()) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !searchRoot.current?.contains(event.target)) setSearching(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [searching, query]);
  const needle = query.trim().toLocaleLowerCase();
  const filteredProjects = projects
    .map((project) => ({
      project,
      displayName: projectDisplayName(t, project.name, project.defaultNameIndex),
    }))
    .filter(({ displayName }) => displayName.toLocaleLowerCase().includes(needle));
  useEffect(() => {
    if (!open) return;
    let active = true;
    void projectDeleteMode().then(mode => {
      if (active) setRecycleBin(mode.projectDelete === "recycle_bin");
    }).catch(() => { if (active) setRecycleBin(false); });
    let latestRead = 0;
    const refreshProjects = () => {
      const read = ++latestRead;
      void listWorkspaceProjects().then(result => {
        if (active && read === latestRead) {
          setProjects(result.projects);
          setError(result.warnings.join("\n"));
        }
      }).catch(error => {
        if (active && read === latestRead) setError(errorMessage(error));
      });
    };
    const unsubscribe = subscribeWorkspaceProjects(refreshProjects);
    refreshProjects();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [open]);
  return <div className="od-desktop-navigation">
    <aside id="od-project-sidebar" className="od-project-sidebar" inert={!open} aria-hidden={!open}>
      <div className="od-sidebar-brand"><img src={logo} alt=""/>OpenDirector</div>
      <button className="od-sidebar-create" type="button" disabled={disabled} onClick={createProject} aria-keyshortcuts={shortcutAriaKeys("new-project")}>
        <span className="od-sidebar-create-label"><CanvasIcon name="newProject" size={14} />{t("desktop.sidebar.newProject")}</span>
        <span className="od-sidebar-create-shortcut" aria-hidden="true"><kbd>{shortcutKeys("new-project")}</kbd></span>
      </button>
      <div className="od-sidebar-heading" ref={searchRoot}>
        {searching ? <div className="od-sidebar-search-field">
          <CanvasIcon name="search" size={12} aria-hidden="true" />
          <input ref={searchInput} className="od-sidebar-search" type="search" value={query}
            aria-label={t("canvas.project.search")} placeholder={t("canvas.project.search")}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearch(); } }} />
          <button className="od-sidebar-search-close" type="button" onClick={closeSearch} aria-label={t("common.close")}><CanvasIcon name="close" size={14} /></button>
        </div> : <>
          <span className="od-sidebar-label">{t("desktop.sidebar.projects")}</span>
          <button ref={searchButton} className="od-sidebar-search-toggle" type="button" onClick={() => setSearching(true)}
            aria-label={t("canvas.project.search")} aria-expanded={false} title={t("canvas.project.search")}><CanvasIcon name="search" size={14} /></button>
        </>}
      </div>
      <span className="od-sidebar-switch-status" role="status">{switchingStatus}</span>
      <nav aria-label={t("desktop.sidebar.projects")}>
        {filteredProjects.map(({ project, displayName }) => <div className="od-sidebar-project-row" key={project.id}
          ref={actions?.id === project.id ? menuRoot : undefined}
          onKeyDown={event => { if (event.key === "Escape" && actions?.id === project.id) { event.stopPropagation(); setActions(null); event.currentTarget.querySelector<HTMLButtonElement>(".od-sidebar-project-more")?.focus(); } }}>
          <button className="od-sidebar-project-select" type="button" disabled={disabled} aria-current={project.id === currentId ? "page" : undefined} onClick={() => { setActions(null); void onSelect(project); }}><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M8 5l3 5M15 5l3 5"/></svg><span>{displayName}</span></button>
          <button className="od-sidebar-project-more" type="button" disabled={disabled} aria-label={`${t("canvas.project.actions")}: ${displayName}`} title={t("canvas.project.actions")} aria-haspopup="menu" aria-expanded={actions?.id === project.id}
            onClick={event => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setActions(actions?.id === project.id ? null : { id: project.id, top: Math.min(bounds.bottom + 4, window.innerHeight - 60), left: bounds.right - 160 });
            }}><CanvasIcon name="more" size={16} /></button>
          {actions?.id === project.id && <div className="od-sidebar-project-menu" style={{ top: actions.top, left: actions.left }} role="menu" aria-label={t("canvas.project.actions")}>
            <button type="button" role="menuitem" disabled={disabled} onClick={() => { setActions(null); setDeleteTarget(project); }}><CanvasIcon name="trash" size={15} /><span>{t("canvas.project.deleteAction")}</span></button>
          </div>}
        </div>)}
        {!error && query.trim() && !filteredProjects.length && <p className="od-sidebar-empty" role="status">{t("canvas.project.noSearchResults")}</p>}
      </nav>
      {error && <p role="alert" className="od-sidebar-error">{error}</p>}
      <div className="cw-settings-control od-sidebar-settings"><IconButton name="settings" label={t("canvas.workspace.toolbar.settings")} onClick={onSettings} /></div>
    </aside>
    {deleteTarget && <ProjectDeleteDialog name={projectDisplayName(t, deleteTarget.name, deleteTarget.defaultNameIndex)} recycleBin={recycleBin}
      onClose={() => setDeleteTarget(null)} onSubmit={async () => {
        await onDelete(deleteTarget);
        setProjects(items => items.filter(item => item.id !== deleteTarget.id));
      }} />}
    <div className="od-caption-actions">
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls="od-project-sidebar" title={t("desktop.sidebar.toggle")} aria-label={t("desktop.sidebar.toggle")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
      </button>
      {!open && <button type="button" disabled={disabled} onClick={createProject} title={`${t("desktop.sidebar.newProject")} (${shortcutKeys("new-project")})`} aria-label={t("desktop.sidebar.newProject")} aria-keyshortcuts={shortcutAriaKeys("new-project")}><CanvasIcon name="newProject" size={18} /></button>}
    </div>
  </div>;
}
