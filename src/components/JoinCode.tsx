import { useEffect, useRef, useState } from "react";
import { copyToClipboard } from "../lib/clipboard";
import { answerJoinRequest, inspectJoinRequest, pollJoinRequest, publishJoinCode, type JoinCodeOwner, type JoinRequest } from "../lib/joinCode";

export function JoinCode({ sessionId, sessionSecret }: { sessionId: string; sessionSecret: string }) {
  const [owner, setOwner] = useState<JoinCodeOwner | null>(null);
  const [incoming, setIncoming] = useState<{ request: JoinRequest; verification: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);
  const controller = useRef<AbortController | null>(null);
  const creating = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!owner || !controller.current) return;
    const signal = controller.current.signal;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      setNow(Date.now());
      if (Date.now() >= owner!.expiresAt) { setIncoming(null); return; }
      try {
        const request = await pollJoinRequest(owner!, signal);
        const next = request?.status === "pending" ? { request, ...(await inspectJoinRequest(owner!, request)) } : null;
        if (!stopped && !signal.aborted) { setIncoming(next); setError(null); }
      } catch (failure) {
        if (!stopped && !signal.aborted) setError(failure instanceof Error ? failure.message : "Could not check join requests.");
      }
      if (!stopped && !signal.aborted) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [owner]);

  async function create() {
    if (creating.current) return;
    creating.current = true;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true); setError(null); setOwner(null); setIncoming(null); setCopied(false);
    try {
      const code = await publishJoinCode(next.signal);
      if (!next.signal.aborted) { setOwner(code); setNow(Date.now()); }
    } catch (failure) {
      if (!next.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not create a code.");
    } finally {
      creating.current = false;
      if (!next.signal.aborted) setBusy(false);
    }
  }
  async function answer(approve: boolean) {
    if (!owner || !incoming || busy || !controller.current) return;
    const signal = controller.current.signal;
    setBusy(true); setError(null);
    try {
      await answerJoinRequest(owner, incoming.request, sessionId, sessionSecret, approve, signal);
      if (!signal.aborted) setIncoming(null);
    } catch (failure) {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : "Could not answer this request.");
    } finally { if (!signal.aborted) setBusy(false); }
  }
  const expired = owner && now >= owner.expiresAt;
  return (
    <div className="rounded-[18px] border border-kleepee-border bg-kleepee-panel p-4 text-center">
      <p className="text-sm text-kleepee-muted">Prefer to type a code?</p>
      {owner && !expired ? <>
        <p className="my-3 select-all font-mono text-3xl font-medium tracking-[0.25em] text-kleepee-espresso" aria-label="Join code">{owner.code}</p>
        <p className="mb-3 text-xs text-kleepee-muted">Expires in {Math.max(1, Math.ceil((owner.expiresAt - now) / 60_000))} min. Keep this screen open to approve the other device.</p>
        <button className="btn-secondary" type="button" onClick={() => {
          void copyToClipboard(owner.code).then(() => setCopied(true)).catch(() => setError("Copy failed — select the code manually."));
        }}>{copied ? "Copied!" : "Copy code"}</button>
      </> : <button className="btn-secondary mt-3" type="button" disabled={busy} onClick={() => void create()}>
        {busy ? "Creating code…" : expired ? "Code expired — create another" : "Get a 4-character code"}
      </button>}
      {incoming && !expired && <div className="mt-4 space-y-3 rounded-[18px] border border-kleepee-border bg-kleepee-surface p-4" role="status">
        <p className="break-words text-sm font-medium">{incoming.request.deviceName} wants to join</p>
        <p className="font-mono text-xl tracking-widest">{incoming.verification}</p>
        <p className="text-sm text-kleepee-muted">Only approve if this verification number matches the number on your other device.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <button className="btn-primary" type="button" disabled={busy} onClick={() => void answer(true)}>Numbers match — approve</button>
          <button className="btn-secondary" type="button" disabled={busy} onClick={() => void answer(false)}>Decline</button>
        </div>
      </div>}
      {error && <p className="mt-3 text-sm text-kleepee-danger" role="alert">{error}</p>}
    </div>
  );
}
