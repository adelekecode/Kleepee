import { useNavigate } from "react-router-dom";
import { TextInput } from "../components/TextInput";
import { useSessionContext } from "../context/SessionContext";

export function HomePage() {
  const navigate = useNavigate();
  const { createSession, device, error, isPending, reset } = useSessionContext();

  async function handleShare(text: string) {
    const result = await createSession(text, device.deviceName, device.deviceId);

    if (result.ok) {
      navigate("/waiting");
    }

    return result.ok;
  }

  return (
    <main className="fade-in flex flex-1 flex-col justify-center gap-6 py-8">
      <section className="space-y-3">
        <p className="text-sm font-medium text-kleepee-accent">Kleepee</p>
        <h1 className="max-w-[12ch] text-4xl font-semibold leading-tight text-kleepee-espresso sm:text-5xl">
          Text, from here to there.
        </h1>
        <p className="max-w-md text-base leading-7 text-kleepee-muted">
          Private, encrypted sharing between two devices.
        </p>
      </section>

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
