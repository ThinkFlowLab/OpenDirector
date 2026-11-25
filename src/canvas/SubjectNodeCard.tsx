import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import type { CanvasNodeData, CanvasResource } from "./model";
import type { CanvasActions } from "./CanvasActionsContext";
import { CanvasIcon } from "./CanvasIcon";
import { useCanvasPlayback } from "./CanvasMediaPreview";
import { subjectDescriptionLayout } from "./subjectLayout.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { AssetMedia } from "./useAssetMedia.tsx";

/** Subject media is retained content, while the description is a user annotation. */
export function SubjectNodeCard({
  id,
  data,
  actions,
}: {
  id: string;
  data: CanvasNodeData;
  actions: CanvasActions | null;
}) {
  const t = useT();
  const subject = data.subject;
  const main = subject?.main;
  const auxiliaries = subject?.auxiliaries ?? [];
  const locked = Boolean(actions?.isLocked(id));
  return (
    <div
      className={`cw-subject-card${main?.src ? " cw-domain-card cw-domain-card-subject" : " cw-subject-empty"}`}
    >
      <div className="cw-subject-details">
        <SubjectDescription
          id={id}
          value={subject?.description ?? ""}
          actions={actions}
          layoutKey={`${main?.kind}:${main?.width}:${main?.height}`}
        />
        {main?.kind === "image" && (
          <SubjectVoice
            resource={subject?.voice}
            locked={locked}
            onAdd={() => actions?.pickSubject?.(id, "assets", "voice")}
          />
        )}
      </div>
      {!main?.src ? (
        <div className="cw-subject-empty-material nodrag nopan">
          {(
            [
              ["import", "canvasNodes.subject.import", "subject"],
              ["canvas", "canvasNodes.subject.fromCanvas", "canvas"],
              ["assets", "canvasNodes.subject.fromAssets", "rail-folder"],
              ["file", "canvasNodes.subject.fromFile", "upload"],
            ] as const
          ).map(([source, label, icon]) => (
            <button
              key={source}
              type="button"
              disabled={locked}
              onClick={() => actions?.pickSubject?.(id, source)}
            >
              <CanvasIcon name={icon} size={13} />
              {t(label)}
            </button>
          ))}
        </div>
      ) : main.kind === "video" ? (
        <SubjectVideo
          resource={main}
          onSelect={(event) => actions?.select(id, event)}
          onImport={() => actions?.pickSubject?.(id, "import")}
          locked={locked}
        />
      ) : (
        <div className="cw-subject-media cw-subject-images">
          <div className="cw-subject-main cw-domain-card-preview">
            <AssetMedia as="img" src={main.src} alt={main.title} draggable={false} />
            <SubjectImportButton
              locked={locked}
              onClick={() => actions?.pickSubject?.(id, "import")}
            />
          </div>
          <div
            className="cw-subject-auxiliaries"
            aria-label={t("canvasNodes.subject.auxiliaries")}
          >
            {auxiliaries.map((item) => (
              <div className="cw-subject-auxiliary" key={item.id}>
                <AssetMedia as="img" src={item.src} alt={item.title} draggable={false} />
              </div>
            ))}
            {auxiliaries.length < 3 && (
              <button
                type="button"
                className="cw-subject-add-auxiliary nodrag nopan"
                aria-label={t("canvasNodes.subject.addAuxiliary")}
                title={t("canvasNodes.subject.addAuxiliaryHint")}
                disabled={locked}
                style={{ gridRow: `span ${3 - auxiliaries.length}` }}
                onClick={() =>
                  actions?.pickSubject?.(id, "assets", "auxiliary")
                }
              >
                <CanvasIcon name="plus" size={22} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Manual subject playback shares canvas ownership and modal/visibility blocking. */
function useSubjectPlayer<T extends HTMLMediaElement>(src?: string) {
  const media = useRef<T>(null);
  const [playing, setPlaying] = useState(false);
  const playback = useCanvasPlayback();
  useEffect(() => {
    if (playback.blocked) media.current?.pause();
  }, [playback.blocked]);
  useEffect(() => {
    setPlaying(false);
    const element = media.current;
    return () => element?.pause();
  }, [src]);
  return {
    media,
    playing,
    toggle: () => {
      if (!media.current || playback.blocked) return;
      if (media.current.paused) void media.current.play().catch(() => {});
      else media.current.pause();
    },
    onPlay: () => {
      if (!media.current) return;
      if (playback.blocked) media.current.pause();
      else {
        playback.claim(media.current);
        setPlaying(true);
      }
    },
    onPause: () => setPlaying(false),
  };
}

function SubjectVideo({
  resource,
  onSelect,
  onImport,
  locked,
}: {
  resource: CanvasResource;
  onSelect: (event: MouseEvent) => void;
  onImport: () => void;
  locked: boolean;
}) {
  const t = useT();
  const player = useSubjectPlayer<HTMLVideoElement>(resource.src);
  return (
    <div className="cw-subject-media cw-subject-video cw-domain-card-preview">
      <AssetMedia
        as="video"
        ref={player.media}
        src={resource.src}
        playsInline
        preload="metadata"
        aria-label={resource.title}
        controls={player.playing}
        className={player.playing ? "nodrag nopan" : undefined}
        onPlay={player.onPlay}
        onPause={player.onPause}
        onEnded={player.onPause}
        onClick={onSelect}
      />
      {!player.playing && (
        <button
          type="button"
          className="cw-subject-play nodrag nopan"
          aria-label={t("canvasNodes.subject.playVideo")}
          onClick={player.toggle}
        >
          <CanvasIcon name="play" size={19} />
        </button>
      )}
      <SubjectImportButton locked={locked} onClick={onImport} />
    </div>
  );
}

function SubjectImportButton({
  locked,
  onClick,
}: {
  locked: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="cw-subject-replace nodrag nopan"
      aria-label={t("canvasNodes.subject.importContent")}
      title={t("canvasNodes.subject.importContent")}
      disabled={locked}
      onClick={onClick}
    >
      <CanvasIcon name="rail-folder" size={14} />
    </button>
  );
}

function SubjectVoice({
  resource,
  locked,
  onAdd,
}: {
  resource?: CanvasResource;
  locked: boolean;
  onAdd: () => void;
}) {
  const t = useT();
  const player = useSubjectPlayer<HTMLAudioElement>(resource?.src);
  const label = resource?.src
    ? player.playing
      ? t("canvasNodes.subject.pauseVoice")
      : t("canvasNodes.subject.playVoice")
    : t("canvasNodes.subject.addVoice");
  return (
    <div className="cw-subject-voice nodrag nopan">
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={locked && !resource?.src}
        aria-pressed={Boolean(resource?.src && player.playing)}
        onClick={resource?.src ? player.toggle : onAdd}
      >
        <CanvasIcon name={player.playing ? "pause" : "audio"} size={15} />
      </button>
      {resource?.src && (
        <AssetMedia
          as="audio"
          ref={player.media}
          src={resource.src}
          hidden
          preload="metadata"
          onPlay={player.onPlay}
          onPause={player.onPause}
          onEnded={player.onPause}
        />
      )}
    </div>
  );
}

/** User annotations are edited on the canvas, independently of retained media. */
function SubjectDescription({
  id,
  value,
  actions,
  layoutKey,
}: {
  id: string;
  value: string;
  actions: CanvasActions | null;
  layoutKey: string;
}) {
  const t = useT();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const resize = actions?.resizeSubjectDescription;
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    const measure = () => {
      if (!element.clientWidth) return;
      element.style.height = "0px";
      element.style.overflowY = "hidden";
      const contentHeight = element.scrollHeight;
      const { descriptionHeight } = subjectDescriptionLayout(contentHeight);
      element.style.height = `${descriptionHeight}px`;
      element.style.overflowY =
        contentHeight > descriptionHeight ? "auto" : "hidden";
      resize?.(id, contentHeight);
    };
    measure();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      measure();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [draft, id, resize, layoutKey]);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  return (
    <textarea
      ref={input}
      className="cw-subject-description nodrag nopan nowheel"
      aria-label={t("canvasNodes.subject.description")}
      title={t("canvasNodes.subject.descriptionHint")}
      placeholder={t("canvasNodes.subject.descriptionPlaceholder")}
      rows={1}
      maxLength={20000}
      readOnly={actions?.isLocked(id)}
      value={draft}
      onFocus={() => {
        cancelled.current = false;
        setEditing(true);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const node = actions?.getNode(id);
        if (
          !cancelled.current &&
          node?.type === "subject" &&
          node.data.subject &&
          !actions?.isLocked(id) &&
          draft !== node.data.subject.description
        )
          actions?.update(id, {
            subject: { ...node.data.subject, description: draft },
          });
        setEditing(false);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.preventDefault();
          cancelled.current = true;
          setDraft(value);
          event.currentTarget.blur();
        } else if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
