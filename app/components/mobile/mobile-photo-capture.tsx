import * as React from "react";
import { useT } from "~/i18n/use-t";

/**
 * Mobile photo capture. Camera → photo → attach to a
 * ticket. Uses `getUserMedia` for an in-page camera stream + canvas snapshot;
 * falls back to `<input type="file" capture="environment">` where getUserMedia is
 * unavailable (iOS Safari historically). The captured File is POSTed to the
 * existing `attachments.upload` route by the parent quick-entry form.
 *
 * Pure client component — the camera API is browser-only.
 */
export function MobilePhotoCapture({
  onCapture,
  existingCount,
}: {
  onCapture: (file: File) => void;
  existingCount: number;
}) {
  const t = useT();
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [captures, setCaptures] = React.useState(0);
  // Mirrors `stream` state but read from the unmount cleanup below, which
  // otherwise closes over the initial (null) `stream` from first render.
  const streamRef = React.useRef<MediaStream | null>(null);

  async function startCamera() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      // No getUserMedia — fall back to the file input (iOS Safari path).
      fileInputRef.current?.click();
      return;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      setStream(s);
      streamRef.current = s;
      // Attach the stream once the video element renders.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          void videoRef.current.play();
        }
      });
    } catch (e) {
      // Permission denied / no camera → fall back to file input.
      setError((e as Error).message);
      fileInputRef.current?.click();
    }
  }

  function stopCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
    streamRef.current = null;
  }

  function snap() {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1024;
    canvas.height = video.videoHeight || 768;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `capture-${Date.now()}.jpg`, { type: "image/jpeg" });
        onCapture(file);
        setCaptures((c) => c + 1);
      },
      "image/jpeg",
      0.9,
    );
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      onCapture(file);
      setCaptures((c) => c + 1);
    }
    e.target.value = ""; // allow re-selecting the same file
  }

  React.useEffect(() => {
    // Cleanup on unmount: stop tracks via the ref (not `stopCamera`, whose
    // first-render closure would otherwise see a stale null `stream`).
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {stream ? (
        <div className="relative">
          {/* a live camera feed has no captions (jsx-a11y media-has-caption N/A) */}
          <video
            ref={videoRef}
            className="bg-black aspect-video w-full rounded-sm"
            playsInline
            muted
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={snap}
              className="bg-primary text-primary-foreground rounded-sm px-4 py-3 text-sm font-medium"
            >
              {t("mobile.photo.take")}
            </button>
            <button
              type="button"
              onClick={stopCamera}
              className="border-border text-muted-foreground rounded-sm border px-4 py-3 text-sm"
            >
              {t("mobile.photo.close")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={startCamera}
          className="border-border hover:bg-accent rounded-sm border border-dashed px-4 py-6 text-sm"
        >
          {t("mobile.photo.start")}
        </button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onFileChange}
        className="hidden"
      />
      {error ? (
        <p className="text-muted-foreground text-xs">
          {t("mobile.photo.cameraUnavailable", { error })}
        </p>
      ) : null}
      {captures + existingCount > 0 ? (
        <p className="text-muted-foreground font-mono text-xs">
          {t("mobile.photo.count", { count: captures + existingCount })}
        </p>
      ) : null}
    </div>
  );
}
