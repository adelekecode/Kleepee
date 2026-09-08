import type { SessionState } from "../types";
import type { TerminalDisconnectReason } from "../hooks/useSession";

interface StatusBarProps {
  state: SessionState;
  peerDeviceName: string | null;
  onNewSession?: () => void;
  // Extended props used by ConnectedPage for richer status detail
  dataChannelState?: RTCDataChannelState | null;
  retryAttempt?: number;
  maxRetries?: number | null;
  terminalReason?: TerminalDisconnectReason;
}

function SpinnerDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-label="Loading" role="status">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
    </span>
  );
}

export function StatusBar({
  state,
  peerDeviceName,
  onNewSession,
  dataChannelState,
  retryAttempt = 0,
  maxRetries = null,
  terminalReason = null,
}: StatusBarProps) {
  // CONNECTED indicator only when DataChannel is open (Req 8.5).
  // When dataChannelState is not provided, fall back to trusting state === "CONNECTED".
  const isConnected =
    state === "CONNECTED" &&
    (dataChannelState === undefined || dataChannelState === null || dataChannelState === "open");

  const isEnded =
    state === "EXPIRED" ||
    (state === "DISCONNECTED" && terminalReason === "retries_exhausted") ||
    (state === "DISCONNECTED" && terminalReason === "manual");

  const isReconnecting =
    state === "DISCONNECTED" && !isEnded;

  const tone = isConnected
    ? "border-kleepee-green/25 bg-kleepee-green/10 text-kleepee-green"
    : isEnded
      ? "border-kleepee-danger/25 bg-kleepee-danger/10 text-kleepee-danger"
      : isReconnecting
        ? "border-kleepee-warning/25 bg-kleepee-warning/10 text-kleepee-warning"
        : "border-kleepee-border bg-kleepee-panel text-kleepee-muted";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`inline-flex min-h-10 items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium ${tone}`}
    >
      {isConnected ? (
        <>
          {/* Visually distinct green dot for CONNECTED (Req 8.1) */}
          <span
            className="h-2.5 w-2.5 rounded-full bg-kleepee-green shadow-[0_0_0_2px_rgba(77,124,91,0.25)]"
            aria-hidden="true"
          />
          <span>Connected to {peerDeviceName ?? "your other device"}</span>
        </>
      ) : isEnded ? (
        <>
          <span className="h-2 w-2 rounded-full bg-current opacity-55" aria-hidden="true" />
          <span>
            Connection ended.{" "}
            {onNewSession ? (
              <button
                type="button"
                onClick={onNewSession}
                className="underline underline-offset-2 hover:no-underline focus:outline-none focus:ring-2 focus:ring-current focus:ring-offset-1 rounded-sm"
              >
                CREATE NEW SESSION
              </button>
            ) : (
              <span>CREATE NEW SESSION</span>
            )}
          </span>
        </>
      ) : isReconnecting ? (
        <>
          <SpinnerDots />
          <span>
            Connection lost. Reconnecting
            {retryAttempt > 0 ? maxRetries ? ` (${retryAttempt}/${maxRetries})` : ` (${retryAttempt})` : ""}
            ...
          </span>
        </>
      ) : (
        <>
          {/* CONNECTING or WAITING: activity indicator */}
          <SpinnerDots />
          <span>
            {state === "WAITING" ? "Waiting for another device" : "Connecting"}
          </span>
        </>
      )}
    </div>
  );
}
