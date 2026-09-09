import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Composer, type ComposerResult } from "../components/Composer";
import { RecentSessions } from "../components/RecentSessions";
import { useSessionContext } from "../context/SessionContext";
import { parseJoinURL } from "../lib/qr";

export function HomePage() {
  const navigate = useNavigate();
  const { createSession, enqueueFiles, device, error, isPending, reset } =
    useSessionContext();
  const joinId = useId();
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinLink, setJoinLink] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);

  async function handleShare(
    text: string,
    files: File[],
  ): Promise<ComposerResult> {
    const result = await createSession(
      text,
      device.deviceName,
      device.deviceId,
      files.length > 0,
    );
    if (!result.ok)
      return { textSent: false, accepted: [], errors: [result.error.message] };
    const queued = enqueueFiles(files);
    if (queued.errors.length) {
      reset();
      return { textSent: false, accepted: [], errors: queued.errors };
    }
    navigate("/waiting");
    return { textSent: true, ...queued };
  }

  function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const parsed = parseJoinURL(joinLink.trim());
      if (!parsed.sessionId || !parsed.sessionSecret)
        throw new Error("Missing session details");
      setJoinError(null);
      reset();
      navigate(
        `/j/${encodeURIComponent(parsed.sessionId)}#${parsed.sessionSecret}`,
      );
    } catch {
      setJoinError(
        "Paste the complete Kleepee join link, including everything after #.",
      );
    }
  }

  return (
    <main className="fade-in flex flex-1 flex-col justify-center gap-6 py-8 sm:py-12">
      <section className="space-y-4">
        <h1 className="max-w-[15ch] text-4xl font-medium leading-tight text-kleepee-espresso sm:text-5xl">
          From here to there.
        </h1>
        <p className="max-w-md text-base leading-7 text-kleepee-muted">
          Share text and small files between your devices. Private, encrypted,
          and simple.
        </p>
      </section>

      <Composer
        actionLabel="Create sharing link"
        pending={isPending}
        error={error?.message}
        onSubmit={handleShare}
      />
      <p className="-mt-3 text-sm leading-6 text-kleepee-muted">
        Create a link, then scan the QR code on your other device. Files start
        sending when you connect.
      </p>

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-kleepee-border" />
        <span className="text-xs text-kleepee-muted">Already have a link?</span>
        <span className="h-px flex-1 bg-kleepee-border" />
      </div>
      <button
        className="btn-secondary self-center gap-2"
        type="button"
        aria-expanded={joinOpen}
        aria-controls={joinId}
        disabled={isPending}
        onClick={() => {
          setJoinOpen((open) => !open);
          setJoinError(null);
        }}
      >
        <span aria-hidden="true" className="text-xl leading-none">
          +
        </span>{" "}
        Join session
      </button>

      {joinOpen && (
        <section className="panel" id={joinId}>
          <form className="flex flex-col gap-3" onSubmit={handleJoin}>
            <label
              className="text-sm font-medium text-kleepee-espresso"
              htmlFor={`${joinId}-input`}
            >
              Session link
            </label>
            <input
              id={`${joinId}-input`}
              className="input-field min-h-0"
              value={joinLink}
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Paste the full Kleepee link…"
              aria-invalid={Boolean(joinError)}
              aria-describedby={joinError ? `${joinId}-error` : undefined}
              onChange={(event) => {
                setJoinLink(event.target.value);
                setJoinError(null);
              }}
            />
            {joinError && (
              <p
                id={`${joinId}-error`}
                className="text-sm text-kleepee-danger"
                role="alert"
              >
                {joinError}
              </p>
            )}
            <button
              className="btn-primary self-end"
              type="submit"
              disabled={!joinLink.trim() || isPending}
            >
              Join
            </button>
          </form>
        </section>
      )}
      <RecentSessions onResume={() => reset()} />
    </main>
  );
}
