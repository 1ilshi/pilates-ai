import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Camera, Check, RefreshCw } from "lucide-react";
import {
  Button,
  Card,
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@pilates/ui";
import { UpdateBanner } from "../components/UpdateBanner";
import type { UpdateState } from "../hooks/useUpdate";
import {
  isTauri,
  listCameras,
  type CameraDescriptor,
  type EngineStatus,
} from "../lib/ipc";
import { getSelectedCamera, setSelectedCamera } from "../lib/cameraPreference";

export interface SettingsPageProps {
  update: UpdateState;
  /** Live engine health polled in App; null in browser mode or before the first poll. */
  engine: EngineStatus | null;
}

/** A card with a hairline-separated header, matching the patient roster panel. */
function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="max-w-3xl gap-0 overflow-hidden py-0">
      <div className="border-b border-border/60 px-5 py-4">
        <h2 className="font-display text-base font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4 px-5 py-4">{children}</div>
    </Card>
  );
}

export function SettingsPage({ update, engine }: SettingsPageProps) {
  const native = isTauri();
  const [cameras, setCameras] = useState<CameraDescriptor[]>([]);
  const [selected, setSelected] = useState<number | null>(() => getSelectedCamera());
  const [checking, setChecking] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const checkCameras = useCallback(async () => {
    if (!native) return;
    setChecking(true);
    setCameraError(null);
    try {
      setCameras(await listCameras());
    } catch (error) {
      setCameraError(String(error));
    } finally {
      setChecking(false);
    }
  }, [native]);

  useEffect(() => {
    void checkCameras();
  }, [checkCameras]);

  const externalCount = cameras.filter((camera) => !camera.is_default).length;
  const current = cameras.find((camera) => camera.index === (selected ?? 0));

  // About-panel facts, mirroring the top-bar engine dot in App.tsx.
  const engineReady = !!engine?.runtime_found && !!engine?.inference_available;
  const engineLabel = !native
    ? "Browser mode"
    : !engine
      ? "Status unavailable"
      : engineReady
        ? `Ready · ${engine.provider}`
        : "Not ready";
  const engineTone: "ready" | "down" | "muted" =
    native && engine ? (engineReady ? "ready" : "down") : "muted";
  const cloudSyncLabel = !native
    ? "Unavailable"
    : engine
      ? engine.cloud_sync_enabled
        ? "Enabled"
        : "Local only"
      : "Status unavailable";

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground">
          Settings
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Camera, updates and workstation details.
        </p>
      </div>

      <Panel title="Camera" description="Choose the camera used for preview and recording.">
        {!native && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            Camera settings require the native workstation. Run the app with Tauri
            to detect and select devices.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void checkCameras()}
            disabled={!native || checking}
            loading={checking}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Check cameras
          </Button>
          <span className="text-xs text-muted-foreground">
            {checking
              ? "Looking for devices…"
              : cameras.length === 0
                ? "No camera detected"
                : `${cameras.length} camera${cameras.length === 1 ? "" : "s"} detected${externalCount > 0 ? ` · ${externalCount} external` : ""}`}
          </span>
        </div>

        {cameraError && (
          <p className="text-xs text-red-300" title={cameraError}>
            Could not list cameras — {cameraError}
          </p>
        )}

        {native && cameras.length > 0 && (
          <div className="space-y-2">
            <label htmlFor="settings-camera" className="text-xs font-medium text-foreground">
              Input device
            </label>
            <Select
              value={selected === null ? "default" : String(selected)}
              onValueChange={(value) => {
                const next = value === "default" ? null : Number(value);
                setSelectedCamera(next);
                setSelected(next);
              }}
            >
              <SelectTrigger id="settings-camera" className="max-w-md">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default camera</SelectItem>
                {cameras.map((camera) => (
                  <SelectItem key={camera.index} value={String(camera.index)}>
                    {camera.human_name || `Camera ${camera.index}`}
                    {camera.description ? ` — ${camera.description}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Camera className="size-3.5" aria-hidden="true" />
              {current
                ? `Using ${current.human_name || `camera ${current.index}`}`
                : "Using the engine's default camera"}
              {" · takes effect when the next preview starts"}
            </p>
          </div>
        )}
      </Panel>

      <Panel
        title="Updates"
        description="Current version and release channel."
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="text-muted-foreground">Current version</span>
            <span className="ml-2 font-mono text-foreground">
              {update.currentVersion ?? "…"}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void update.checkNow()}
            disabled={update.checking || update.installing}
          >
            {update.checking ? "Checking…" : "Check for updates"}
          </Button>
        </div>

        {update.upToDate && (
          <p className="flex items-center gap-1.5 text-xs text-emerald-400">
            <Check className="size-3.5" aria-hidden="true" />
            Up to date
          </p>
        )}
        {update.error && (
          <p className="text-xs text-red-300" title={update.error}>
            Update check failed — {update.error}
          </p>
        )}

        <UpdateBanner
          update={update}
          className="rounded-xl border border-primary/30 bg-primary/10 sm:px-4"
        />

        <p className="text-xs text-muted-foreground">
          Updates are checked automatically. If you skip one, you can check again
          any time here in Settings → Updates.
        </p>
      </Panel>

      <Panel title="About" description="Workstation build and engine health.">
        <dl className="divide-y divide-border/40">
          <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-sm text-muted-foreground">App version</dt>
            <dd className="font-mono text-sm text-foreground">
              {update.currentVersion ?? "—"}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-sm text-muted-foreground">Engine</dt>
            <dd className="flex items-center gap-2 text-sm text-foreground">
              <span
                aria-hidden="true"
                className={cn(
                  "size-2 rounded-full",
                  engineTone === "ready" && "bg-emerald-500",
                  engineTone === "down" && "bg-red-500",
                  engineTone === "muted" && "bg-muted-foreground/40",
                )}
              />
              {engineLabel}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
            <dt className="text-sm text-muted-foreground">Cloud sync</dt>
            <dd className="text-sm text-foreground">{cloudSyncLabel}</dd>
          </div>
        </dl>
      </Panel>
    </div>
  );
}
