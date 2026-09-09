/** Install only the production shell. Updates wait until all existing tabs close. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
    .catch(() => {
      // Storage restrictions/offline installation must not block online sharing.
      console.warn("Kleepee could not enable offline app loading.");
    });
}
