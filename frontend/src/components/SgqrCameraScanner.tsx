"use client";

import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { useEffect, useRef, useState } from "react";

type State =
  | { kind: "starting" }
  | { kind: "scanning"; hint: string }
  | { kind: "permission_denied" }
  | { kind: "no_camera" }
  | { kind: "error"; message: string };

export interface SgqrCameraScannerProps {
  onDecoded: (text: string) => void;
  onCancel: () => void;
}

/**
 * Modal camera scanner tuned for Singapore SGQR stickers.
 *
 * Real-world SGQR characteristics (per bank print specs + EMVCo MPM):
 *   - Sticker format: A5 (148×210 mm) or A6 (105×148 mm).
 *   - Embedded QR ≈ 40–55 mm on a side, version ~5–8 (37×37 to 53×53
 *     modules), error-correction level M (~15%).
 *   - Black modules on white background; 4-module quiet zone.
 *   - 10:1 scan-distance rule → a 50 mm QR scans comfortably at
 *     30–50 cm, which is arm's length.
 *
 * Scanner tuning:
 *   - decodeFromConstraints with facingMode: "environment" so the rear
 *     camera is used on phones without enumerateDevices() permission
 *     racing (iOS Safari).
 *   - Request 1280×720 minimum so module edges are sharp at the
 *     recommended 30 cm distance.
 *   - TRY_HARDER hint — non-trivial overhead, but SGQR stickers are
 *     glossy plastic and often picked up under fluorescent stall
 *     lighting; the extra effort matters.
 *   - QR_CODE only — skip the other 30+ symbologies ZXing knows.
 *   - Aiming reticle sized so the user naturally frames the QR at
 *     ~60% of the frame — that's the geometry the 10:1 distance rule
 *     produces with a 50 mm sticker at 30 cm.
 */
export function SgqrCameraScanner({ onDecoded, onCancel }: SgqrCameraScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const calledRef = useRef(false);
  const [state, setState] = useState<State>({ kind: "starting" });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setState({ kind: "no_camera" });
          return;
        }

        const hints = new Map();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
        hints.set(DecodeHintType.TRY_HARDER, true);
        const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 80 });

        // Constraints: rear camera + HD-min resolution + continuous focus
        // where supported (Android Chrome). iOS Safari ignores focusMode but
        // accepts the rest cleanly.
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            // The `as` cast is for the experimental focusMode constraint,
            // which is not in the lib.dom TS types yet.
            ...({ focusMode: "continuous" } as object),
          },
        };

        if (cancelled || !videoRef.current) return;
        setState({ kind: "scanning", hint: "Hold the sticker steady at arm's length." });

        const controls = await reader.decodeFromConstraints(
          constraints,
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
        } else if (/NotFound|Overconstrained|no.*camera/i.test(msg)) {
          // Fallback: relax facingMode and try any camera.
          try {
            const hints = new Map();
            hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
            hints.set(DecodeHintType.TRY_HARDER, true);
            const reader = new BrowserMultiFormatReader(hints);
            const controls = await reader.decodeFromConstraints(
              { audio: false, video: true },
              videoRef.current!,
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
            setState({ kind: "scanning", hint: "Using the only available camera." });
          } catch (e2) {
            setState({ kind: "no_camera" });
            void e2;
          }
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
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur flex items-center justify-center p-4">
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
            autoPlay
            className="absolute inset-0 w-full h-full object-cover"
          />
          {/* Aiming reticle — sized for the 10:1 rule: a 50mm SGQR
              filling ~60% of the frame at 30cm. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              className="border-2 border-emerald-400/85 rounded-lg shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
              style={{ width: "60%", aspectRatio: "1 / 1" }}
            />
            {/* Corner ticks for visual guidance */}
            <div className="absolute" style={{ width: "60%", aspectRatio: "1 / 1" }}>
              <CornerTick className="top-0 left-0" />
              <CornerTick className="top-0 right-0 rotate-90" />
              <CornerTick className="bottom-0 right-0 rotate-180" />
              <CornerTick className="bottom-0 left-0 -rotate-90" />
            </div>
          </div>
        </div>

        <Status state={state} />
      </div>
    </div>
  );
}

function CornerTick({ className }: { className: string }) {
  return (
    <span
      className={`absolute w-5 h-5 border-emerald-300 ${className}`}
      style={{ borderTopWidth: 3, borderLeftWidth: 3 }}
    />
  );
}

function Status({ state }: { state: State }) {
  if (state.kind === "starting") {
    return <p className="text-xs text-zinc-400">Starting camera…</p>;
  }
  if (state.kind === "scanning") {
    return (
      <div className="text-xs text-zinc-400 space-y-1">
        <p>Point the SGQR sticker inside the green box.</p>
        <p className="text-zinc-500">
          {state.hint} Fills ~60% of the frame at ~30 cm for a typical 50 mm sticker.
        </p>
      </div>
    );
  }
  if (state.kind === "permission_denied") {
    return (
      <p className="text-xs text-amber-400">
        Camera permission denied. Allow it in your browser settings and reload,
        or close this and type the UEN manually.
      </p>
    );
  }
  if (state.kind === "no_camera") {
    return (
      <p className="text-xs text-amber-400">
        No camera available on this device. Close this and type the UEN
        manually instead.
      </p>
    );
  }
  return (
    <p className="text-xs text-red-400 break-words">Camera error: {state.message}</p>
  );
}
