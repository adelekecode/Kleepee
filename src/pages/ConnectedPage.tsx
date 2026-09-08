import { useEffect, useRef } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { StatusBar } from "../components/StatusBar";
import { TextFeed } from "../components/TextFeed";
import { TextInput } from "../components/TextInput";
import { useSessionContext } from "../context/SessionContext";
import { useNotifications } from "../hooks/useNotifications";

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
  } = useSessionContext();

  const { permission, soundEnabled, requestPermission, notify, toggleSound } = useNotifications();
  const prevItemCountRef = useRef(items.length);

  // Fire notification whenever a new item arrives
  useEffect(() => {
    if (items.length > prevItemCountRef.current) {
      const latest = items[items.length - 1];
      notify(latest, device.deviceId);
    }
    prevItemCountRef.current = items.length;
  }, [items, device.deviceId, notify]);

  useEffect(() => {
    if (state === "EXPIRED") {
      navigate("/expired", { replace: true });
    }
  }, [navigate, state]);

  if (!sessionId) {
    return <Navigate to="/" replace />;
  }

  if (state === "WAITING" && role === "initiator") {
    return <Navigate to="/waiting" replace />;
  }

  const canSend = state === "CONNECTED" && dataChannelState === "open";
  const ended = state === "DISCONNECTED" && terminalReason === "manual";
  const exhausted = state === "DISCONNECTED" && terminalReason === "retries_exhausted";

  async function handleSend(text: string) {
    const result = await sendText(text, device.deviceName, device.deviceId);
    return result.ok;
  }

  function createNewSession() {
    reset();
    navigate("/", { replace: true });
  }

  function openNewSession() {
    window.open("/", "_blank", "noopener,noreferrer");
  }

  return (
    <main className="fade-in flex min-h-0 flex-1 flex-col gap-4 pb-2">
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
          <button className="btn-primary" type="button" onClick={createNewSession}>
            Create new session
          </button>
        ) : (
          <div className="flex flex-wrap gap-2">
            {/* Notification controls */}
            {permission !== "denied" && (
              <button
                className="btn-secondary"
                type="button"
                title={soundEnabled ? "Mute sounds" : "Unmute sounds"}
                aria-label={soundEnabled ? "Mute notification sounds" : "Unmute notification sounds"}
                onClick={toggleSound}
              >
                {soundEnabled ? "🔔" : "🔕"}
              </button>
            )}
            {permission === "default" && (
              <button className="btn-secondary" type="button" onClick={requestPermission}>
                Enable notifications
              </button>
            )}
            <button className="btn-secondary" type="button" onClick={openNewSession}>
              New session
            </button>
            <button className="btn-danger" type="button" onClick={disconnect}>
              End session
            </button>
          </div>
        )}
      </section>

      <TextFeed items={items} />

      <section className="panel">
        <TextInput
          label="Message"
          placeholder={canSend ? "Paste or type something..." : "Session ended"}
          actionLabel="Send"
          disabled={!canSend}
          minRows={3}
          error={error?.message}
          onSubmit={handleSend}
        />
      </section>
    </main>
  );
}
