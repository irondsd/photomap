import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import type { PeopleCatalog, PersonSummary } from "../people/store";
import { withPhotoVisibility, type PhotoVisibility } from "../photo-visibility";
import { AlbumDialog, albumDates, albumRequest, CoverPicker, type CoverPickerState } from "./AlbumViews";
import type { Gallery } from "./Gallery";
import { Icon, IconButton } from "./Icons";
import { nf, type Points } from "./data";

const PAGE_SIZE = 80;
export const personName = (person: PersonSummary) => person.name ?? `Unnamed person ${person.id}`;
const photoCount = (count: number) => `${nf.format(count)} ${count === 1 ? "photo" : "photos"}`;
const matches = (person: PersonSummary, term: string) =>
  personName(person).toLowerCase().includes(term.trim().toLowerCase());

function Portrait({ person, visibility }: { person: PersonSummary; visibility: PhotoVisibility }) {
  const url = withPhotoVisibility(`/api/faces/${person.coverId}/cover`, visibility);
  return (
    <span className="album-cover person-portrait">
      <Icon name="person" />
      <img
        key={person.coverId}
        src={url}
        alt=""
        loading="lazy"
        onError={(event) => {
          event.currentTarget.hidden = true;
        }}
      />
    </span>
  );
}

export function PeopleView({
  personId,
  person,
  membership,
  hasLocations,
  personError,
  visibility,
  points,
  revision,
  reload,
  onOpen,
  onBack,
  onMap,
  onMerged,
  renderGallery,
}: {
  personId: number | null;
  person: PersonSummary | undefined;
  membership: Uint8Array | null;
  hasLocations: boolean | null;
  personError: string;
  visibility: PhotoVisibility;
  points: Points | null;
  revision: number;
  reload(): void;
  onOpen(id: number): void;
  onBack(): void;
  onMap(): void;
  onMerged(id: number): void;
  renderGallery(
    membership: Uint8Array,
    paused: boolean,
    picker?: ComponentProps<typeof Gallery>["coverPicker"],
  ): ReactNode;
}) {
  const [catalog, setCatalog] = useState<PeopleCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [edit, setEdit] = useState<"name" | "merge" | null>(null);
  const [cover, setCover] = useState<Omit<CoverPickerState, "onSave" | "onCancel"> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setCatalogError("");
    albumRequest<PeopleCatalog>(withPhotoVisibility("people", visibility), "GET", undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setCatalogError(error.message);
      });
    return () => controller.abort();
  }, [points, revision, visibility]);

  useEffect(() => setCover(null), [personId]);
  useEffect(() => {
    if (!cover || cover.saving) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCover(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [cover]);

  const saveCover = async () => {
    if (!person || !cover || cover.candidate == null || cover.saving) return;
    const saving = { ...cover, saving: true, error: "" };
    setCover(saving);
    try {
      await albumRequest(withPhotoVisibility(`people/${person.id}/cover`, visibility), "PUT", {
        photoId: cover.candidate,
      });
      setCover((current) => (current === saving ? null : current));
      reload();
    } catch (error) {
      setCover((current) => (current === saving ? { ...cover, error: (error as Error).message } : current));
    }
  };

  const matching = useMemo(() => catalog?.people.filter((entry) => matches(entry, query)) ?? [], [catalog, query]);
  const issue = personId == null ? catalogError : personError;
  const status = issue ? (
    <div className="empty">
      <p role="alert">{issue}</p>
      <button className="btn" onClick={reload}>
        Try again
      </button>
    </div>
  ) : (
    <div className="empty" role="status">
      Loading people…
    </div>
  );

  if (personId == null) {
    return (
      <div className="album-index">
        <header className="album-heading">
          <div>
            <h1>People</h1>
            {catalog && (
              <p className="dim">
                {nf.format(catalog.people.length)} {catalog.people.length === 1 ? "person" : "people found"}
                {" · "}
                {nf.format(catalog.scanned)} of {nf.format(catalog.total)} photos scanned
                {!!catalog.failed && ` · ${nf.format(catalog.failed)} couldn’t be processed`}
              </p>
            )}
          </div>
          <div className="people-tools">
            {!!catalog?.people.length && (
              <input
                className="input"
                type="search"
                aria-label="Find a person"
                placeholder="Find a person"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(PAGE_SIZE);
                }}
              />
            )}
            <button className="btn" onClick={reload}>
              Refresh
            </button>
          </div>
        </header>
        {issue || !catalog ? (
          status
        ) : matching.length ? (
          <>
            <div className="album-cards people-cards">
              {matching.slice(0, limit).map((entry) => (
                <button className="album-card" key={entry.id} onClick={() => onOpen(entry.id)}>
                  <Portrait person={entry} visibility={visibility} />
                  <strong>{personName(entry)}</strong>
                  <span className="album-card-meta dim">
                    {photoCount(entry.count)} · {albumDates(entry)}
                  </span>
                </button>
              ))}
            </div>
            {matching.length > limit && (
              <div className="people-more">
                <button className="btn" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
                  Show more
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="empty">{query ? "No people match your search." : "No face groups yet."}</div>
        )}
      </div>
    );
  }

  return (
    <div className="album-detail" key={personId}>
      <header className="album-heading album-detail-heading">
        <div className="album-title">
          <IconButton name="back" label="All people" onClick={onBack} />
          {person && <Portrait key={person.coverId} person={person} visibility={visibility} />}
          <div>
            <h1>{person ? personName(person) : "Person"}</h1>
            {person && (
              <p className="dim">
                {photoCount(person.count)} · {albumDates(person)}
              </p>
            )}
          </div>
        </div>
        {person && (
          <div className="album-action-slot">
            <div className="album-heading-actions" inert={cover != null}>
              <button
                className="btn album-action"
                disabled={!membership}
                onClick={() => setCover({ candidate: null, saving: false, error: "" })}
              >
                <Icon name="album" /> Pick cover
              </button>
              <button className="btn" onClick={() => setEdit("name")}>
                {person.name ? "Rename" : "Add name"}
              </button>
              <button className="btn" onClick={() => setEdit("merge")} disabled={(catalog?.people.length ?? 0) < 2}>
                Merge with…
              </button>
              <button className="btn album-action" disabled={!hasLocations} onClick={onMap}>
                <Icon name="map" /> Show on map
              </button>
              {hasLocations === false && <span className="dim small">No locations for this person</span>}
            </div>
            <CoverPicker
              title="Pick person cover"
              current={person.coverPhotoId}
              selection={cover ? { ...cover, onSave: saveCover, onCancel: () => setCover(null) } : undefined}
            />
          </div>
        )}
      </header>
      {issue || !person || !membership
        ? status
        : renderGallery(
            membership,
            edit != null,
            cover
              ? {
                  current: person.coverPhotoId,
                  candidate: cover.candidate,
                  saving: cover.saving,
                  onPick: (id) => setCover((draft) => draft && { ...draft, candidate: id, error: "" }),
                }
              : undefined,
          )}
      {edit && person && (
        <PersonDialog
          key={`${person.id}:${edit}`}
          action={edit}
          person={person}
          people={catalog?.people ?? []}
          visibility={visibility}
          onClose={() => setEdit(null)}
          onSave={(target) => {
            setEdit(null);
            if (target == null) reload();
            else onMerged(target);
          }}
        />
      )}
    </div>
  );
}

function PersonDialog({
  action,
  person,
  people,
  visibility,
  onClose,
  onSave,
}: {
  action: "name" | "merge";
  person: PersonSummary;
  people: PersonSummary[];
  visibility: PhotoVisibility;
  onClose(): void;
  onSave(target: number | null): void;
}) {
  const [name, setName] = useState(person.name ?? "");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PersonSummary | null>(null);
  const [limit, setLimit] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const merging = action === "merge";
  const candidates = merging ? people.filter((entry) => entry.id !== person.id && matches(entry, query)) : [];
  const title = merging ? "Merge people" : person.name ? "Rename person" : "Add a name";
  return (
    <AlbumDialog title={title} onClose={onClose} busy={busy}>
      <form
        className="album-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || (merging && !selected)) return;
          setBusy(true);
          setError("");
          try {
            const path = withPhotoVisibility(`people/${person.id}${merging ? "/merge" : ""}`, visibility);
            await albumRequest(path, merging ? "POST" : "PATCH", merging ? { target: selected!.id } : { name });
            onSave(merging ? selected!.id : null);
          } catch (problem) {
            setError((problem as Error).message);
            setBusy(false);
          }
        }}
      >
        {merging ? (
          <>
            <label htmlFor="merge-person-search">Find the group to keep</label>
            <input
              className="input"
              id="merge-person-search"
              type="search"
              value={query}
              disabled={busy}
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(24);
              }}
            />
            <div className="people-merge-list" aria-label="Matching people">
              {candidates.slice(0, limit).map((entry) => (
                <button
                  className="album-picker-row"
                  key={entry.id}
                  type="button"
                  aria-pressed={entry.id === selected?.id}
                  disabled={busy}
                  onClick={() => setSelected(entry)}
                >
                  <Portrait person={entry} visibility={visibility} />
                  <span>
                    <strong>{personName(entry)}</strong>
                    <small className="dim">{photoCount(entry.count)}</small>
                  </span>
                </button>
              ))}
              {!candidates.length && <p className="dim">No matching people.</p>}
              {candidates.length > limit && (
                <button className="btn" type="button" onClick={() => setLimit((value) => value + 24)}>
                  Show more
                </button>
              )}
            </div>
            {selected && (
              <p role="status">
                Combine {personName(person)} and {personName(selected)} under{" "}
                <strong>{selected.name ?? person.name ?? personName(selected)}</strong>.
              </p>
            )}
          </>
        ) : (
          <>
            <label htmlFor="person-name">Name</label>
            <input
              className="input"
              id="person-name"
              value={name}
              maxLength={120}
              disabled={busy}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="row">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" disabled={busy || (merging && !selected)}>
            {busy ? "Saving…" : merging ? "Merge people" : "Save name"}
          </button>
        </div>
      </form>
    </AlbumDialog>
  );
}
