import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import type { SessionError } from "../hooks/useSession";
import { useSessionContext } from "../context/SessionContext";

const SESSION_ID_PATTERN = /^[A-Za-z0-9]+$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;

export function JoinPage() {
  const navigate = useNavigate();
  const { sessionId = "" } = useParams();
  const { device, joinSession, state, reset, error } = useSessionContext();
  const [joinError, setJoinError] = useState<SessionError | null>(null);
  const joinSessionRef = useRef(joinSession);
  joinSessionRef.current = joinSession;
  const sessionSecret = useLocation().hash.slice(1);

  const invalidLink =
    !sessionId ||
    !sessionSecret ||
    !SESSION_ID_PATTERN.test(sessionId) ||
    !SECRET_PATTERN.test(sessionSecret);

  useEffect(() => {
    if (invalidLink) return;

    let active = true;
    setJoinError(null);
    void joinSessionRef.current(sessionId, sessionSecret, device.deviceName, device.deviceId).then((result) => {
      if (active && !result.ok) {
        setJoinError(result.error);
      }
    });
    return () => { active = false; };
  }, [device.deviceId, device.deviceName, invalidLink, sessionId, sessionSecret]);

  useEffect(() => {
    if (state === "CONNECTED") {
      navigate("/connected", { replace: true });
    }

    if (state === "EXPIRED" || joinError?.code === "session_expired") {
      navigate("/expired", { replace: true });
    }
  }, [joinError?.code, navigate, state]);

  if (invalidLink) {
    return <JoinErrorScreen message="This link is not valid." onReset={() => {
      reset();
      navigate("/", { replace: true });
    }} />;
  }

  if (joinError || error) {
    const activeError = joinError || error;
    return <JoinErrorScreen message={activeError?.message || "Could not connect to this session."} onReset={() => {
      reset();
      navigate("/", { replace: true });
    }} />;
  }

  if (state === "CONNECTED") {
    return <Navigate to="/connected" replace />;
  }

  return (
    <main className="fade-in flex flex-1 flex-col justify-center py-8">
      <section className="panel flex min-h-[320px] flex-col items-center justify-center gap-4 text-center">
        <div className="spinner" />
        <h1 className="text-2xl font-semibold text-kleepee-espresso">Connecting securely...</h1>
        <p className="max-w-sm text-sm leading-6 text-kleepee-muted">
          Keep this tab open while Kleepee links both devices.
        </p>
      </section>
    </main>
  );
}

function JoinErrorScreen({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <main className="fade-in flex flex-1 flex-col justify-center py-8">
      <section className="panel flex min-h-[320px] flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm font-medium text-kleepee-danger">Connection failed</p>
        <h1 className="text-2xl font-semibold text-kleepee-espresso">{message}</h1>
        <button className="btn-primary mt-2" type="button" onClick={onReset}>
          Start new session
        </button>
      </section>
    </main>
  );
}
