import type { InAppToast } from "../hooks/useNotifications";

interface MessageToastProps {
  toast: InAppToast;
  onDismiss: () => void;
}

export function MessageToast({ toast, onDismiss }: MessageToastProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed bottom-5 left-1/2 z-50 flex w-[calc(100vw-2.5rem)] max-w-sm -translate-x-1/2 items-start gap-3 rounded-2xl border border-kleepee-border bg-kleepee-espresso px-4 py-3 shadow-lg"
      style={{ animation: "fade-in 180ms ease-out" }}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-white/70">{toast.senderName}</p>
        <p className="truncate text-sm text-white">{toast.preview}</p>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="mt-0.5 shrink-0 text-white/50 hover:text-white focus:outline-none"
        onClick={onDismiss}
      >
        ✕
      </button>
    </div>
  );
}
