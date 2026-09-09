import QRCode from "qrcode";

const DEFAULT_JOIN_ORIGIN = "https://kleepee.adelekecode.dev";

export function getJoinOrigin(): string {
  if (
    typeof import.meta.env !== "undefined" &&
    import.meta.env.VITE_JOIN_ORIGIN
  ) {
    return import.meta.env.VITE_JOIN_ORIGIN as string;
  }

  return DEFAULT_JOIN_ORIGIN;
}

/**
 * Builds the join URL for a session.
 * The sessionSecret is placed exclusively in the URL fragment (#) so it is
 * never sent to the server in HTTP requests.
 */
export function buildJoinURL(
  sessionId: string,
  sessionSecret: string,
  origin = getJoinOrigin(),
): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/j/${encodeURIComponent(sessionId)}#${sessionSecret}`;
}

/**
 * Parses a join URL and extracts the sessionId and sessionSecret.
 * - sessionId: the last path segment (after /j/)
 * - sessionSecret: the URL fragment (without the leading #)
 */
export function parseJoinURL(url: string): {
  sessionId: string;
  sessionSecret: string;
} {
  const parsed = new URL(url);
  // pathname is /j/<sessionId>; grab the last segment
  const segments = parsed.pathname.split("/");
  const sessionId = segments[segments.length - 1];
  // hash includes the leading '#', strip it
  const sessionSecret = parsed.hash.slice(1);
  return { sessionId, sessionSecret };
}

/**
 * Generates a QR code data URL for the given URL string using the qrcode npm
 * package. Runs entirely client-side and returns a data: URL suitable for
 * use as an <img src> value.
 */
export async function generateQRDataURL(url: string): Promise<string> {
  return QRCode.toDataURL(url);
}
