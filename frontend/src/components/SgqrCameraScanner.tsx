"use client";

import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { useEffect, useRef, useState } from "react";

type State =
  | { kind: "starting" }
  | { kind: "scanning" }
  | { kind: "permission_denied" }
  | { kind: "no_camera" }
  | { kind: "error"; message: string };

export interface SgqrCameraScannerProps {
  onDecoded: (text: string) => void;
  onCancel: () => void;
}

/**
 * Modal-friendly camera scanner. Streams the rear camera (when present)
 * into a <video>, decodes QR codes with ZXing, and fires `onDecoded`
 * with the first frame's text. Handles permission denial, missing
 * cameras, and generic errors with explicit states the parent can show.
 */
export function SgqrCameraScanner({ onDecoded, onCancel }: SgqrCameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const calledRef = useRef(false);
  const [state, setState] = useState<State>({ kind: "starting" });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setState({ kind: "no_camera" });
          return;
        }

        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
        const reader = new BrowserMultiFormatReader(hints);
        readerRef.current = reader;

        // Prefer the rear-facing camera on mobile; fall back to any available.
        const devices = await BrowserMultiFormatReader.listVideoInputDevices();
        const rear =
          devices.find((d) => /back|rear|environment/i.test(d.label)) ??
          devices[devices.length - 1];

        if (!rear) {
          setState({ kind: "no_camera" });
          return;
        }
        if (cancelled || !videoRef.current) return;

        setState({ kind: "scanning" });

        const controls = await reader.decodeFromVideoDevice(
          rear.deviceId,
          videoRef.current,
          (result) => {
            if (result && !calledRef.current) {
              calledRef.current = true;
              try {
                controls.stop();
              } catch {
                /* ignore */
              }
              onDecoded(result.getText());
            }
          },
        );
        controlsRef.current = controls;
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (/Permission|NotAllowed/i.test(msg)) {
          setState({ kind: "permission_denied" });
        } else if (/NotFound|no.*camera/i.test(msg)) {
          setState({ kind: "no_camera" });
        } else {
          setState({ kind: "error", message: msg });
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        controlsRef.current?.stop();
      } catch {
        /* ignore */
      }
    };
  }, [onDecoded]);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-lg bg-zinc-950 border border-zinc-800 p-4 space-y-3">
        <header className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-white">Scan an SGQR sticker</p>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-zinc-400 hover:text-white"
          >
            Close
          </button>
        </header>

        <div className="relative aspect-square w-full rounded-md overflow-hidden bg-black border border-zinc-800">
          <video
            ref={videoRef}
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-cover"
          />
          {/* Aiming reticle */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="w-3/5 aspect-square border-2 border-emerald-400/80 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.4)]" />
          </div>
        </div>

        <Status state={state} />
      </div>
    </div>
  );
}

function Status({ state }: { state: State }) {
  if (state.kind === "starting") {
    return <p className="text-xs text-zinc-400">Starting camera…</p>;
  }
  if (state.kind === "scanning") {
    return (
      <p className="text-xs text-zinc-400">
        Point the QR inside the green box. Auto-captures the first valid frame.
      </p>
    );
  }
  if (state.kind === "permission_denied") {
    return (
      <p className="text-xs text-amber-400">
        Camera permission denied. Allow it in your browser settings and reload,
        or type the UEN manually instead.
      </p>
    );
  }
  if (state.kind === "no_camera") {
    return (
      <p className="text-xs text-amber-400">
        No camera available on this device. Type the UEN manually instead.
      </p>
    );
  }
  return (
    <p className="text-xs text-red-400 break-words">Camera error: {state.message}</p>
  );
}
