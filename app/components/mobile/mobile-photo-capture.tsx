import * as React from "react";
import { useT } from "~/i18n/use-t";
import { Button } from "~/components/ui/button";
import { Camera, ImagePlus } from "lucide-react";

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
  const [starting, setStarting] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const mounted = React.useRef(true);
  // Mirrors `stream` state but read from the unmount cleanup below, which
  // otherwise closes over the initial (null) `stream` from first render.
  const streamRef = React.useRef<MediaStream | null>(null);

  async function startCamera() {
    if (starting) return;
    setError(null);
    fileInputRef.current?.setAttribute("capture", "environment");
    if (!navigator.mediaDevices?.getUserMedia) {
      // No getUserMedia — fall back to the file input (iOS Safari path).
      fileInputRef.current?.click();
      return;
    }
    setStarting(true);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      if (!mounted.current) {
        s.getTracks().forEach((track) => track.stop());
        return;
      }
      setStream(s);
      streamRef.current = s;
      // Attach the stream once the video element renders.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          void videoRef.current.play();
        }
      });
    } catch {
      // Permission denied / no camera → fall back to file input.
      if (!mounted.current) return;
      setError(t("mobile.photo.unavailable"));
      fileInputRef.current?.click();
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  function stopCamera() {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
    setReady(false);
    streamRef.current = null;
  }

  function snap() {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return;
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
    mounted.current = true;
    // Cleanup on unmount: stop tracks via the ref (not `stopCamera`, whose
    // first-render closure would otherwise see a stale null `stream`).
    return () => {
      mounted.current = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {stream ? (
        <div className="flex flex-col gap-2">
          {/* a live camera feed has no captions (jsx-a11y media-has-caption N/A) */}
          <video
            ref={videoRef}
            className="bg-camera-preview aspect-video w-full rounded-lg"
            playsInline
            muted
            onLoadedData={() => setReady(true)}
          />
          <div className="flex gap-2">
            <Button type="button" onClick={snap} disabled={!ready} className="min-h-11 flex-1">
              <Camera aria-hidden className="size-4" />
              {t("mobile.photo.take")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={stopCamera}
              className="min-h-11 flex-1"
            >
              {t("mobile.photo.close")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="secondary"
          onClick={startCamera}
          disabled={starting}
          className="min-h-11 w-full py-6 text-sm"
        >
          <Camera aria-hidden className="size-4" />
          {starting ? t("mobile.photo.starting") : t("mobile.photo.start")}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        onClick={() => {
          fileInputRef.current?.removeAttribute("capture");
          fileInputRef.current?.click();
        }}
      >
        <ImagePlus aria-hidden className="size-4" />
        {t("mobile.photo.choose")}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={onFileChange}
        className="hidden"
      />
      {error ? (
        <p role="status" className="text-muted-foreground text-xs">
          {error}
        </p>
      ) : null}
      {existingCount > 0 ? (
        <p role="status" className="text-muted-foreground nums text-xs">
          {t("mobile.photo.count", { count: existingCount })}
        </p>
      ) : null}
      {captures > 0 ? (
        <p role="status" className="text-muted-foreground nums text-xs">
          {t("mobile.photo.selected", { count: captures })}
        </p>
      ) : null}
    </div>
  );
}
