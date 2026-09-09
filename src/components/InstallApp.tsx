import { useEffect, useId, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function InstallApp() {
  const [installed, setInstalled] = useState(isStandalone);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [pending, setPending] = useState(false);
  const helpId = useId();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  useEffect(() => {
    const displayMode = window.matchMedia?.("(display-mode: standalone)");
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
      setShowHelp(false);
    };
    const onDisplayMode = () => setInstalled(isStandalone());
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    displayMode?.addEventListener?.("change", onDisplayMode);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      displayMode?.removeEventListener?.("change", onDisplayMode);
    };
  }, []);

  async function install() {
    if (!prompt) {
      setShowHelp((shown) => !shown);
      return;
    }
    setPending(true);
    setShowHelp(false);
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch {
      setShowHelp(true);
    } finally {
      setPrompt(null);
      setPending(false);
    }
  }

  if (installed) return null;

  return (
    <div className="relative">
      <button
        type="button"
        className="btn-secondary whitespace-nowrap text-xs"
        onClick={() => void install()}
        disabled={pending}
        aria-expanded={showHelp}
        aria-controls={helpId}
      >
        {pending ? "Installing…" : "Install app"}
      </button>
      {showHelp && (
        <div
          id={helpId}
          className="absolute right-0 top-full z-20 mt-2 w-64 max-w-[calc(100vw-32px)] rounded-[18px] border border-kleepee-border bg-kleepee-surface p-4 text-sm leading-6 text-kleepee-muted shadow-kleepee"
          onKeyDown={(event) => {
            if (event.key === "Escape") setShowHelp(false);
          }}
        >
          <p>
            {isIOS
              ? "In Safari, tap Share, then Add to Home Screen."
              : "Open your browser’s menu and look for Install app, Add to Home Screen, or Add to Dock. If none appears, this browser may not support installation."}
          </p>
          <p className="mt-2">Open Kleepee from your home screen or desktop in its own window. Your device may still pause connections in the background.</p>
          <button type="button" className="mt-3 font-medium text-kleepee-espresso underline" onClick={() => setShowHelp(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
