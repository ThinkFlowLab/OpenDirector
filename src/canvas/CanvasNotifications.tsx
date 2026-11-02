import { useCallback, useEffect, useRef, useState } from "react";
import { CanvasIcon } from "./CanvasIcon";

interface CanvasNotification {
  id: number;
  message: string;
}

export function useCanvasNotifications() {
  const [notifications, setNotifications] = useState<CanvasNotification[]>([]);
  const sequence = useRef(0);
  const notify = useCallback((message: string) => {
    if (!message) return;
    const notification = { id: ++sequence.current, message };
    setNotifications((current) => [...current, notification]);
  }, []);
  const dismiss = useCallback((id: number) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);
  return { notifications, notify, dismiss };
}

function Notification({
  notification,
  onDismiss,
}: {
  notification: CanvasNotification;
  onDismiss: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [exiting, setExiting] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(
    Math.max(3800, Math.min(8000, notification.message.length * 100)),
  );

  useEffect(() => {
    if (paused || exiting) return;
    const started = Date.now();
    const timer = setTimeout(() => setExiting(true), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - started),
      );
    };
  }, [paused, exiting]);

  useEffect(() => {
    if (!exiting) return;
    // Keep the item mounted until its 240 ms layout collapse has finished.
    const timer = setTimeout(() => onDismiss(notification.id), 260);
    return () => clearTimeout(timer);
  }, [exiting, notification.id, onDismiss]);

  return (
    <div className={`cw-toast-slot${exiting ? " cw-toast-slot-exiting" : ""}`}>
      <div className="cw-toast-clip">
        <div
          className={`cw-toast${exiting ? " cw-toast-exiting" : ""}`}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setFocused(false);
          }}
        >
          <span role="status" aria-atomic="true">
            {notification.message}
          </span>
          <button
            type="button"
            className="cw-toast-close"
            aria-label="关闭提示"
            onClick={() => setExiting(true)}
          >
            <CanvasIcon name="close" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function CanvasNotifications({
  notifications,
  onDismiss,
}: {
  notifications: CanvasNotification[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="cw-toast-stack" aria-label="画布提示">
      {notifications.map((notification) => (
        <Notification
          key={notification.id}
          notification={notification}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
