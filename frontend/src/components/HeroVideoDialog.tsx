"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful, self-contained port of magicui's Hero Video Dialog
// (https://magicui.design/docs/components/hero-video-dialog). Kept dependency-free
// — the codebase deliberately avoids motion/lucide/tailwind-merge — so the
// entrance animation and play icon are hand-rolled. Styling lives in globals.css
// under .quay-hvd-* to match the glass design system.

type AnimationStyle =
  | "from-bottom"
  | "from-center"
  | "from-top"
  | "fade";

export type HeroVideoDialogProps = {
  /** Embeddable iframe URL (e.g. https://www.youtube.com/embed/<id>). */
  videoSrc: string;
  /** Poster image shown before play. */
  thumbnailSrc: string;
  thumbnailAlt?: string;
  /** Fallback poster if the primary thumbnail 404s (e.g. YouTube maxres). */
  thumbnailFallbackSrc?: string;
  animationStyle?: AnimationStyle;
  className?: string;
};

export function HeroVideoDialog({
  videoSrc,
  thumbnailSrc,
  thumbnailAlt = "Video thumbnail",
  thumbnailFallbackSrc,
  animationStyle = "from-center",
  className = "",
}: HeroVideoDialogProps) {
  const [open, setOpen] = useState(false);
  // Two-frame mount → visible toggle so CSS transitions actually animate in.
  const [visible, setVisible] = useState(false);
  const [thumb, setThumb] = useState(thumbnailSrc);

  const close = useCallback(() => {
    setVisible(false);
    // Wait out the exit transition before unmounting the iframe.
    window.setTimeout(() => setOpen(false), 220);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const id = requestAnimationFrame(() => setVisible(true));
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(id);
      document.body.style.overflow = "";
    };
  }, [open, close]);

  // Autoplay once the dialog is open.
  const playSrc = open
    ? videoSrc + (videoSrc.includes("?") ? "&" : "?") + "autoplay=1"
    : "";

  return (
    <>
      <button
        type="button"
        className={`quay-hvd-trigger ${className}`}
        onClick={() => setOpen(true)}
        aria-label="Play video"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumb}
          alt={thumbnailAlt}
          className="quay-hvd-thumb"
          onError={() => {
            if (thumbnailFallbackSrc && thumb !== thumbnailFallbackSrc) {
              setThumb(thumbnailFallbackSrc);
            }
          }}
        />
        <span className="quay-hvd-scrim" aria-hidden />
        <span className="quay-hvd-play" aria-hidden>
          <PlayIcon />
        </span>
      </button>

      {open && (
        <div
          className={`quay-hvd-overlay ${visible ? "is-visible" : ""}`}
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label="Video player"
        >
          <button
            type="button"
            className="quay-hvd-close"
            onClick={close}
            aria-label="Close video"
          >
            <CloseIcon />
          </button>
          <div
            className={`quay-hvd-frame anim-${animationStyle}`}
            onClick={(e) => e.stopPropagation()}
          >
            <iframe
              src={playSrc}
              title="Demo video"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              className="quay-hvd-iframe"
            />
          </div>
        </div>
      )}
    </>
  );
}

function PlayIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.79-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
