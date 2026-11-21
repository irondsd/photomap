import { useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatDate, nf } from "./data";
import { SyncSection, useSyncStatus } from "./Sync";
import { useBackToClose } from "./history";

export interface Stats {
  total: number;
  geotagged: number;
  missing: number;
  errors: number;
  range: { min: number | null; max: number | null };
  kinds: { kind: string; n: number }[];
  timeSources: { source: string | null; n: number }[];
  countries: { code: string; name: string; n: number }[];
  cameras: { model: string; n: number }[];
  version: string;
}

export interface ScanStatus {
  running: boolean;
  root: string | null;
  phase: string;
  found: number;
  processed: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  errors: number;
  queued: number;
  message: string | null;
  version: string;
}

interface Root {
  id: number;
  path: string;
  last_scan_at: number | null;
}

const libraryTabs = [
  ["overview", "Overview"],
  ["folders", "Folders"],
  ["sync", "Phone Sync"],
] as const;

async function api<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? r.statusText);
  return j as T;
}

export const startScan = (rootId?: number) => api("/api/scan", { method: "POST", body: rootId ? { rootId } : {} });

export function ScanProgress({ scan }: { scan: ScanStatus }) {
  if (!scan.running) return null;
  const pct = scan.found ? Math.round((scan.processed / scan.found) * 100) : 0;
  return (
    <div className="scan-progress">
      <div className="scan-progress-text">
        {scan.phase === "walking"
          ? `Looking for photos… ${nf.format(scan.found)} found`
          : `Indexing ${nf.format(scan.processed)} of ${nf.format(scan.found)}`}
        {scan.queued > 0 && <span className="dim"> · {scan.queued} more folder(s) queued</span>}
      </div>
      <div className="progress">
        <div
          className="progress-fill"
          style={{ width: scan.phase === "walking" ? "100%" : `${pct}%` }}
          data-indeterminate={scan.phase === "walking" || undefined}
        />
      </div>
      <div className="dim small break">{scan.root}</div>
    </div>
  );
}

export function AddFolder({ onAdded, autoFocus }: { onAdded(): void; autoFocus?: boolean }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/roots", { method: "POST", body: { path } });
      setPath("");
      onAdded();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-folder" onSubmit={submit}>
      <div className="row">
        <input
          className="input mono"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="~/Pictures"
          autoFocus={autoFocus}
          spellCheck={false}
          aria-label="Folder path"
        />
        <button className="btn btn-primary" disabled={busy || !path.trim()}>
          Add & scan
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function RelinkFolder({ root, onSaved, onCancel }: { root: Root; onSaved(): void; onCancel(): void }) {
  const [path, setPath] = useState(root.path);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="add-folder"
      onSubmit={async (event) => {
        event.preventDefault();
        const next = path.trim();
        if (busy || !next || next === root.path) return;
        setBusy(true);
        setError(null);
        try {
          await api(`/api/roots/${root.id}`, { method: "PATCH", body: { path: next } });
          onSaved();
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <p className="dim small">
        If you moved this folder, enter its new path to keep its photos, edits, and albums linked.
      </p>
      <div className="row">
        <input
          className="input mono"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          autoFocus
          spellCheck={false}
          aria-label="New folder path"
        />
        <button className="btn btn-small btn-primary" disabled={busy || !path.trim() || path.trim() === root.path}>
          Save & scan
        </button>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

function LibraryFolders({
  scan,
  version,
  syncFolder,
  onChanged,
}: {
  scan: ScanStatus | null;
  version?: string;
  syncFolder: string | null;
  onChanged(): void;
}) {
  const [roots, setRoots] = useState<Root[]>([]);
  const [editingRoot, setEditingRoot] = useState<number | null>(null);
  const reload = () =>
    api<Root[]>("/api/roots")
      .then(setRoots)
      .catch(() => {});
  useEffect(() => {
    reload();
  }, [scan?.running, version]);

  const remove = async (r: Root) => {
    if (!confirm(`Remove ${r.path} from the index?\n\nYour files are not touched; only the index entries are removed.`))
      return;
    try {
      await api(`/api/roots/${r.id}`, { method: "DELETE" });
    } catch (err) {
      alert((err as Error).message);
    }
    reload();
    onChanged();
  };

  return (
    <section>
      {roots.length === 0 && <p className="dim small">No folders have been added yet.</p>}
      <ul className="roots">
        {roots.map((r) => (
          <li key={r.id}>
            <div className="break mono small">{r.path}</div>
            <div className="dim small">
              {r.path === syncFolder && "Phone Sync · "}
              {r.last_scan_at ? `Scanned ${new Date(r.last_scan_at).toLocaleString()}` : "Not scanned yet"}
            </div>
            {editingRoot === r.id ? (
              <RelinkFolder
                root={r}
                onSaved={() => {
                  setEditingRoot(null);
                  reload();
                  onChanged();
                }}
                onCancel={() => setEditingRoot(null)}
              />
            ) : (
              <div className="row">
                {r.path !== syncFolder && (
                  <button
                    className="btn btn-small"
                    disabled={scan?.running || editingRoot !== null}
                    onClick={() => setEditingRoot(r.id)}
                  >
                    Change
                  </button>
                )}
                <button
                  className="btn btn-small"
                  disabled={scan?.running}
                  onClick={() => startScan(r.id).then(onChanged)}
                >
                  Rescan
                </button>
                <button className="btn btn-small btn-danger" onClick={() => remove(r)}>
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <AddFolder
        onAdded={() => {
          reload();
          onChanged();
        }}
      />
      <p className="dim small">
        Your files only change when you ask: writing edits into one, or deleting one to the Trash. The index and
        thumbnails live in the app's data folder.
      </p>
      {scan?.running ? (
        <>
          <ScanProgress scan={scan} />
          <button className="btn btn-small" onClick={() => fetch("/api/scan", { method: "DELETE" })}>
            Cancel scan
          </button>
        </>
      ) : (
        roots.length > 0 && (
          <button className="btn" onClick={() => startScan().then(onChanged)}>
            Rescan all folders
          </button>
        )
      )}
      {scan && !scan.running && scan.phase === "done" && (
        <p className="dim small">
          Last scan: {nf.format(scan.added)} added, {nf.format(scan.updated)} updated, {nf.format(scan.removed)} gone,{" "}
          {nf.format(scan.errors)} unreadable
        </p>
      )}
    </section>
  );
}

function LibraryOverview({
  stats,
  scan,
  onFolders,
}: {
  stats: Stats | null;
  scan: ScanStatus | null;
  onFolders(): void;
}) {
  const pct = (n: number) => (stats?.total ? `${Math.round((n / stats.total) * 100)}%` : "");

  return (
    <section>
      {scan?.running && <ScanProgress scan={scan} />}
      {!stats ? (
        <p className="dim">Loading library…</p>
      ) : stats.total === 0 ? (
        <>
          <p className="dim">No photos or videos in the library yet.</p>
          <button className="btn" onClick={onFolders}>
            Go to Folders
          </button>
        </>
      ) : (
        <>
          <dl className="stats">
            <dt>Photos & videos</dt>
            <dd>{nf.format(stats.total)}</dd>
            <dt>With location</dt>
            <dd>
              {nf.format(stats.geotagged)} <span className="dim">{pct(stats.geotagged)}</span>
            </dd>
            <dt>Date range</dt>
            <dd>
              {stats.range.min != null && stats.range.max != null
                ? `${formatDate(stats.range.min)} – ${formatDate(stats.range.max)}`
                : "—"}
            </dd>
            {stats.kinds.map((k) => (
              <div key={k.kind} className="stats-row">
                <dt>{k.kind === "photo" ? "Photos" : k.kind === "raw" ? "RAW" : "Videos"}</dt>
                <dd>{nf.format(k.n)}</dd>
              </div>
            ))}
          </dl>
          {stats.countries.length > 0 && (
            <>
              <h4>{stats.countries.length} countries</h4>
              <ul className="bars">
                {stats.countries.slice(0, 15).map((c) => (
                  <li key={c.code}>
                    <span>{c.name}</span>
                    <span className="bar" style={{ width: `${(c.n / stats.countries[0]!.n) * 100}%` }} />
                    <span className="dim">{nf.format(c.n)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {stats.cameras.length > 0 && (
            <>
              <h4>Cameras</h4>
              <ul className="bars">
                {stats.cameras.slice(0, 10).map((c) => (
                  <li key={c.model}>
                    <span>{c.model}</span>
                    <span className="bar" style={{ width: `${(c.n / stats.cameras[0]!.n) * 100}%` }} />
                    <span className="dim">{nf.format(c.n)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

export function Library({
  stats,
  scan,
  onClose,
  onChanged,
}: {
  stats: Stats | null;
  scan: ScanStatus | null;
  onClose(): void;
  onChanged(): void;
}) {
  useBackToClose(onClose);
  const [tab, setTab] = useState<(typeof libraryTabs)[number][0]>("overview");
  const id = useId();
  const sync = useSyncStatus(onChanged);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const focusTab = (next: typeof tab) => {
    setTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };

  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = libraryTabs.length;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = (index + 1) % count;
        break;
      case "ArrowLeft":
        next = (index + count - 1) % count;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusTab(libraryTabs[next]![0]);
  };

  const panels = {
    overview: <LibraryOverview stats={stats} scan={scan} onFolders={() => focusTab("folders")} />,
    folders: (
      <LibraryFolders
        scan={scan}
        version={stats?.version}
        syncFolder={sync.status?.indexedFolder ?? null}
        onChanged={onChanged}
      />
    ),
    sync: <SyncSection sync={sync} />,
  };

  return (
    <div className="drawer-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-label="Library">
        <header className="drawer-head">
          <h2>Library</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="tabs library-tabs" role="tablist" aria-label="Library sections">
          {libraryTabs.map(([value, label], index) => (
            <button
              key={value}
              type="button"
              className="tab"
              role="tab"
              id={`${id}-tab-${value}`}
              aria-controls={`${id}-panel-${value}`}
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(event) => onTabKey(event, index)}
            >
              {label}
            </button>
          ))}
        </div>

        {libraryTabs.map(([value]) => (
          <div
            key={value}
            className="library-panel"
            role="tabpanel"
            id={`${id}-panel-${value}`}
            aria-labelledby={`${id}-tab-${value}`}
            hidden={tab !== value}
            tabIndex={0}
          >
            {panels[value]}
          </div>
        ))}
      </div>
    </div>
  );
}
