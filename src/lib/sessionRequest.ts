import { backgroundTimeout } from "./backgroundTimeout";

/** Bound setup requests, including reading their body, and cancel them on reset. */
export async function sessionRequest(url: string, init: RequestInit, signal: AbortSignal) {
  const controller = new AbortController();
  let cancelDeadline = () => {};
  let rejectAbort: (error: Error) => void = () => {};
  const abort = () => {
    controller.abort();
    rejectAbort(new DOMException("Session request cancelled.", "AbortError"));
  };
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    cancelDeadline = backgroundTimeout(() => {
      controller.abort();
      reject(new Error("Session request timed out."));
    }, 20_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([
      interrupted,
      fetch(url, { ...init, signal: controller.signal, cache: "no-store" }).then(async (response) => ({
        response,
        body: await response.json().catch(() => null) as unknown,
      })),
    ]);
  } finally {
    cancelDeadline();
    signal.removeEventListener("abort", abort);
  }
}
