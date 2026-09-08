import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { TextInput } from "../components/TextInput";
import { useSessionContext } from "../context/SessionContext";
import { parseJoinURL } from "../lib/qr";

export function HomePage() {
  const navigate = useNavigate();
  const { createSession, device, error, isPending, reset } = useSessionContext();
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinLink, setJoinLink] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);

  async function handleShare(text: string) {
    const result = await createSession(text, device.deviceName, device.deviceId);

    if (result.ok) {
      navigate("/waiting");
    }

    return result.ok;
  }

  function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      const parsed = parseJoinURL(joinLink.trim());

      if (!parsed.sessionId || !parsed.sessionSecret) {
        throw new Error("Missing session details");
      }

      setJoinError(null);
      navigate(`/j/${encodeURIComponent(parsed.sessionId)}#${parsed.sessionSecret}`);
    } catch {
      setJoinError("Paste a valid Kleepee join link.");
    }
  }

  return (
    <main className="fade-in flex flex-1 flex-col justify-center gap-6 py-8">
      <section className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <p className="text-sm font-medium text-kleepee-accent">Kleepee</p>
          <h1 className="max-w-[12ch] text-4xl font-semibold leading-tight text-kleepee-espresso sm:text-5xl">
            Text, from here to there.
          </h1>
          <p className="max-w-md text-base leading-7 text-kleepee-muted">
            Private, encrypted sharing between two devices.
          </p>
        </div>

        <button
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-kleepee-border bg-kleepee-surface text-2xl leading-none text-kleepee-espresso shadow-sm transition hover:bg-kleepee-panel focus:outline-none focus:ring-2 focus:ring-kleepee-focus focus:ring-offset-2 focus:ring-offset-kleepee-bg"
          type="button"
          aria-label="Join a session"
          title="Join a session"
          onClick={() => {
            setJoinOpen((open) => !open);
            setJoinError(null);
          }}
        >
          +
        </button>
      </section>

      {joinOpen && (
        <section className="panel">
          <form className="flex flex-col gap-3" onSubmit={handleJoin}>
            <label className="text-sm font-medium text-kleepee-espresso" htmlFor="join-link">
              Join session
            </label>
            <input
              id="join-link"
              className="input-field min-h-0"
              value={joinLink}
              placeholder="Paste a Kleepee link..."
              onChange={(event) => {
                setJoinLink(event.target.value);
                if (joinError) setJoinError(null);
              }}
            />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="min-h-5 text-sm text-kleepee-danger">{joinError}</p>
              <button className="btn-primary w-full sm:w-auto" type="submit">
                Join
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="panel">
        <TextInput
          label="Text to share"
          placeholder="Paste or type something..."
          actionLabel="Share text"
          pending={isPending}
          error={error?.message}
          onSubmit={handleShare}
        />
      </section>

      {error && (
        <button className="self-start text-sm font-medium text-kleepee-muted underline-offset-4 hover:underline" type="button" onClick={reset}>
          Start over
        </button>
      )}
    </main>
  );
}
