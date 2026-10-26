/** Use the host's existing file server; never initialize a framework bridge. */
export const projectionURL = (url: string): string => {
  const host = globalThis as unknown as {
    Capacitor?: { convertFileSrc(url: string): string };
    WkWebView?: { convertFilePath(url: string): string };
  };
  if (host.Capacitor?.convertFileSrc) return host.Capacitor.convertFileSrc(url);
  if (!url.startsWith('file:')) return url;
  if (host.WkWebView?.convertFilePath) return host.WkWebView.convertFilePath(url);
  throw new Error('Native UI file URL requires a host resource handler');
};
