import { useNavigate } from "react-router-dom";
import { useSessionContext } from "../context/SessionContext";

export function ExpiredPage() {
  const navigate = useNavigate();
  const { reset } = useSessionContext();

  function startNewSession() {
    reset();
    navigate("/", { replace: true });
  }

  return (
    <main className="fade-in flex flex-1 flex-col justify-center py-8">
      <section className="panel flex min-h-[320px] flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm font-medium text-kleepee-danger">
          Session expired
        </p>
        <h1 className="text-2xl font-semibold text-kleepee-espresso">
          This session has expired.
        </h1>
        <button
          className="btn-primary mt-2"
          type="button"
          onClick={startNewSession}
        >
          Start new session
        </button>
      </section>
    </main>
  );
}
