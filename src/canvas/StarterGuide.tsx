import { useEffect, useRef, useState } from "react";
import type { WorkspaceRuntime } from "./workspace/runtimeTypes.ts";
import {
  importWorkspaceDocument,
  listWorkspaceProjects,
  openWorkspaceProject,
} from "../backend/workspace.ts";
import { errorMessage } from "../backend/api.ts";
import {
  GUIDE_IDS,
  assembleStarterTimeline,
  isStarterProject,
  starterDocument,
} from "./starterGuide.ts";
import type { CanvasDocument } from "./model.ts";
import "./starter-guide.css";

const preference = "opendirector.starterGuide.v1";
const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* UI hints only */
  }
};
export function StarterGuide({ rt }: { rt: WorkspaceRuntime }) {
  const { doc, t } = rt;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState("");
  const active = isStarterProject(doc);
  useEffect(() => {
    const show = () => {
      setOpen(true);
      setError("");
    };
    window.addEventListener("opendirector:starter-guide", show);
    return () => window.removeEventListener("opendirector:starter-guide", show);
  }, []);
  useEffect(() => {
    if (!active) {
      setStep(0);
      return;
    }
    const saved = Number(read(`${preference}:${doc.id}`) || 0);
    setStep(Number.isInteger(saved) ? Math.max(0, Math.min(5, saved)) : 0);
    setOpen(read(`${preference}:visible`) === "true");
  }, [doc.id, active]);
  useEffect(() => {
    setDraft(
      doc.nodes.find(
        (n) => n.id === (step === 0 ? GUIDE_IDS.story : GUIDE_IDS.shots),
      )?.data.text || "",
    );
  }, [doc.id, step]);
  const move = (next: number) => {
    setStep(next);
    write(`${preference}:${doc.id}`, String(next));
  };
  const run = async (action: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const save = async (next: CanvasDocument) => {
    if (rt.historyRef.current.present.id !== next.id)
      throw new Error(t("guide.changed"));
    if (!(await rt.persist(next)))
      throw new Error(rt.saveError.current || t("guide.saveFailed"));
    rt.installDocument(next);
  };
  const start = (fresh = false) =>
    run(async () => {
      const previous = fresh ? null : read(`${preference}:project`);
      const existing = previous
        ? (await listWorkspaceProjects({ fresh: true })).projects.find(
            (p) => p.id === previous,
          )
        : undefined;
      const ok = await rt.switchDocument(
        async () => {
          const next = existing
            ? await openWorkspaceProject(existing)
            : await importWorkspaceDocument(await starterDocument(t));
          write(`${preference}:project`, next.id);
          return next;
        },
        true,
        true,
      );
      if (ok) {
        write(`${preference}:visible`, "true");
        setOpen(true);
      }
    });
  const focus = (id: string) => {
    const node = doc.nodes.find((n) => n.id === id);
    if (node) {
      rt.setSelected([id]);
      void rt.flow.fitView({ nodes: [{ id }], padding: 0.6, duration: 250 });
    }
  };
  const close = () => {
    setOpen(false);
    write(`${preference}:visible`, "false");
  };
  const node = doc.nodes.find((n) => n.id === GUIDE_IDS.timeline);
  return (
    <>
      {!open && active && (
        <button
          className="starter-guide-reopen"
          onClick={() => {
            setOpen(true);
            write(`${preference}:visible`, "true");
          }}
        >
          {t("guide.resume")}
        </button>
      )}
      {open && (
        <aside className="starter-guide" aria-label={t("guide.title")}>
          <header>
            <strong>{t("guide.title")}</strong>
            <button onClick={close} aria-label={t("guide.skip")}>
              ×
            </button>
          </header>
          <p className="starter-guide-honesty">{t("guide.honesty")}</p>
          {!active ? (
            <>
              <h2>{t("guide.project")}</h2>
              <p>{t("guide.intro")}</p>
              <button disabled={busy || !rt.ready} onClick={() => void start()}>
                {t("guide.start")}
              </button>
              <button onClick={close}>{t("guide.skip")}</button>
            </>
          ) : (
            <>
              <progress
                value={step + 1}
                max={6}
                aria-label={t("guide.progress")}
              />
              <h2>
                {step + 1}/6 ·{" "}
                {t(
                  (
                    [
                      "guide.story",
                      "guide.shots",
                      "guide.reference",
                      "guide.keyframe",
                      "guide.timeline",
                      "guide.delivery",
                    ] as const
                  )[step]!,
                )}
              </h2>
              <p>
                {t(
                  (
                    [
                      "guide.storyHint",
                      "guide.shotsHint",
                      "guide.referenceHint",
                      "guide.keyframeHint",
                      "guide.timelineHint",
                      "guide.deliveryHint",
                    ] as const
                  )[step]!,
                )}
              </p>
              {step < 2 && (
                <>
                  <textarea
                    aria-label={t(step === 0 ? "guide.story" : "guide.shots")}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={5}
                  />
                  <button
                    disabled={busy || !draft.trim()}
                    onClick={() =>
                      void run(async () => {
                        const id =
                          step === 0 ? GUIDE_IDS.story : GUIDE_IDS.shots;
                        const current = rt.historyRef.current.present;
                        await save({
                          ...current,
                          nodes: current.nodes.map((n) =>
                            n.id === id
                              ? { ...n, data: { ...n.data, text: draft } }
                              : n,
                          ),
                        });
                        focus(id);
                        move(step + 1);
                      })
                    }
                  >
                    {t("guide.saveContinue")}
                  </button>
                </>
              )}
              {step === 2 && (
                <>
                  <button onClick={() => focus(GUIDE_IDS.reference)}>
                    {t("guide.inspect")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const current = rt.historyRef.current.present;
                        const exists = current.edges.some(
                          (e) =>
                            e.source === GUIDE_IDS.reference &&
                            e.target === GUIDE_IDS.generation,
                        );
                        if (!exists)
                          await save({
                            ...current,
                            edges: [
                              ...current.edges,
                              {
                                id: crypto.randomUUID(),
                                source: GUIDE_IDS.reference,
                                target: GUIDE_IDS.generation,
                              },
                            ],
                          });
                        focus(GUIDE_IDS.generation);
                        move(3);
                      })
                    }
                  >
                    {t("guide.connect")}
                  </button>
                </>
              )}
              {step === 3 && (
                <>
                  <div className="starter-guide-candidates">
                    {[GUIDE_IDS.original, GUIDE_IDS.alternative].map((id) => {
                      const candidate = doc.nodes.find((n) => n.id === id);
                      return (
                        candidate && (
                          <button
                            key={id}
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const current = rt.historyRef.current.present;
                                const chosen = current.nodes.find(
                                  (n) => n.id === id,
                                )!;
                                await save({
                                  ...current,
                                  nodes: current.nodes.map((n) =>
                                    n.id === GUIDE_IDS.keyframe
                                      ? {
                                          ...n,
                                          data: {
                                            ...n.data,
                                            src: chosen.data.src,
                                            mimeType: chosen.data.mimeType,
                                            generationProvenance: {
                                              source: "imported",
                                            },
                                          },
                                        }
                                      : n,
                                  ),
                                });
                                focus(GUIDE_IDS.keyframe);
                                move(4);
                              })
                            }
                          >
                            <img
                              src={candidate.data.src}
                              alt={candidate.data.title}
                            />
                            {t("guide.choose")}
                          </button>
                        )
                      );
                    })}
                  </div>
                  <small>{t("guide.noRegeneration")}</small>
                </>
              )}
              {step === 4 && (
                <>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await save(
                          assembleStarterTimeline(
                            rt.historyRef.current.present,
                          ),
                        );
                        focus(GUIDE_IDS.timeline);
                        move(5);
                      })
                    }
                  >
                    {t("guide.assemble")}
                  </button>
                </>
              )}
              {step === 5 && (
                <>
                  <button
                    disabled={busy || !node}
                    onClick={() => {
                      if (node) void rt.openEditor(node);
                    }}
                  >
                    {t("guide.editExport")}
                  </button>
                  <p>{t("guide.exportHonesty")}</p>
                  <button onClick={close}>{t("guide.keepEditing")}</button>
                </>
              )}
              <footer>
                <button
                  disabled={step === 0 || busy}
                  onClick={() => move(step - 1)}
                >
                  {t("guide.back")}
                </button>
                <button disabled={busy} onClick={() => void start(true)}>
                  {t("guide.fresh")}
                </button>
                <button onClick={close}>{t("guide.skip")}</button>
              </footer>
            </>
          )}
          {busy && <p role="status">{t("guide.saving")}</p>}
          {error && <p role="alert">{error}</p>}
        </aside>
      )}
    </>
  );
}
