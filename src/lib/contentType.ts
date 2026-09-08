/**
 * Classifies a string as a URL, email address, or plain text.
 */
export function classifyContent(text: string): "text" | "url" | "email" {
  // Check for HTTP/HTTPS URL
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return "url";
    }
  } catch {
    // Not a valid URL, fall through
  }

  // Check for email address
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    return "email";
  }

  return "text";
}
