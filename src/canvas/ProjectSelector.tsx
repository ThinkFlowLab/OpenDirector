import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CanvasIcon } from "./CanvasIcon";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog";
import { ProjectNameDialog } from "./ProjectNameDialog";
import {
  cleanupUnreadableWorkspaceProjects,
  listWorkspaceProjects,
  projectDeleteMode,
  type UnreadableWorkspaceProject,
  type WorkspaceProject,
} from "../backend/workspace";
import { errorMessage } from "../backend/api";
import { useT } from "../i18n/I18nProvider";

const ACTION_MENU_HEIGHT = 92;

export function ProjectSelector({
  currentId,
  editNameForId,
  name,
  disabled,
  onSelect,
  onCreate,
  onRename,
  onRenameProject,
  onDeleteProject,
}: {
  currentId: string;
  editNameForId?: string | null;
  name: string;
  disabled: boolean;
  onSelect: (project: WorkspaceProject) => Promise<boolean>;
  onCreate: () => void;
  onRename: (name: string) => Promise<void>;
  onRenameProject: (project: WorkspaceProject, name: string) => Promise<void>;
  onDeleteProject: (project: WorkspaceProject) => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [unreadable, setUnreadable] = useState<UnreadableWorkspaceProject[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [renameError, setRenameError] = useState("");
  const [actions, setActions] = useState<{ id: string; top: number } | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<WorkspaceProject | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceProject | null>(
    null,
  );
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [recycleBin, setRecycleBin] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const editingRef = useRef(false);
  const renamePending = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const actionButtons = useRef(new Map<string, HTMLButtonElement>());
  const menuId = useId();
  const renameErrorId = useId();
  useEffect(() => {
    if (editing) {
      nameInput.current?.focus();
      nameInput.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    setOpen(false);
    setActions(null);
    editingRef.current = false;
    setEditing(false);
    setRenameError("");
  }, [currentId]);
  const editedNewProject = useRef<string | null>(null);
  useEffect(() => {
    if (disabled || editNameForId !== currentId || editedNewProject.current === currentId) return;
    editedNewProject.current = currentId;
    setOpen(false);
    setDraftName(name);
    setRenameError("");
    editingRef.current = true;
    setEditing(true);
  }, [currentId, editNameForId, disabled, name]);
  const closeActions = useCallback((restoreFocus: boolean) => {
    setActions((current) => {
      if (current && restoreFocus)
        requestAnimationFrame(() =>
          actionButtons.current.get(current.id)?.focus(),
        );
      return null;
    });
  }, []);
  const loadProjects = useCallback(async () => {
    const result = await listWorkspaceProjects();
    setProjects(result.projects);
    setUnreadable(result.unreadable);
    setError(result.warnings.join("\n"));
  }, []);
  const openActions = (
    project: WorkspaceProject,
    button: HTMLButtonElement,
  ) => {
    const dropdown = container.current?.querySelector<HTMLElement>(
      ".cw-project-dropdown",
    );
    const row = button.closest<HTMLElement>(".cw-project-row");
    if (!dropdown || !row) return;
    const box = dropdown.getBoundingClientRect();
    const top = Math.min(
      Math.max(row.getBoundingClientRect().top - box.top, 0),
      Math.max(box.height - ACTION_MENU_HEIGHT, 0),
    );
    setActions({ id: project.id, top });
  };
  const finishEditing = (restoreFocus: boolean) => {
    editingRef.current = false;
    setEditing(false);
    setRenameError("");
    if (restoreFocus) requestAnimationFrame(() => nameButton.current?.focus());
  };
  const saveName = async (restoreFocus: boolean) => {
    if (!editingRef.current) return true;
    if (renamePending.current) return false;
    const nextName = draftName.trim();
    if (nextName === name) {
      finishEditing(restoreFocus);
      return true;
    }
    if (!nextName) {
      setRenameError(t("canvas.project.nameRequired"));
      return false;
    }
    renamePending.current = true;
    setBusy(true);
    setRenameError("");
    try {
      await onRename(nextName);
      finishEditing(restoreFocus);
      return true;
    } catch (reason) {
      setRenameError(errorMessage(reason));
      return false;
    } finally {
      renamePending.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError("");
    setNotice("");
    void projectDeleteMode()
      .then((mode) => {
        if (active) setRecycleBin(mode.projectDelete === "recycle_bin");
      })
      .catch(() => {
        // The prompt stays on the permanent wording when the mode is unknown.
        if (active) setRecycleBin(false);
      });
    void listWorkspaceProjects()
      .then((result) => {
        if (active) {
          setProjects(result.projects);
          setUnreadable(result.unreadable);
          setError(result.warnings.join("\n"));
        }
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const dismiss = (event: Event) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      active = false;
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setActions(null);
  }, [open]);
  const filteredProjects = projects.filter(project => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(() => {
    if (open) searchInput.current?.focus();
    else setQuery("");
  }, [open]);
  return (
    <div
      className="cw-project-selector"
      ref={container}
      onKeyDown={(event) => {
        if (editing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (actions) {
            closeActions(true);
            return;
          }
          setOpen(false);
          trigger.current?.focus();
        } else if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!open) {
            if (event.target !== trigger.current) return;
            setOpen(true);
            return;
          }
          const buttons = Array.from(
            container.current!.querySelectorAll<HTMLButtonElement>(
              "[role=menuitemradio]:not(:disabled),[role=menuitem]:not(:disabled)",
            ),
          );
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : event.key === "ArrowUp"
                  ? (index - 1 + buttons.length) % buttons.length
                  : (index + 1) % buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      <div
        className={`cw-project-title${editing ? " cw-project-name-editor" : ""}`}
        aria-busy={busy}
      >
        {editing ? (
          <div className="cw-project-name-field">
            <span className="cw-project-name-measure" aria-hidden="true">
              {draftName || t("canvas.project.namePlaceholder")}
            </span>
            <input
              ref={nameInput}
              aria-label={t("canvas.project.nameLabel")}
              placeholder={t("canvas.project.namePlaceholder")}
              value={draftName}
              maxLength={100}
              readOnly={busy}
              aria-invalid={!!renameError}
              aria-describedby={renameError ? renameErrorId : undefined}
              onChange={(event) => {
                setDraftName(event.target.value);
                setRenameError("");
              }}
              onBlur={() => {
                if (!renameError) void saveName(false);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing || event.keyCode === 229)
                  return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveName(true);
                } else if (event.key === "Escape" && !renamePending.current) {
                  event.preventDefault();
                  finishEditing(true);
                }
              }}
            />
          </div>
        ) : (
          <button
            className="cw-project-name"
            ref={nameButton}
            disabled={disabled || busy}
            title={t("canvas.project.editNameHint")}
            onKeyDown={(event) => {
              // Focus returns here after saving; a held submit key must not reopen editing.
              if (event.repeat && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onClick={() => {
              setOpen(false);
              setDraftName(name);
              setRenameError("");
              editingRef.current = true;
              setEditing(true);
            }}
          >
            {name}
          </button>
        )}
        <button
          type="button"
          className="cw-project-chevron"
          ref={trigger}
          disabled={disabled || busy}
          aria-label={t("canvas.project.switch")}
          title={t("canvas.project.switch")}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onPointerDown={(event) => {
            // Commit editing in the click handler so blur cannot swallow this click.
            if (editingRef.current) event.preventDefault();
          }}
          onClick={async () => {
            if (editingRef.current && !(await saveName(false))) return;
            setOpen((value) => !value);
          }}
        >
          <CanvasIcon name="chevron" size={14} />
        </button>
      </div>
      {editing && renameError && (
        <p className="cw-project-rename-error" id={renameErrorId} role="alert">
          {renameError}
        </p>
      )}
      {open && (
        <div
          className="cw-project-dropdown"
          role="menu"
          id={menuId}
          aria-label={t("canvas.project.menuLabel")}
        >
          <div className="cw-project-caption">
            {t("canvas.project.caption")}
          </div>
          <div className="cw-project-search">
            <CanvasIcon name="search" size={15} />
            <input ref={searchInput} type="search" value={query}
              aria-label={t("canvas.project.search")}
              placeholder={t("canvas.project.search")}
              onChange={event => { setQuery(event.target.value); closeActions(false); }}
              onKeyDown={event => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Escape") event.stopPropagation();
              }}
            />
            {query && <button type="button" aria-label={t("canvas.project.clearSearch")} onClick={() => { setQuery(""); searchInput.current?.focus(); }}><CanvasIcon name="close" size={14} /></button>}
          </div>
          {error && (
            <p className="cw-project-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="cw-project-notice" role="status">
              {notice}
            </p>
          )}
          {!loading && !error && query.trim() && !filteredProjects.length && <p className="cw-project-placeholder" role="status">{t("canvas.project.noSearchResults")}</p>}
          <div
            className="cw-project-list"
            aria-busy={loading || busy}
            onScroll={() => closeActions(false)}
          >
            {loading ? (
              <p className="cw-project-placeholder" role="status">
                {t("canvas.project.loading")}
              </p>
            ) : (
              filteredProjects.map((project) => (
                <div className="cw-project-row" key={project.id}>
                  <button
                    role="menuitemradio"
                    aria-checked={project.id === currentId}
                    disabled={disabled || busy}
                    className="cw-project-option"
                    title={project.name}
                    onClick={async () => {
                      if (project.id === currentId) {
                        setOpen(false);
                        return;
                      }
                      setBusy(true);
                      setError("");
                      try {
                        if (await onSelect(project)) setOpen(false);
                      } catch (reason) {
                        setError(errorMessage(reason));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <span className="cw-project-thumbnail" aria-hidden="true">
                      <CanvasIcon name="group" size={18} />
                    </span>
                    <span className="cw-project-option-name">
                      {project.name}
                    </span>
                    {project.id === currentId && (
                      <span className="cw-project-check">
                        <CanvasIcon name="check" size={20} />
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="cw-project-more"
                    ref={(element) => {
                      if (element)
                        actionButtons.current.set(project.id, element);
                      else actionButtons.current.delete(project.id);
                    }}
                    disabled={disabled || busy}
                    aria-label={t("canvas.project.actionsFor", {
                      name: project.name,
                    })}
                    title={t("canvas.project.actions")}
                    aria-haspopup="menu"
                    aria-expanded={actions?.id === project.id}
                    onClick={(event) => {
                      if (actions?.id === project.id) closeActions(true);
                      else openActions(project, event.currentTarget);
                    }}
                  >
                    <CanvasIcon name="more" size={18} />
                  </button>
                </div>
              ))
            )}
          </div>
          {unreadable.length > 0 && (
            <button
              className="cw-project-cleanup"
              role="menuitem"
              disabled={busy || loading || disabled}
              onClick={() => setCleanupOpen(true)}
            >
              <span>
                {t("canvas.project.cleanup", { count: unreadable.length })}
              </span>
              <CanvasIcon name="trash" size={18} />
            </button>
          )}
          <button
            className="cw-project-create"
            role="menuitem"
            disabled={busy || loading || disabled}
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
          >
            <span>{t("canvas.project.create")}</span>
            <CanvasIcon name="plus" size={20} />
          </button>
          {actions && (
            <div
              className="cw-project-actions"
              role="menu"
              aria-label={t("canvas.project.actions")}
              style={{ top: actions.top }}
            >
              <button
                role="menuitem"
                disabled={disabled || busy}
                onClick={() => {
                  const target = projects.find(
                    (item) => item.id === actions.id,
                  );
                  closeActions(false);
                  if (target) setRenameTarget(target);
                }}
              >
                <CanvasIcon name="pencil" size={18} />
                <span>{t("common.rename")}</span>
              </button>
              <button
                className="cw-danger"
                role="menuitem"
                disabled={disabled || busy}
                onClick={() => {
                  const target = projects.find(
                    (item) => item.id === actions.id,
                  );
                  closeActions(false);
                  if (target) setDeleteTarget(target);
                }}
              >
                <CanvasIcon name="trash" size={18} />
                <span>{t("canvas.project.deleteAction")}</span>
              </button>
            </div>
          )}
        </div>
      )}
      {renameTarget && (
        <ProjectNameDialog
          initialName={renameTarget.name}
          title={t("canvas.project.renameTitle")}
          submitLabel={t("canvas.project.saveName")}
          hint={t("canvas.project.renameHint")}
          onClose={() => setRenameTarget(null)}
          onSubmit={async (nextName) => {
            await onRenameProject(renameTarget, nextName);
            await loadProjects();
          }}
        />
      )}
      {deleteTarget && (
        <ProjectDeleteDialog
          name={deleteTarget.name}
          recycleBin={recycleBin}
          onClose={() => setDeleteTarget(null)}
          onSubmit={async () => {
            await onDeleteProject(deleteTarget);
            // The project is gone on the server; drop the row in place instead
            // of another full list read before the dialog can close. The next
            // selector open reloads the authoritative list.
            setProjects((items) =>
              items.filter((item) => item.id !== deleteTarget.id),
            );
          }}
        />
      )}
      {cleanupOpen && (
        <ProjectDeleteDialog
          name={unreadable
            .map((project) => project.name)
            .join(t("canvas.project.nameSeparator"))}
          title={t("canvas.project.cleanupTitle")}
          description={t("canvas.project.cleanupDescription", {
            count: unreadable.length,
          })}
          submitLabel={t("canvas.project.cleanupSubmit")}
          busyLabel={t("canvas.project.cleaningUp")}
          recycleBin={recycleBin}
          onClose={() => setCleanupOpen(false)}
          onSubmit={async () => {
            const result = await cleanupUnreadableWorkspaceProjects();
            await loadProjects();
            if (result.failed.length) {
              const failures = result.failed
                .map((item) =>
                  t("canvas.project.cleanupFailure", {
                    name: item.name,
                    message: item.message,
                  }),
                )
                .join("\n");
              throw new Error(
                `${result.removed.length ? `${t("canvas.project.cleanupRemoved", { count: result.removed.length })}\n` : ""}${failures}`,
              );
            }
            setNotice(
              result.removed.length
                ? t("canvas.project.cleanupNotice", {
                    count: result.removed.length,
                  })
                : t("canvas.project.cleanupNone"),
            );
          }}
        />
      )}
    </div>
  );
}
