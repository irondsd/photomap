import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AlbumDate, AlbumSummary } from "../albums";
import { formatDate, formatYear, nf, thumbUrl } from "./data";
import { Icon, IconButton } from "./Icons";
import { useBackToClose } from "./history";

export async function albumRequest<T>(path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method,
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new Error(problem?.error ?? "Couldn't complete the request. Try again.");
  }
  return response.json();
}

export function albumDates(album: AlbumSummary): string {
  const label = (date: AlbumDate) => (date.yearOnly ? formatYear(date.time) : formatDate(date.time));
  if (!album.first || !album.last) return album.count ? "Dates unknown" : "";
  const first = label(album.first);
  const last = label(album.last);
  return first === last ? first : `${first} – ${last}`;
}

export function AlbumCover({ album }: { album: AlbumSummary }) {
  return (
    <span className="album-cover">
      {album.coverId != null ? (
        <img src={thumbUrl(album.coverId, "m")} alt="" loading="lazy" />
      ) : (
        <Icon name={album.id === 0 ? "star" : "album"} />
      )}
      {album.id === 0 && album.coverId != null && (
        <span className="album-cover-star">
          <Icon name="star" />
        </span>
      )}
    </span>
  );
}

const itemCount = (count: number) => `${nf.format(count)} ${count === 1 ? "item" : "items"}`;

export function AlbumList({
  albums,
  onOpen,
  onCreate,
}: {
  albums: AlbumSummary[];
  onOpen(id: number): void;
  onCreate(): void;
}) {
  return (
    <div className="album-index">
      <header className="album-heading">
        <h1>Albums</h1>
        <button className="btn btn-primary album-action" onClick={onCreate}>
          <Icon name="plus" /> New album
        </button>
      </header>
      <div className="album-cards">
        {albums.map((album) => (
          <button className="album-card" key={album.id} onClick={() => onOpen(album.id)}>
            <AlbumCover album={album} />
            <strong>{album.name}</strong>
            <span className="album-card-meta dim">
              {[albumDates(album), itemCount(album.count)].filter(Boolean).join(" · ")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function AlbumHeader({
  album,
  hasLocations,
  onBack,
  onMap,
  onRename,
  onDelete,
  onPickCover,
  coverPicker,
}: {
  album: AlbumSummary;
  hasLocations: boolean | null;
  onBack(): void;
  onMap(): void;
  onRename(): void;
  onDelete(): void;
  onPickCover?: () => void;
  coverPicker?: {
    candidate: number | null;
    saving: boolean;
    error: string;
    onSave(): void;
    onCancel(): void;
  };
}) {
  const previewCover = coverPicker?.candidate ?? album.coverId;
  const picking = coverPicker != null;
  const cancelButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (picking) cancelButton.current?.focus({ preventScroll: true });
  }, [picking]);
  return (
    <header className="album-heading album-detail-heading">
      <div className="album-title">
        <IconButton name="back" label="All albums" onClick={onBack} />
        <div>
          <h1>{album.name}</h1>
          <p className="dim">{[albumDates(album), itemCount(album.count)].filter(Boolean).join(" · ")}</p>
        </div>
      </div>
      <div className="album-action-slot">
        <div className="album-heading-actions" inert={picking}>
          {album.id !== 0 && (
            <>
              <button className="btn album-action" onClick={onPickCover} disabled={!onPickCover}>
                <Icon name="album" /> Pick cover
              </button>
              <IconButton name="edit" label="Rename album" onClick={onRename} />
              <IconButton name="trash" label="Delete album" onClick={onDelete} />
            </>
          )}
          <button className="btn album-action" disabled={!hasLocations} onClick={onMap}>
            <Icon name="map" /> Show on map
          </button>
          {!!album.count && hasLocations === false && <span className="dim small">No locations in this album</span>}
        </div>
        {album.id !== 0 && (
          <div className="cover-picker-controls" inert={!picking}>
            <div className="cover-picker-preview" aria-hidden="true">
              {picking && previewCover != null ? (
                <img src={thumbUrl(previewCover, "m")} alt="" />
              ) : (
                <Icon name="album" />
              )}
            </div>
            <div className="cover-picker-copy">
              <strong>Pick album cover</strong>
              <p className="dim">Select a photo, then save your choice.</p>
            </div>
            <button className="btn" ref={cancelButton} onClick={coverPicker?.onCancel} disabled={coverPicker?.saving}>
              Cancel
            </button>
            <button
              className="btn btn-primary cover-picker-save"
              onClick={coverPicker?.onSave}
              disabled={coverPicker?.saving || coverPicker?.candidate == null}
            >
              {coverPicker?.saving ? "Saving…" : "Save cover"}
            </button>
            {coverPicker?.error && (
              <p className="cover-picker-error error" role="alert">
                {coverPicker.error}
              </p>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

function AlbumDialog({
  title,
  onClose,
  busy,
  children,
}: {
  title: string;
  onClose(): void;
  busy: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useBackToClose(() => {
    if (busy) return false;
    onClose();
  });
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      className="modal album-dialog"
      ref={ref}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <IconButton name="close" label="Close" disabled={busy} onClick={onClose} />
      </div>
      {children}
    </dialog>
  );
}

export function AlbumPicker({
  albums,
  ids,
  onClose,
  onSaved,
}: {
  albums: AlbumSummary[];
  ids: readonly number[];
  onClose(): void;
  onSaved(name: string): void;
}) {
  const [creating, setCreating] = useState(ids.length === 0);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (album?: AlbumSummary) => {
    if (busy || (!album && !name.trim())) return;
    setBusy(true);
    setError("");
    try {
      if (album) {
        await albumRequest(`albums/${album.id}/members`, "POST", { ids });
        onSaved(album.name);
      } else {
        const title = name.trim();
        await albumRequest("albums", "POST", ids.length ? { name: title, ids } : { name: title });
        onSaved(title);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <AlbumDialog title={creating ? "New album" : "Add to album"} onClose={onClose} busy={busy}>
      {ids.length > 0 && <p className="note">{itemCount(ids.length)} selected</p>}
      {creating ? (
        <form
          className="album-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor="album-name">Album name</label>
          <input
            className="input"
            id="album-name"
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="row">
            {!!ids.length && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setCreating(false);
                }}
              >
                Existing albums
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
              {ids.length ? "Create and add" : "Create album"}
            </button>
          </div>
        </form>
      ) : (
        <>
          <button
            className="btn btn-primary album-action album-new"
            disabled={busy}
            onClick={() => {
              setError("");
              setCreating(true);
            }}
          >
            <Icon name="plus" /> New album
          </button>
          <div className="album-picker-list">
            {albums.map((album) => (
              <button key={album.id} className="album-picker-row" disabled={busy} onClick={() => void save(album)}>
                <AlbumCover album={album} />
                <span>
                  <strong>{album.name}</strong>
                  <small className="dim">{albumDates(album) || itemCount(album.count)}</small>
                </span>
              </button>
            ))}
            {!albums.length && <p className="dim">No albums yet.</p>}
          </div>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </AlbumDialog>
  );
}

export function AlbumEditDialog({
  album,
  remove,
  onClose,
  onSaved,
}: {
  album: AlbumSummary;
  remove: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const [name, setName] = useState(album.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await albumRequest(`albums/${album.id}`, remove ? "DELETE" : "PATCH", remove ? undefined : { name });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <AlbumDialog title={remove ? "Delete album" : "Rename album"} onClose={onClose} busy={busy}>
      <form
        className="album-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {remove ? (
          <p>Delete “{album.name}”? Its photos will stay in your gallery.</p>
        ) : (
          <>
            <label htmlFor="album-rename">Album name</label>
            <input
              className="input"
              id="album-rename"
              required
              autoFocus
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button className="btn" type="button" autoFocus={remove} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${remove ? "btn-danger" : "btn-primary"}`}
            type="submit"
            disabled={busy || !name.trim()}
          >
            {remove ? "Delete album" : "Save name"}
          </button>
        </div>
      </form>
    </AlbumDialog>
  );
}
