"use client";

import { useEffect, useMemo, useState } from "react";
import Zoom from "react-medium-image-zoom";
import "react-medium-image-zoom/dist/styles.css";

interface DocViewerProps {
  plaintext: Uint8Array;
  mime: string;
}

/**
 * Renders the decrypted KYB document inline. PDF via the browser's
 * native PDF viewer (good enough on desktop Chrome / Firefox); images
 * via react-medium-image-zoom for tap-to-zoom on tablets.
 *
 * The plaintext stays in browser memory only; the blob URL is revoked
 * when the component unmounts.
 *
 * Note: a richer PDF.js-based viewer (zoom, page nav, search) is a
 * follow-up — for v1 the native viewer covers the common case (Bizfile
 * PDFs from ACRA are typically single-page A4 scans).
 */
export function DocViewer({ plaintext, mime }: DocViewerProps) {
  const url = useMemo(() => {
    const blob = new Blob([plaintext as Uint8Array<ArrayBuffer>], { type: mime });
    return URL.createObjectURL(blob);
  }, [plaintext, mime]);

  useEffect(() => {
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [url]);

  if (mime === "application/pdf") {
    return <PdfFrame url={url} />;
  }
  if (mime.startsWith("image/")) {
    return <ImageZoom url={url} mime={mime} />;
  }
  return (
    <div className="p-6">
      <p className="text-sm text-[var(--muted)]">
        Unknown MIME <code>{mime}</code> — try downloading.
      </p>
      <a
        href={url}
        download={`kyb-doc.${guessExtension(mime)}`}
        className="mt-2 inline-block text-sm text-[var(--accent)] underline"
      >
        Download to view
      </a>
    </div>
  );
}

function PdfFrame({ url }: { url: string }) {
  return (
    <div className="flex flex-1 flex-col gap-2">
      <iframe
        src={url}
        title="KYB document"
        className="min-h-[70vh] w-full rounded-xl border border-white/10 bg-white"
      />
      <p className="text-[10px] text-[var(--muted-soft)]">
        Browser native PDF viewer. If it doesn&apos;t render inline (rare on
        mobile Safari),{" "}
        <a href={url} download="kyb-doc.pdf" className="text-[var(--accent)] underline">
          download to open in your reader
        </a>
        .
      </p>
    </div>
  );
}

function ImageZoom({ url, mime }: { url: string; mime: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
      {!loaded && <p className="text-xs text-[var(--muted-soft)]">Decoding image…</p>}
      <Zoom>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt="KYB document"
          onLoad={() => setLoaded(true)}
          className="max-h-[70vh] w-auto rounded-xl border border-white/10 bg-white object-contain"
        />
      </Zoom>
      <p className="text-[10px] text-[var(--muted-soft)]">
        Tap the image to zoom · {mime}
      </p>
    </div>
  );
}

function guessExtension(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
}
