import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PeopleCatalog, PersonSummary } from "../people/store";
import { withPhotoVisibility, type PhotoVisibility } from "../photo-visibility";
import { AlbumDialog, albumRequest } from "./AlbumViews";
import { Icon, IconButton } from "./Icons";
import { nf, type Points } from "./data";

const PAGE_SIZE = 80;
const label = (person: PersonSummary) => person.name ?? `Unnamed person ${person.id}`;
const photoCount = (count: number) => `${nf.format(count)} ${count === 1 ? "photo" : "photos"}`;
const matches = (person: PersonSummary, term: string) =>
  label(person).toLowerCase().includes(term.trim().toLowerCase());

function Portrait({ person, visibility }: { person: PersonSummary; visibility: PhotoVisibility }) {
  const url = withPhotoVisibility(`/api/faces/${person.coverId}/cover`, visibility);
  return (
    <span className="album-cover person-portrait">
      <Icon name="person" />
      <img
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
  visibility,
  points,
  indexOf,
  onOpen,
  onBack,
  onMerged,
  renderGallery,
}: {
  personId: number | null;
  visibility: PhotoVisibility;
  points: Points | null;
  indexOf(id: number): number | undefined;
  onOpen(id: number): void;
  onBack(): void;
  onMerged(id: number, refresh: () => void): void;
  renderGallery(membership: Uint8Array, paused: boolean): ReactNode;
}) {
  const [catalog, setCatalog] = useState<PeopleCatalog | null>(null);
  const [members, setMembers] = useState<{ personId: number; ids: number[] } | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [membersError, setMembersError] = useState<{ personId: number; message: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [edit, setEdit] = useState<"name" | "merge" | null>(null);
  const reload = () => setRevision((value) => value + 1);

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

  useEffect(() => {
    if (personId == null) return;
    const controller = new AbortController();
    setMembersError(null);
    albumRequest<number[]>(withPhotoVisibility(`people/${personId}`, visibility), "GET", undefined, controller.signal)
      .then((ids) => {
        if (!controller.signal.aborted) setMembers({ personId, ids });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setMembersError({ personId, message: error.message });
      });
    return () => controller.abort();
  }, [personId, points, revision, visibility]);

  const person = catalog?.people.find((entry) => entry.id === personId);
  const membership = useMemo(() => {
    if (personId == null || !points || members?.personId !== personId) return null;
    const mask = new Uint8Array(points.n);
    for (const id of members.ids) {
      const index = indexOf(id);
      if (index != null) mask[index] = 1;
    }
    return mask;
  }, [personId, points, members, indexOf]);

  const matching = useMemo(() => catalog?.people.filter((entry) => matches(entry, query)) ?? [], [catalog, query]);
  const issue = catalogError || (membersError?.personId === personId ? membersError?.message : "");
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
                  <strong>{label(entry)}</strong>
                  <span className="album-card-meta dim">{photoCount(entry.count)}</span>
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
            <h1>{person ? label(person) : "Person"}</h1>
            {person && <p className="dim">{photoCount(person.count)}</p>}
          </div>
        </div>
        {person && (
          <div className="album-heading-actions">
            <button className="btn" onClick={() => setEdit("name")}>
              {person.name ? "Rename" : "Add name"}
            </button>
            <button className="btn" onClick={() => setEdit("merge")} disabled={catalog!.people.length < 2}>
              Merge with…
            </button>
          </div>
        )}
      </header>
      {issue || !person || !membership ? status : renderGallery(membership, edit != null)}
      {edit && person && catalog && (
        <PersonDialog
          key={`${person.id}:${edit}`}
          action={edit}
          person={person}
          people={catalog.people}
          visibility={visibility}
          onClose={() => setEdit(null)}
          onSave={(target) => {
            setEdit(null);
            if (target == null) reload();
            else onMerged(target, reload);
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
                    <strong>{label(entry)}</strong>
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
                Combine {label(person)} and {label(selected)} under{" "}
                <strong>{selected.name ?? person.name ?? label(selected)}</strong>.
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
