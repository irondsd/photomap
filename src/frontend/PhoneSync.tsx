import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import {
  formatBytes,
  plural,
  sendToApp,
  syncFraction,
  syncHeadline,
  syncNeedsAttention,
  usePhoneSync,
  type AppSyncState,
} from "./phoneApp";

/** How long a finished sync's toast stays up when there's nothing to look at. */
const DONE_TOAST_MS = 3500;

/** Where a sync is: a bar, the file going up, and what went wrong. Shared by the toast and the Library tab. */
function SyncDetails({ state }: { state: AppSyncState }) {
  const p = state.progress;
  const r = state.result;
  const fraction = p ? syncFraction(p) : null;
  return (
    <div className="phone-sync-details">
      {state.running && (
        <div className="progress">
          <div
            className="progress-fill"
            style={{ width: fraction === null ? "100%" : `${Math.round(fraction * 100)}%` }}
            data-indeterminate={fraction === null || undefined}
          />
        </div>
      )}
      {p?.phase === "checking" && (
        <div className="dim small">
          {plural(p.scanned, "file")} checked, {p.missing.toLocaleString()} to send
        </div>
      )}
      {p?.phase === "uploading" && p.current && (
        <div className="dim small phone-sync-file">
          {p.current}
          {p.bytesTotal > 0 && ` · ${formatBytes(p.bytesSent)} of ${formatBytes(p.bytesTotal)}`}
        </div>
      )}
      {p?.phase === "uploading" && p.failed > 0 && (
        <div className="error small">{plural(p.failed, "file")} failed so far</div>
      )}
      {!state.running && r && (
        <div className="dim small">
          {plural(r.uploaded, "file")} sent, {r.present.toLocaleString()} already in Photomap
        </div>
      )}
      {!state.running && r?.stopped && <div className="error small">{r.stopped}</div>}
      {!state.running && r && r.failed.length > 0 && (
        <div className="phone-sync-failures">
          <div className="error small">Sync again to retry them.</div>
          {r.failed.slice(0, 5).map((f) => (
            <div key={f.filename} className="dim small break">
              {f.filename}: {f.error}
            </div>
          ))}
        </div>
      )}
      {state.notice && (
        <div className="small">
          {state.notice.text}{" "}
          {state.notice.settings && (
            <button className="btn btn-small" onClick={() => sendToApp({ type: "settings" })}>
              Open settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ToastIcon({ state }: { state: AppSyncState }) {
  if (state.running) return <span className="spinner" aria-hidden />;
  if (syncNeedsAttention(state)) return <span className="phone-sync-alert" aria-hidden>!</span>;
  return <Icon name="check" />;
}

/**
 * A small pill while the phone app syncs, which expands into the details on a tap. It lingers on a
 * finished sync only when something went wrong.
 */
export function SyncToast({ onOpenSettings }: { onOpenSettings(): void }) {
  const state = usePhoneSync();
  const [expanded, setExpanded] = useState(false);
  /** The run whose toast was closed, or timed out. */
  const [hiddenRun, setHiddenRun] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const run = state?.run ?? 0;
  const running = state?.running ?? false;
  const attention = state ? syncNeedsAttention(state) : false;
  const finishedAt = state?.finishedAt ?? null;

  // A clean finish shows briefly, then goes.
  useEffect(() => {
    if (running || attention || finishedAt === null) return;
    const left = finishedAt + DONE_TOAST_MS - Date.now();
    if (left <= 0) return;
    setNow(Date.now());
    const t = setTimeout(() => setNow(Date.now()), left);
    return () => clearTimeout(t);
  }, [run, running, attention, finishedAt]);

  const visible =
    !!state &&
    run > 0 &&
    hiddenRun !== run &&
    (running ||
      attention ||
      (expanded && finishedAt !== null) ||
      (finishedAt !== null && now - finishedAt < DONE_TOAST_MS));

  useEffect(() => {
    if (!visible) setExpanded(false);
  }, [visible]);

  if (!state || !visible) return null;

  const fraction = state.progress ? syncFraction(state.progress) : null;
  const headline = syncHeadline(state);

  if (!expanded) {
    return (
      <button
        className="phone-sync-toast"
        data-state={state.running ? "running" : attention ? "attention" : "done"}
        onClick={() => setExpanded(true)}
        aria-label={`${headline}. Show sync details`}
      >
        <ToastIcon state={state} />
        <span role="status">{headline}</span>
        {state.running && fraction !== null && <span className="dim">{Math.round(fraction * 100)}%</span>}
      </button>
    );
  }

  return (
    <div className="phone-sync-toast phone-sync-toast-open" role="dialog" aria-label="Phone sync">
      <div className="phone-sync-toast-head">
        <ToastIcon state={state} />
        <strong role="status">{headline}</strong>
        <button className="btn btn-ghost btn-small" onClick={() => setExpanded(false)} aria-label="Collapse">
          <Icon name="close" />
        </button>
      </div>
      <SyncDetails state={state} />
      <div className="phone-sync-toast-actions">
        <button className="btn btn-small btn-ghost" onClick={onOpenSettings}>
          Phone sync settings
        </button>
        {state.running ? (
          <button className="btn btn-small" onClick={() => sendToApp({ type: "stop" })}>
            Stop
          </button>
        ) : (
          <button className="btn btn-small" onClick={() => setHiddenRun(run)}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

/** Library → Phone sync, inside the phone app: this phone's sync rather than the pairing code. */
export function PhoneSyncPanel() {
  const state = usePhoneSync();
  if (!state) return <p className="dim">Connecting to the app…</p>;

  const last = state.finishedAt && !state.running ? new Date(state.finishedAt).toLocaleString() : null;
  return (
    <section className="phone-sync-panel">
      <div className="row phone-sync-connected small">
        <span className="phone-sync-dot" aria-hidden />
        <span>
          Connected to {state.server} · <span className="mono">{state.host}</span>
        </span>
      </div>

      <div className="phone-sync-card">
        <div className="row phone-sync-card-head">
          {state.running ? <span className="spinner" aria-hidden /> : null}
          <strong role="status">{syncHeadline(state)}</strong>
        </div>
        <SyncDetails state={state} />
        {last && <div className="dim small">Last sync {last}</div>}
      </div>

      <div className="dim small">Sync photos and videos from the last</div>
      <div className="segmented phone-sync-ranges" role="group" aria-label="Sync range">
        {state.ranges.map((r) => (
          <button
            key={r.id}
            type="button"
            aria-pressed={state.range === r.id}
            disabled={state.running}
            onClick={() => sendToApp({ type: "range", id: r.id })}
          >
            {r.label}
          </button>
        ))}
      </div>
      <p className="dim small">
        Photomap syncs by itself whenever you open the app. Files already in the library are skipped, so a longer range
        only takes longer to check.
      </p>

      {state.running ? (
        <button className="btn" onClick={() => sendToApp({ type: "stop" })}>
          Stop syncing
        </button>
      ) : (
        <button className="btn btn-primary" onClick={() => sendToApp({ type: "sync" })}>
          Sync now
        </button>
      )}

      <div className="row phone-sync-pairing">
        <button className="btn btn-small btn-ghost" onClick={() => sendToApp({ type: "rescan" })}>
          Scan new code
        </button>
        <button className="btn btn-small btn-ghost danger" onClick={() => sendToApp({ type: "unpair" })}>
          Unpair this phone
        </button>
      </div>
    </section>
  );
}
