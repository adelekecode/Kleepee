import { useEffect, useState } from "react";
import { copyToClipboard } from "../lib/clipboard";
import { generateQRDataURL } from "../lib/qr";

interface QRCodeProps {
  url: string;
}

export function QRCode({ url }: QRCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setDataUrl(null);

    void generateQRDataURL(url)
      .then((nextDataUrl) => {
        if (active) setDataUrl(nextDataUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [url]);

  async function copyLink() {
    try {
      await copyToClipboard(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="grid aspect-square w-full max-w-[260px] place-items-center rounded-[18px] border border-kleepee-border bg-white p-4">
        {dataUrl ? (
          <img
            className="h-full w-full"
            src={dataUrl}
            alt="Kleepee join QR code"
          />
        ) : (
          <div className="spinner" aria-label="Generating QR code" />
        )}
      </div>

      <div className="w-full space-y-2">
        {failed && (
          <p className="text-center text-xs font-medium text-kleepee-danger">
            QR code failed. Use the link below.
          </p>
        )}

        <p className="max-w-full break-all rounded-[18px] border border-kleepee-border bg-kleepee-panel p-3 text-center text-xs leading-5 text-kleepee-muted">
          {url}
        </p>
      </div>

      <button className="btn-secondary" type="button" onClick={copyLink}>
        {copied ? "Copied!" : "Copy link"}
      </button>
    </div>
  );
}
