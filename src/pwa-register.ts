// Guarded PWA registration — only in production, non-preview, non-iframe.
export function registerPwa(): void {
  if (typeof window === "undefined") return;
  if (!import.meta.env.PROD) return;
  if (window.top !== window.self) return;
  const host = window.location.hostname;
  const url = new URL(window.location.href);
  const blocked =
    host.startsWith("id-preview--") ||
    host.startsWith("preview--") ||
    host === "lovableproject.com" || host.endsWith(".lovableproject.com") ||
    host === "lovableproject-dev.com" || host.endsWith(".lovableproject-dev.com") ||
    host === "beta.lovable.dev" || host.endsWith(".beta.lovable.dev") ||
    url.searchParams.get("sw") === "off";
  if (blocked) {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((rs) => {
        rs.forEach((r) => {
          if (r.active?.scriptURL.endsWith("/sw.js")) r.unregister();
        });
      }).catch(() => {});
    }
    return;
  }
  if (!("serviceWorker" in navigator)) return;
  import(/* @vite-ignore */ "virtual:pwa-register").then(({ registerSW }: { registerSW: (opts: { immediate: boolean }) => void }) => {
    registerSW({ immediate: true });
  }).catch(() => {});
}