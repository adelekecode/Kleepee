import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { StatusBar } from "../components/StatusBar";
import { TextFeed } from "../components/TextFeed";
import { Composer, type ComposerResult } from "../components/Composer";
import { MessageToast } from "../components/MessageToast";
import { useSessionContext } from "../context/SessionContext";
import { useNotifications } from "../hooks/useNotifications";
import { useTransferWakeLock } from "../hooks/useTransferWakeLock";
import type { FeedItem } from "../types";

export function ConnectedPage() {
  const navigate = useNavigate();
  const {
    state,
    role,
    sessionId,
    peerDeviceName,
    items,
    error,
    dataChannelState,
    retryAttempt,
    maxRetries,
    terminalReason,
    device,
    sendText,
    disconnect,
    reset,
    fileTransfers,
    fileItems,
    enqueueFiles,
    retryFile,
    cancelFile,
  } = useSessionContext();

  const {
    permission,
    soundEnabled,
    systemSupported,
    toast,
    requestPermission,
    notify,
    dismissToast,
    toggleSound,
    unlockAudio,
  } = useNotifications();

  const prevItemCountRef = useRef(items.length + fileItems.length);
  const [dropError, setDropError] = useState<string | null>(null);
  const liveTransfers = [...fileTransfers.values()];
  const transferring = liveTransfers.some(
    (transfer) =>
      transfer.status === "sending" || transfer.status === "receiving",
  );
  const pausedTransfers = liveTransfers.some(
    (transfer) => transfer.status === "paused",
  );
  useTransferWakeLock(transferring);

  // Notify on new incoming items (text or file)
  useEffect(() => {
    const total = items.length + fileItems.length;
    if (total > prevItemCountRef.current) {
      const latestText = items[items.length - 1];
      const latestFile = fileItems[fileItems.length - 1];
      // Pick whichever is more recent
      const latest =
        latestFile &&
        (!latestText || latestFile.timestamp >= latestText.timestamp)
          ? latestFile
          : latestText;
      if (latest) {
        const preview =
          latest.type === "text" ? latest.content : `📎 ${latest.fileName}`;
        // Reuse notify by adapting to its TextItem-like signature
        notify(
          {
            ...latest,
            type: "text",
            content: preview,
            id: latest.id,
          } as Parameters<typeof notify>[0],
          device.deviceId,
        );
      }
    }
    prevItemCountRef.current = items.length + fileItems.length;
  }, [items, fileItems, device.deviceId, notify]);

  useEffect(() => {
    if (state === "EXPIRED") navigate("/expired", { replace: true });
  }, [navigate, state]);

  if (!sessionId) return <Navigate to="/" replace />;
  if (state === "WAITING" && role === "initiator")
    return <Navigate to="/waiting" replace />;

  const canSend = state === "CONNECTED" && dataChannelState === "open";
  const ended = state === "DISCONNECTED" && terminalReason === "manual";
  const exhausted =
    state === "DISCONNECTED" && terminalReason === "retries_exhausted";

  async function handleSubmit(
    text: string,
    files: File[],
  ): Promise<ComposerResult> {
    unlockAudio();
    setDropError(null);
    if (!canSend)
      return {
        textSent: false,
        accepted: [],
        errors: ["Wait for the connection before sending."],
      };
    const queued = enqueueFiles(files);
    if (!text.trim()) return { textSent: false, ...queued };
    const result = await sendText(text, device.deviceName, device.deviceId);
    return {
      textSent: result.ok,
      accepted: queued.accepted,
      errors: [...queued.errors, ...(!result.ok ? [result.error.message] : [])],
    };
  }

  function createNewSession() {
    reset();
    navigate("/", { replace: true });
  }

  function openNewSession() {
    window.open("/", "_blank", "noopener,noreferrer");
  }

  // Merge text items and file items into a single sorted feed
  const feedItems: FeedItem[] = [...items, ...fileItems].sort(
    (a, b) => a.timestamp - b.timestamp,
  );

  return (
    <main className="fade-in flex min-h-0 flex-1 flex-col gap-4 pb-2">
      {toast && <MessageToast toast={toast} onDismiss={dismissToast} />}

      <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <StatusBar
          state={state}
          dataChannelState={dataChannelState}
          peerDeviceName={peerDeviceName}
          retryAttempt={retryAttempt}
          maxRetries={maxRetries}
          terminalReason={terminalReason}
        />

        {ended || exhausted ? (
          <button
            className="btn-primary"
            type="button"
            onClick={createNewSession}
          >
            Create new session
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-secondary"
              type="button"
              title={soundEnabled ? "Mute sounds" : "Unmute sounds"}
              aria-label={
                soundEnabled
                  ? "Mute notification sounds"
                  : "Unmute notification sounds"
              }
              onClick={() => {
                unlockAudio();
                toggleSound();
              }}
            >
              {soundEnabled ? "🔔" : "🔕"}
            </button>
            {systemSupported && permission === "default" && (
              <button
                className="btn-secondary"
                type="button"
                onClick={requestPermission}
              >
                Enable notifications
              </button>
            )}
            <button
              className="btn-secondary"
              type="button"
              onClick={openNewSession}
            >
              New session
            </button>
            <button className="btn-danger" type="button" onClick={disconnect}>
              End session
            </button>
          </div>
        )}
      </section>

      <TextFeed
        items={feedItems}
        transfers={fileTransfers}
        onCancelTransfer={cancelFile}
        onRetryTransfer={canSend ? retryFile : undefined}
        onDropFiles={(files) => {
          if (!canSend) {
            setDropError("Wait for the connection before dropping files.");
            return;
          }
          const result = enqueueFiles(files);
          setDropError(result.errors.length ? result.errors.join(" ") : null);
        }}
      />

      {(transferring || pausedTransfers) && (
        <p className="text-xs leading-5 text-kleepee-muted">
          Transfers continue while your browser allows it. If your device pauses
          this tab, return here to reconnect and continue. Keep both tabs open.
        </p>
      )}

      <Composer
        disabled={!canSend}
        error={dropError ?? error?.message}
        onSubmit={handleSubmit}
      />
    </main>
  );
}
