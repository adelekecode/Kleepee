import { useEffect, useMemo } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { QRCode } from "../components/QRCode";
import { StatusBar } from "../components/StatusBar";
import { buildJoinURL } from "../lib/qr";
import { useSessionContext } from "../context/SessionContext";

export function WaitingPage() {
  const navigate = useNavigate();
  const {
    sessionId,
    sessionSecret,
    state,
    initialText,
    reset,
    peerDeviceName,
    dataChannelState,
    retryAttempt,
    maxRetries,
    terminalReason,
  } = useSessionContext();
  const joinUrl = useMemo(() => {
    if (!sessionId || !sessionSecret) return "";
    return buildJoinURL(sessionId, sessionSecret);
  }, [sessionId, sessionSecret]);

  useEffect(() => {
    if (state === "CONNECTED") {
      navigate("/connected", { replace: true });
    }

    if (state === "EXPIRED") {
      navigate("/expired", { replace: true });
    }
  }, [navigate, state]);

  if (!sessionId || !sessionSecret) {
    return <Navigate to="/" replace />;
  }

  function cancelSession() {
    reset();
    navigate("/", { replace: true });
  }

  return (
    <main className="fade-in flex flex-1 flex-col justify-center py-6">
      <section className="panel flex flex-col gap-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-kleepee-espresso">Waiting for another device...</h1>
          <p className="mx-auto max-w-sm text-sm leading-6 text-kleepee-muted">
            Scan this code with the other device camera.
          </p>
        </div>

        {(state === "CONNECTING" || state === "DISCONNECTED") && (
          <div className="flex justify-center">
            <StatusBar
              state={state}
              peerDeviceName={peerDeviceName}
              dataChannelState={dataChannelState}
              retryAttempt={retryAttempt}
              maxRetries={maxRetries}
              terminalReason={terminalReason}
            />
          </div>
        )}

        <QRCode url={joinUrl} />

        {initialText && (
          <div className="rounded-[18px] border border-kleepee-border bg-kleepee-panel p-4 text-left">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-kleepee-muted">Preview</p>
            <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-6 text-kleepee-espresso">
              {initialText}
            </p>
          </div>
        )}

        <button className="btn-danger self-center" type="button" onClick={cancelSession}>
          Cancel
        </button>
      </section>
    </main>
  );
}
