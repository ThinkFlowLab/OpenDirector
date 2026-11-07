import { memo, useContext, type MouseEvent } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { NodeFrame } from "./NodeFrame";
import type { CanvasNodeData, CanvasNodeKind, CanvasResource } from "./model";
import { ResourcePreview } from "./EditorModal";
import { resourceFromNode } from "./operations";
import { timelineDuration } from "./timeline";
import { SubjectNodeCard } from "./SubjectNodeCard";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { GeneratingOverlay } from "./GeneratingOverlay";
import { CanvasVideoPreview } from "./CanvasMediaPreview";
import "./nodes.css";
import {
  CanvasActionsContext,
  type CanvasActions,
} from "./CanvasActionsContext";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";

export type CanvasFlowNode = Node<CanvasNodeData, CanvasNodeKind>;

const kindNameKeys: Record<CanvasNodeKind, MessageKey> = {
  image: "canvasNodes.kind.image",
  video: "canvasNodes.kind.video",
  audio: "canvasNodes.kind.audio",
  text: "canvasNodes.kind.text",
  file: "canvasNodes.kind.file",
  group: "canvasNodes.kind.group",
  timeline: "canvasNodes.kind.timeline",
  subject: "canvasNodes.kind.subject",
  stack: "canvasNodes.kind.stack",
  tool: "canvasNodes.kind.tool",
  external: "canvasNodes.kind.external",
};

const toolRoleKeys: Record<string, MessageKey> = {
  camera: "canvasNodes.tool.role.camera",
  style: "canvasNodes.tool.role.style",
  palette: "canvasNodes.tool.role.palette",
  camera_motion: "canvasNodes.tool.role.cameraMotion",
};

function CanvasNodeContents({ id, data, selected }: NodeProps<CanvasFlowNode>) {
  const { t } = useI18n();
  const actions = useContext(CanvasActionsContext);
  const kind = data.kind;
  const hasAsset = Boolean(data.src) && data.assetState !== "missing";
  const locked = Boolean(actions?.isLocked(id));
  const activity = ["text", "image", "video", "audio"].includes(kind)
    ? actions?.generationActivity(id)
    : undefined;
  const selectMedia = (event: MouseEvent) => {
    event.stopPropagation();
    // Media controls keep their native playback behavior. Their nodrag surface
    // does not reach React Flow selection, so select it explicitly on a click.
    if (selected) actions?.reopenComposer(id, event);
    else actions?.select(id, event);
  };

  return (
    <NodeFrame
      id={id}
      kind={kind}
      title={data.title || t(kindNameKeys[kind])}
      selected={selected}
      empty={
        kind === "subject" ? !data.subject?.main?.src : !hasAsset && !data.text
      }
      busy={Boolean(activity)}
    >
      {kind === "group" ? (
        <div className="cw-group-interior" />
      ) : kind === "subject" ? (
        <SubjectNodeCard id={id} data={data} actions={actions} />
      ) : ["timeline", "stack", "tool", "external"].includes(kind) ? (
        <DomainCard id={id} data={data} actions={actions} />
      ) : kind === "text" ? (
        actions?.isTextEditing(id) ? (
          <textarea
            className="cw-text-editor nodrag nopan nowheel"
            aria-label={t("canvasNodes.text.content", { title: data.title })}
            placeholder={t("canvasNodes.text.placeholder")}
            spellCheck={false}
            readOnly={locked}
            autoFocus
            defaultValue={data.text ?? ""}
            onFocus={() => actions?.beginEdit?.(id)}
            onBlur={() => actions?.finishTextEdit()}
            onChange={(event) =>
              actions?.update(id, { text: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.nativeEvent.isComposing)
                event.stopPropagation();
            }}
          />
        ) : (
          <div
            className="cw-text-display"
            aria-label={t("canvasNodes.text.content", { title: data.title })}
          >
            {data.text || (
              <span className="cw-text-placeholder">
                {t("canvasNodes.text.editHint")}
              </span>
            )}
          </div>
        )
      ) : hasAsset ? (
        <div className="cw-node-media">
          {data.generationEvidence?.placeholder && (
            <span className="cw-node-placeholder-chip" role="status">
              {t("canvasNodes.placeholderBadge")}
            </span>
          )}
          {kind === "image" && (
            <img
              className="cw-image-preview"
              src={data.src}
              alt={data.title}
              draggable={false}
              onLoad={(event) =>
                actions?.metadata(id, {
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })
              }
            />
          )}
          {kind === "video" && (
            <CanvasVideoPreview
              className="cw-video-preview"
              src={data.src}
              playsInline
              preload="metadata"
              selected={selected}
              onClick={selectMedia}
              onDurationChange={(event) =>
                actions?.metadata(id, {
                  durationSeconds: event.currentTarget.duration,
                })
              }
              onLoadedMetadata={(event) =>
                actions?.metadata(id, {
                  width: event.currentTarget.videoWidth,
                  height: event.currentTarget.videoHeight,
                  durationSeconds: event.currentTarget.duration,
                })
              }
            />
          )}
          {kind === "audio" && (
            <div className="cw-audio-preview">
              <div className="cw-audio-wave" aria-hidden="true">
                {Array.from({ length: 32 }, (_, index) => (
                  <i
                    key={index}
                    style={{
                      height: `${14 + Math.sin(index * 1.8) ** 2 * 62}%`,
                    }}
                  />
                ))}
              </div>
              <audio
                className="nodrag nopan"
                src={data.src}
                controls
                preload="metadata"
                onClick={selectMedia}
                onDurationChange={(event) =>
                  actions?.metadata(id, {
                    durationSeconds: event.currentTarget.duration,
                  })
                }
                onLoadedMetadata={(event) =>
                  actions?.metadata(id, {
                    durationSeconds: event.currentTarget.duration,
                  })
                }
              />
            </div>
          )}
          {kind === "file" && (
            <button
              className="cw-file-preview nodrag nopan"
              onClick={(event) => {
                event.stopPropagation();
                actions?.preview(id);
              }}
            >
              <CanvasIcon name="file" size={38} />
              <strong>{data.title}</strong>
              <span>{data.mimeType || t("canvasNodes.file.local")}</span>
              <span className="cw-file-action">
                {t("canvasNodes.file.open")}{" "}
                <CanvasIcon name="arrowRight" size={14} />
              </span>
            </button>
          )}
        </div>
      ) : (
        <div className="cw-node-placeholder">
          <span className="cw-placeholder-symbol">
            <CanvasIcon name={kind} size={20} />
          </span>
          <span className="cw-placeholder-label">
            {data.assetState === "missing"
              ? t("canvasNodes.upload.missing")
              : t(kindNameKeys[kind])}
          </span>
          {!locked && (
            <button
              className="cw-placeholder-upload nodrag nopan"
              aria-label={t("canvasNodes.upload.aria", {
                kind: t(kindNameKeys[kind]),
              })}
              onClick={(event) => {
                event.stopPropagation();
                actions?.upload(id);
              }}
            >
              <CanvasIcon name="upload" size={14} />
              {t("canvasNodes.upload.local")}
            </button>
          )}
        </div>
      )}

      {activity && (
        <GeneratingOverlay
          activity={activity}
          hasAsset={hasAsset || Boolean(data.text)}
        />
      )}
    </NodeFrame>
  );
}

// React Flow moves the wrapper; position-only props do not change card contents.
export const CanvasNodeView = memo(
  CanvasNodeContents,
  (previous, next) =>
    previous.id === next.id &&
    previous.data === next.data &&
    previous.selected === next.selected,
);

function DomainCard({
  id,
  data,
  actions,
}: {
  id: string;
  data: CanvasNodeData;
  actions: CanvasActions | null;
}) {
  const { t } = useI18n();
  const kind = data.kind;
  const stack = data.stack;
  const member =
    stack && actions?.getNode(stack.nodeIds[stack.activeIndex] ?? "");
  const stackResource = member
    ? (resourceFromNode(member) ?? member.data.subject?.main)
    : undefined;
  const timeline = data.timeline;
  const firstClip = timeline?.tracks.find((track) => track.kind === "visual")
    ?.clips[0];
  const resource: CanvasResource | undefined =
    kind === "stack"
      ? stackResource
      : kind === "timeline"
        ? firstClip?.resource
        : data.src
          ? { id, kind: "image", title: data.title, src: data.src }
          : undefined;
  return (
    <div className={`cw-domain-card cw-domain-card-${kind}`}>
      {(kind === "stack" || kind === "timeline" || kind === "external") && (
        <div className="cw-domain-card-preview">
          {resource ? (
            <ResourcePreview resource={resource} controls={false} />
          ) : kind === "stack" && member?.type === "text" ? (
            <pre>
              {member.data.text ||
                member.data.prompt ||
                t("canvasNodes.stack.emptyText")}
            </pre>
          ) : (
            <div className="cw-domain-card-empty">
              <CanvasIcon name={kind} size={38} />
              <span>
                {kind === "timeline"
                  ? t("canvasNodes.stack.hint.text")
                  : kind === "stack"
                    ? t("canvasNodes.stack.hint.resource")
                    : t("canvasNodes.stack.hint.stage")}
              </span>
            </div>
          )}
        </div>
      )}
      {kind === "timeline" && (
        <div className="cw-card-timeline">
          <div className="cw-card-timeline-meta">
            <span>
              {timeline?.width ?? 1920} × {timeline?.height ?? 1080}
            </span>
            <span>
              {timeline ? timelineDuration(timeline).toFixed(1) : "0.0"}s ·{" "}
              {timeline?.fps ?? 30}fps
            </span>
          </div>
          {timeline?.tracks.slice(0, 3).map((track) => (
            <div className="cw-card-track" key={track.id}>
              <CanvasIcon
                name={track.kind === "audio" ? "audio" : "video"}
                size={11}
              />
              <span>
                {track.clips.length ? (
                  track.clips.slice(0, 10).map((clip) => (
                    <i
                      key={clip.id}
                      title={clip.resource.title}
                      style={{
                        flex: Math.max(
                          0.1,
                          (clip.outPoint - clip.inPoint) / clip.speed,
                        ),
                      }}
                    />
                  ))
                ) : (
                  <small>
                    {t(
                      track.kind === "audio"
                        ? "canvasNodes.stack.addAudio"
                        : "canvasNodes.stack.addClip",
                    )}
                  </small>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {kind === "stack" && (
        <div className="cw-card-stack-controls nodrag nopan">
          <TooltipButton
            label={t("canvasNodes.stack.previous")}
            disabled={!stack?.nodeIds.length}
            onClick={() => actions?.cycleStack(id, -1)}
          >
            ‹
          </TooltipButton>
          <span>
            {stack?.nodeIds.length ? stack.activeIndex + 1 : 0} /{" "}
            {stack?.nodeIds.length ?? 0}
            <small>
              {member?.data.title ?? t("canvasNodes.stack.none")}
            </small>
          </span>
          <TooltipButton
            label={t("canvasNodes.stack.next")}
            disabled={!stack?.nodeIds.length}
            onClick={() => actions?.cycleStack(id, 1)}
          >
            ›
          </TooltipButton>
        </div>
      )}
      {kind === "tool" && (
        <div className="cw-card-tool">
          <span>
            <CanvasIcon
              name={
                data.tool?.kind === "palette"
                  ? "palette"
                  : data.tool?.kind === "style"
                    ? "sparkle"
                    : "camera"
              }
              size={25}
            />
            {t(toolRoleKeys[data.tool?.kind ?? "camera"])}
          </span>
          {data.tool?.fields.length ? (
            data.tool.fields.slice(0, 4).map((field, index) => (
              <div key={index}>
                <small>{field.name}</small>
                <strong>{field.values.join(" · ")}</strong>
              </div>
            ))
          ) : (
            <p>{t("canvasNodes.tool.hint")}</p>
          )}
        </div>
      )}
      {kind === "external" && (
        <div className="cw-card-stage-summary">
          <span>{t("canvasNodes.external.title")}</span>
          {data.external?.current && (
            <small>
              {t("canvasNodes.external.version", {
                id: data.external.current.versionId,
              })}
            </small>
          )}
        </div>
      )}
      {kind !== "subject" && (
        <button
          className="cw-card-open nodrag nopan"
          onClick={() => actions?.edit(id)}
        >
          <CanvasIcon name="edit" size={13} />
          {kind === "timeline"
            ? t("canvasNodes.action.openTimeline")
            : kind === "stack"
              ? t("canvasNodes.action.manageStack")
              : kind === "tool"
                ? t("canvasNodes.action.editParams")
                : t("canvasNodes.action.openDirector")}
          <CanvasIcon name="chevronRight" size={13} />
        </button>
      )}
    </div>
  );
}

export default CanvasNodeView;
