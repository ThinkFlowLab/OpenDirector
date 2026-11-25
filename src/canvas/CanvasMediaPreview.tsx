import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { VideoControls } from "./CanvasVideoControls";
import { useAssetMedia } from "./useAssetMedia.tsx";

/** Milliseconds a pointer must rest on a node before preview playback starts. */
const HOVER_PLAY_DELAY_MS = 300;

const Playback = createContext<{
  blocked: boolean;
  claim: (element: HTMLMediaElement) => void;
}>({ blocked: false, claim: () => {} });

export function useCanvasPlayback() {
  return useContext(Playback);
}
export function CanvasPlaybackProvider({
  blocked,
  children,
}: {
  blocked: boolean;
  children: ReactNode;
}) {
  const [visible, setVisible] = useState(() => !document.hidden);
  const owner = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      owner.current?.pause();
    };
  }, []);
  useEffect(() => {
    if (blocked || !visible) owner.current?.pause();
  }, [blocked, visible]);
  // A new context object on every render would restart each preview's play
  // effect (pausing, then re-arming the hover delay). Keep the identity stable
  // so an unrelated workspace re-render cannot interrupt playback.
  const claim = useCallback((element: HTMLMediaElement) => {
    if (owner.current && owner.current !== element) owner.current.pause();
    owner.current = element;
  }, []);
  const value = useMemo(
    () => ({ blocked: blocked || !visible, claim }),
    [blocked, visible, claim],
  );
  return <Playback.Provider value={value}>{children}</Playback.Provider>;
}

export type CanvasVideoPreviewProps = ComponentProps<"video"> & {
  /** Mirrors React Flow's selection flag so controls stay visible when selected. */
  selected?: boolean;
};

/**
 * A canvas video thumbnail that previews on hover and exposes playback controls.
 *
 * Interaction contract:
 * - Hovering starts muted playback after a short delay; leaving pauses and keeps
 *   the position. A finished video rewinds so the next hover replays it.
 * - Node selection, long press, context menu and node dragging never interrupt
 *   playback. Only real interruptions (dialogs, panning) block it.
 * - Controls appear while hovered or selected and never leak gestures to the
 *   canvas, so scrubbing does not move the node.
 */
export function CanvasVideoPreview({
  selected = false,
  ...props
}: CanvasVideoPreviewProps) {
  const playback = useContext(Playback);
  const resolved = useAssetMedia(props.src);
  const element = useRef<HTMLVideoElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  // Mirrors `ended` so the effect can decide whether a hover should trigger play.
  const ended = useRef(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const previousSrc = useRef(props.src);

  const controlsVisible = hovered || selected;

  // Reset per-source state so a regenerated clip starts from a clean slate.
  useEffect(() => {
    if (previousSrc.current === props.src) return;
    previousSrc.current = props.src;
    ended.current = false;
    setHovered(false);
    setUserPaused(false);
    setCurrentTime(0);
    setDuration(0);
  }, [props.src]);

  const pause = useCallback(() => {
    element.current?.pause();
  }, []);

  // Drive hover playback. Blocked or finished media is paused; a hover always
  // restarts playback from the beginning when the previous run ended.
  useEffect(() => {
    const media = element.current;
    if (!media) return;
    if (!hovered || playback.blocked || userPaused) {
      pause();
      return;
    }
    if (ended.current) {
      ended.current = false;
      media.currentTime = 0;
      setCurrentTime(0);
    }
    let active = true;
    const timer = setTimeout(() => {
      // Always play at full volume so the loudness matches the system output.
      media.volume = 1;
      playback.claim(media);
      void media
        .play()
        .then(() => {
          if (!active) media.pause();
        })
        .catch(() => {
          // The browser refused audible autoplay because the page has no user
          // activation yet. Retry muted so the visual preview still plays; the
          // mute button reflects that the sound is off.
          if (!active) return;
          media.muted = true;
          setMuted(true);
          void media.play().catch(() => {});
        });
    }, HOVER_PLAY_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
      media.pause();
    };
  }, [hovered, playback, userPaused, pause]);

  // Paint the progress bar on rAF: `timeupdate` only fires around 4Hz, which
  // looks jumpy while the video plays.
  useEffect(() => {
    const media = element.current;
    if (!media || !playing) return;
    let frame = 0;
    const tick = () => {
      setCurrentTime(media.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // Track fullscreen transitions triggered by any means, including Escape.
  useEffect(() => {
    const media = element.current;
    if (!media) return;
    const sync = () => setFullscreen(document.fullscreenElement === media);
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      media.pause();
    };
  }, []);

  const togglePlay = () => {
    const media = element.current;
    if (!media) return;
    if (media.paused) {
      if (ended.current) {
        media.currentTime = 0;
        ended.current = false;
      }
      setUserPaused(false);
      setHovered(true);
      playback.claim(media);
      media.muted = muted;
      void media.play().catch(() => {});
    } else {
      setUserPaused(true);
      media.pause();
    }
  };

  const seek = (time: number) => {
    const media = element.current;
    if (!media) return;
    media.currentTime = time;
    setCurrentTime(time);
    if (ended.current && time < media.duration) {
      ended.current = false;
      setUserPaused(true);
    }
  };

  const toggleMute = () => {
    const media = element.current;
    const next = !muted;
    setMuted(next);
    if (!media) return;
    media.muted = next;
    // Unmuting is a user gesture, so audible playback may resume right away.
    if (next === false && media.paused && hovered && !userPaused && !playback.blocked) {
      setUserPaused(false);
      playback.claim(media);
      void media.play().catch(() => {});
    }
  };

  const toggleFullscreen = () => {
    const media = element.current;
    if (!media) return;
    if (document.fullscreenElement === media) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    void media
      .requestFullscreen()
      .then(() => {
        media.muted = muted;
        void media.play().catch(() => {});
      })
      .catch(() => {
        // Fullscreen was refused; keep inline playback rather than failing.
      });
  };

  return (
    <div
      ref={wrapper}
      className={`cw-video-frame${controlsVisible ? " is-controls-visible" : ""}`}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setHovered(true);
      }}
      onPointerLeave={(event) => {
        // Dragging the node keeps the pointer captured, so a leave only matters
        // when the node itself is no longer hovered.
        if (element.current?.parentElement?.contains(event.relatedTarget as Node)) {
          return;
        }
        setHovered(false);
        setUserPaused(false);
      }}
    >
      <video
        {...props}
        src={resolved.src}
        ref={element}
        className={`${props.className ?? ""}${fullscreen ? " is-fullscreen" : ""}`.trim()}
        muted={muted}
        onClick={(event) => {
          event.stopPropagation();
          props.onClick?.(event);
        }}
        onPlay={(event) => {
          if (playback.blocked) {
            event.currentTarget.pause();
            return;
          }
          ended.current = false;
          setPlaying(true);
          playback.claim(event.currentTarget);
          props.onPlay?.(event);
        }}
        onPause={(event) => {
          setPlaying(false);
          props.onPause?.(event);
        }}
        onEnded={(event) => {
          ended.current = true;
          setPlaying(false);
          setCurrentTime(event.currentTarget.duration || 0);
          props.onEnded?.(event);
        }}
        onDurationChange={(event) => {
          setDuration(event.currentTarget.duration || 0);
          props.onDurationChange?.(event);
        }}
        onVolumeChange={(event) => {
          // Volume is never attenuated here: the clip plays at 100% and the
          // system volume decides how loud it is. Only mute is user-controlled.
          if (event.currentTarget.volume !== 1) event.currentTarget.volume = 1;
          setMuted(event.currentTarget.muted);
          props.onVolumeChange?.(event);
        }}
        onSeeked={(event) => {
          setCurrentTime(event.currentTarget.currentTime);
          props.onSeeked?.(event);
        }}
      />
      {controlsVisible && (
        <VideoControls
          media={element.current}
          playing={playing}
          duration={duration}
          currentTime={currentTime}
          muted={muted}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onToggleMute={toggleMute}
          onToggleFullscreen={toggleFullscreen}
          fullscreen={fullscreen}
        />
      )}
    </div>
  );
}
