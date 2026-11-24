import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { PeopleCatalog, PersonSummary } from "../people/store";
import { withPhotoVisibility, type PhotoVisibility } from "../photo-visibility";
import { AlbumDialog, albumDates, albumRequest, CoverPicker, type CoverPickerState } from "./AlbumViews";
import type { Gallery } from "./Gallery";
import { Icon, IconButton } from "./Icons";
import { nf, type Points } from "./data";

const PAGE_SIZE = 80;
export const personName = (person: PersonSummary) => person.name ?? `Unnamed person ${person.id}`;
const photoCount = (count: number) => `${nf.format(count)} ${count === 1 ? "photo" : "photos"}`;
const peopleCount = (count: number) => `${nf.format(count)} ${count === 1 ? "person" : "people"}`;
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
        draggable={false}
        onError={(event) => {
          event.currentTarget.hidden = true;
        }}
      />
    </span>
  );
}

function PeopleCard({
  person,
  visibility,
  selected,
  disabled,
  onHold,
  onActivate,
}: {
  person: PersonSummary;
  visibility: PhotoVisibility;
  selected?: boolean;
  disabled: boolean;
  onHold?: () => void;
  onActivate(): void;
}) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const consumed = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => cancelPress, [onHold == null]);
  const selectable = onHold != null || selected !== undefined;

  return (
    <button
      className={selectable ? "album-card people-selectable" : "album-card"}
      disabled={disabled}
      aria-pressed={selected}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        consumed.current = false;
        if (!onHold) return;
        cancelPress();
        const { currentTarget: button, pointerId, clientX: x, clientY: y } = event;
        press.current = {
          x,
          y,
          timer: setTimeout(() => {
            consumed.current = true;
            press.current = null;
            button.setPointerCapture(pointerId);
            onHold();
          }, 500),
        };
      }}
      onPointerMove={(event) => {
        const start = press.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={selectable ? (event) => event.preventDefault() : undefined}
      onClick={(event) => {
        // The release of a long press already selected this card.
        if (event.detail && consumed.current) {
          consumed.current = false;
          return;
        }
        onActivate();
      }}
    >
      <Portrait person={person} visibility={visibility} />
      {selected !== undefined && (
        <span className="people-selection-check" aria-hidden>
          {selected && <Icon name="check" />}
        </span>
      )}
      <strong>{personName(person)}</strong>
      <span className="album-card-meta dim">{photoCount(person.count)}</span>
      {albumDates(person) && <span className="album-card-meta dim">{albumDates(person)}</span>}
    </button>
  );
}

/** "Is this …?" for an unnamed group that looks like a named person. */
function MatchQuestion({
  person,
  target,
  visibility,
  compact,
  onOpen,
  onAnswer,
}: {
  person: PersonSummary;
  target: PersonSummary;
  visibility: PhotoVisibility;
  compact?: boolean;
  onOpen?(): void;
  onAnswer(same: boolean): Promise<void>;
}) {
  const [busy, setBusy] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const answer = async (same: boolean) => {
    if (busy != null) return;
    setBusy(same);
    setError("");
    try {
      await onAnswer(same);
    } catch (problem) {
      setError((problem as Error).message);
      setBusy(null);
    }
  };
  return (
    <div className={compact ? "people-match people-match-compact" : "people-match"} aria-busy={busy != null}>
      {!compact && (
        <div className="people-match-faces">
          {onOpen ? (
            <button className="people-match-face" onClick={onOpen} title={`Open ${personName(person)}`}>
              <Portrait person={person} visibility={visibility} />
            </button>
          ) : (
            <Portrait person={person} visibility={visibility} />
          )}
          <Portrait person={target} visibility={visibility} />
        </div>
      )}
      <p>
        Is this <strong>{personName(target)}</strong>?
        {!compact && <span className="dim small people-match-count">{photoCount(person.count)}</span>}
      </p>
      <div className="row people-match-actions">
        <button className="btn btn-primary" disabled={busy != null} onClick={() => answer(true)}>
          {busy === true ? "Merging…" : "Yes"}
        </button>
        <button className="btn" disabled={busy != null} onClick={() => answer(false)}>
          {busy === false ? "Saving…" : "No"}
        </button>
      </div>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const SUGGESTIONS_PAGE = 8;

export function PeopleView({
  personId,
  hiddenOpen,
  person,
  membership,
  hasLocations,
  personError,
  visibility,
  points,
  revision,
  reload,
  onOpen,
  onOpenHidden,
  onBack,
  onMap,
  onMerged,
  renderGallery,
}: {
  personId: number | null;
  hiddenOpen: boolean;
  person: PersonSummary | undefined;
  membership: Uint8Array | null;
  hasLocations: boolean | null;
  personError: string;
  visibility: PhotoVisibility;
  points: Points | null;
  revision: number;
  reload(): void;
  onOpen(id: number): void;
  onOpenHidden(): void;
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
  const [search, setSearch] = useState({
    people: { query: "", limit: PAGE_SIZE },
    hidden: { query: "", limit: PAGE_SIZE },
  });
  const collection = hiddenOpen ? "hidden" : "people";
  const { query, limit } = search[collection];
  const [hideAction, setHideAction] = useState<{ id: number; busy: boolean; error: string } | null>(null);
  const hiding = hideAction?.id === personId ? hideAction : null;
  const activePerson = useRef(personId);
  useLayoutEffect(() => {
    activePerson.current = personId;
    return () => {
      activePerson.current = null;
    };
  }, [personId]);
  const [edit, setEdit] = useState<"name" | "merge" | null>(null);
  const [cover, setCover] = useState<Omit<CoverPickerState, "onSave" | "onCancel"> | null>(null);
  const [selectedPeople, setSelectedPeople] = useState<Set<number> | null>(null);
  const [bulkMerge, setBulkMerge] = useState<number[] | null>(null);
  const [bulkHiding, setBulkHiding] = useState(false);
  const [bulkFeedback, setBulkFeedback] = useState<{ text: string; error?: boolean } | null>(null);
  const [suggestionLimit, setSuggestionLimit] = useState(SUGGESTIONS_PAGE);
  const bulkEnabled = !hiddenOpen && personId == null;
  const selecting = bulkEnabled && selectedPeople != null;
  const selectedCount = selecting ? selectedPeople!.size : 0;

  useEffect(() => {
    if (!selecting || bulkMerge || bulkHiding) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target as HTMLElement)?.closest("input, dialog")) {
        setSelectedPeople(null);
        setBulkFeedback(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, bulkMerge, bulkHiding]);

  const bulkDone = (text: string) => {
    setBulkFeedback({ text });
    setSelectedPeople(new Set());
    reload();
  };

  const hideSelected = async () => {
    if (!selectedCount || !selectedPeople || bulkHiding) return;
    setBulkFeedback(null);
    setBulkHiding(true);
    try {
      await albumRequest(withPhotoVisibility("people/bulk", visibility), "POST", {
        ids: [...selectedPeople],
        target: null,
      });
      bulkDone(`Hidden ${peopleCount(selectedCount)}.`);
    } catch (error) {
      setBulkFeedback({ text: (error as Error).message, error: true });
    } finally {
      setBulkHiding(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    setCatalogError("");
    albumRequest<PeopleCatalog>(withPhotoVisibility("people", visibility), "GET", undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setCatalog(value);
        const available = new Set(value.people.filter((group) => group.name == null).map((group) => group.id));
        setSelectedPeople((selected) => {
          if (!selected || [...selected].every((id) => available.has(id))) return selected;
          return new Set([...selected].filter((id) => available.has(id)));
        });
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

  const toggleHidden = async () => {
    if (!person || hiding?.busy) return;
    const { id, hidden } = person;
    setHideAction({ id, busy: true, error: "" });
    try {
      await albumRequest(withPhotoVisibility(`people/${id}/hidden`, visibility), "PUT", { hidden: !hidden });
      // Let the catalog reload before showing either list again.
      setCatalog(null);
      reload();
      if (activePerson.current === id) onBack();
      setHideAction((action) => (action?.id === id ? null : action));
    } catch (error) {
      setHideAction((action) => (action?.id === id ? { id, busy: false, error: (error as Error).message } : action));
    }
  };

  const visiblePeople = useMemo(() => new Map(catalog?.people.map((entry) => [entry.id, entry])), [catalog]);
  const suggestions = useMemo(
    () =>
      (catalog?.suggestions ?? []).flatMap(({ id, target }) => {
        const unnamed = visiblePeople.get(id);
        const named = visiblePeople.get(target);
        return unnamed && named ? [{ person: unnamed, target: named }] : [];
      }),
    [catalog, visiblePeople],
  );
  const answerSuggestion = async (id: number, target: number, same: boolean) => {
    await albumRequest(withPhotoVisibility(`people/${id}/${same ? "merge" : "reject"}`, visibility), "POST", {
      target,
    });
    // Drop the question right away; the reload brings the updated groups and the next suggestions.
    setCatalog(
      (current) => current && { ...current, suggestions: current.suggestions.filter((entry) => entry.id !== id) },
    );
    reload();
  };
  const ownSuggestion = suggestions.find((entry) => entry.person.id === personId);

  const groups = hiddenOpen ? catalog?.hiddenPeople : catalog?.people;
  const matching = useMemo(() => groups?.filter((entry) => matches(entry, query)) ?? [], [groups, query]);
  const mergeTargets = person?.hidden ? catalog?.hiddenPeople : catalog?.people;
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
          <div className="album-title">
            {hiddenOpen && <IconButton name="back" label="All people" onClick={onBack} />}
            <div>
              <h1>{hiddenOpen ? "Hidden people" : "People"}</h1>
              {catalog && (
                <p className="dim">
                  {peopleCount(groups?.length ?? 0)}
                  {!hiddenOpen && (
                    <>
                      {" found · "}
                      {nf.format(catalog.scanned)} of {nf.format(catalog.total)} photos scanned
                      {!!catalog.failed && ` · ${nf.format(catalog.failed)} couldn’t be processed`}
                    </>
                  )}
                </p>
              )}
            </div>
          </div>
          <div className="people-tools">
            {!!groups?.length && (
              <input
                className="input"
                type="search"
                aria-label="Find a person"
                placeholder="Find a person"
                value={query}
                onChange={(event) => {
                  const query = event.target.value;
                  setSearch((current) => ({ ...current, [collection]: { query, limit: PAGE_SIZE } }));
                }}
              />
            )}
            <button className="btn" onClick={reload} title="Show people found since this page opened">
              Update list
            </button>
            {bulkEnabled && !selecting && !!catalog?.people.some((entry) => !entry.name) && (
              <button className="btn" onClick={() => setSelectedPeople(new Set())}>
                Select
              </button>
            )}
          </div>
        </header>
        {selecting && (
          <div className="people-bulk-bar" role="group" aria-label="People selection">
            <span role="status">
              {selectedCount ? `${peopleCount(selectedCount)} selected` : "Select unnamed groups"}
            </span>
            <button
              className="btn btn-primary"
              disabled={!selectedCount || bulkHiding}
              onClick={() => setBulkMerge([...(selectedPeople ?? [])])}
            >
              Merge…
            </button>
            <button className="btn" disabled={!selectedCount || bulkHiding} onClick={hideSelected}>
              {bulkHiding ? "Hiding…" : "Hide selected"}
            </button>
            <button
              className="btn"
              disabled={bulkHiding}
              onClick={() => {
                setSelectedPeople(null);
                setBulkFeedback(null);
              }}
            >
              Done
            </button>
            {bulkFeedback && (
              <span className={bulkFeedback.error ? "error" : "dim"} role={bulkFeedback.error ? "alert" : "status"}>
                {bulkFeedback.text}
              </span>
            )}
          </div>
        )}
        {issue || !catalog ? (
          status
        ) : (
          <>
            {!hiddenOpen && !selecting && !query && suggestions.length > 0 && (
              <section className="people-suggestions" aria-labelledby="people-suggestions-title">
                <h2 id="people-suggestions-title">
                  Possible matches <span className="dim">{nf.format(suggestions.length)}</span>
                </h2>
                <div className="people-suggestion-list">
                  {suggestions.slice(0, suggestionLimit).map(({ person: unnamed, target }) => (
                    <MatchQuestion
                      key={`${unnamed.id}:${target.id}`}
                      person={unnamed}
                      target={target}
                      visibility={visibility}
                      onOpen={() => onOpen(unnamed.id)}
                      onAnswer={(same) => answerSuggestion(unnamed.id, target.id, same)}
                    />
                  ))}
                </div>
                {suggestions.length > suggestionLimit && (
                  <button className="btn" onClick={() => setSuggestionLimit((value) => value + SUGGESTIONS_PAGE * 2)}>
                    Show more
                  </button>
                )}
              </section>
            )}
            {!matching.length && (
              <div className="empty">
                {query ? "No people match your search." : hiddenOpen ? "No hidden people yet." : "No face groups yet."}
              </div>
            )}
            <div className="album-cards people-cards">
              {matching.slice(0, limit).map((entry) => {
                const canSelect = bulkEnabled && entry.name == null;
                return (
                  <PeopleCard
                    key={entry.id}
                    person={entry}
                    visibility={visibility}
                    selected={selecting && canSelect ? selectedPeople!.has(entry.id) : undefined}
                    disabled={selecting && (!canSelect || bulkHiding)}
                    onHold={canSelect && !selecting ? () => setSelectedPeople(new Set([entry.id])) : undefined}
                    onActivate={() => {
                      if (!selecting) {
                        onOpen(entry.id);
                        return;
                      }
                      setBulkFeedback(null);
                      setSelectedPeople((current) => {
                        const updated = new Set(current);
                        if (updated.has(entry.id)) updated.delete(entry.id);
                        else updated.add(entry.id);
                        return updated;
                      });
                    }}
                  />
                );
              })}
              {!hiddenOpen && !selecting && (
                <button className="album-card" onClick={onOpenHidden}>
                  <span className="album-cover person-portrait">
                    <Icon name="eyeOff" />
                  </span>
                  <strong>Hidden people</strong>
                  <span className="album-card-meta dim">{peopleCount(catalog.hiddenPeople.length)}</span>
                </button>
              )}
            </div>
            {matching.length > limit && (
              <div className="people-more">
                <button
                  className="btn"
                  onClick={() =>
                    setSearch((current) => ({
                      ...current,
                      [collection]: { ...current[collection], limit: current[collection].limit + PAGE_SIZE },
                    }))
                  }
                >
                  Show more
                </button>
              </div>
            )}
          </>
        )}
        {bulkMerge && catalog && (
          <PersonDialog
            action="bulk-merge"
            ids={bulkMerge}
            people={[...catalog.people].sort(
              (a, b) =>
                Number(b.name != null) - Number(a.name != null) ||
                Number(bulkMerge.includes(b.id)) - Number(bulkMerge.includes(a.id)),
            )}
            visibility={visibility}
            onClose={() => setBulkMerge(null)}
            onSave={(target) => {
              const kept = catalog.people.find((entry) => entry.id === target);
              const moved = bulkMerge.length - Number(target != null && bulkMerge.includes(target));
              setBulkMerge(null);
              bulkDone(`Merged ${peopleCount(moved)} into ${kept ? personName(kept) : "the chosen group"}.`);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="album-detail" key={personId}>
      <header className="album-heading album-detail-heading">
        <div className="album-title">
          <IconButton name="back" label={person?.hidden ? "Hidden people" : "All people"} onClick={onBack} />
          {person && <Portrait key={person.coverId} person={person} visibility={visibility} />}
          <div>
            <h1>{person ? personName(person) : "Person"}</h1>
            {person && (
              <p className="dim">
                {photoCount(person.count)} · {albumDates(person)}
              </p>
            )}
            {ownSuggestion && !person?.hidden && (
              <MatchQuestion
                key={ownSuggestion.target.id}
                compact
                person={ownSuggestion.person}
                target={ownSuggestion.target}
                visibility={visibility}
                onAnswer={async (same) => {
                  await answerSuggestion(ownSuggestion.person.id, ownSuggestion.target.id, same);
                  if (same) onMerged(ownSuggestion.target.id);
                }}
              />
            )}
            {hiding?.error && (
              <p className="error" role="alert">
                {hiding.error}
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
              <button className="btn" onClick={() => setEdit("merge")} disabled={(mergeTargets?.length ?? 0) < 2}>
                Merge with…
              </button>
              <button className="btn" disabled={hiding?.busy} onClick={toggleHidden}>
                {person.hidden ? "Unhide person" : "Hide person"}
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
          people={mergeTargets ?? []}
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

function PersonDialog(
  props: {
    people: PersonSummary[];
    visibility: PhotoVisibility;
    onClose(): void;
    onSave(target: number | null): void;
  } & ({ action: "name" | "merge"; person: PersonSummary } | { action: "bulk-merge"; ids: number[] }),
) {
  const { action, people, visibility, onClose, onSave } = props;
  const person = action === "bulk-merge" ? null : props.person;
  const ids = action === "bulk-merge" ? props.ids : null;
  const [name, setName] = useState(person?.name ?? "");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PersonSummary | null>(null);
  const [limit, setLimit] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const merging = action !== "name";
  const candidates = merging
    ? people.filter(
        (entry) => entry.id !== person?.id && !(ids?.length === 1 && ids[0] === entry.id) && matches(entry, query),
      )
    : [];
  const title = merging ? "Merge people" : person?.name ? "Rename person" : "Add a name";
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
            const path = withPhotoVisibility(
              ids ? "people/bulk" : `people/${person!.id}${merging ? "/merge" : ""}`,
              visibility,
            );
            await albumRequest(path, merging ? "POST" : "PATCH", merging ? { target: selected!.id, ids } : { name });
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
            {ids && selected ? (
              <p role="status">
                Merge {peopleCount(ids.length - Number(ids.includes(selected.id)))} into{" "}
                <strong>{personName(selected)}</strong>.
              </p>
            ) : (
              selected &&
              person && (
                <p role="status">
                  Combine {personName(person)} and {personName(selected)} under{" "}
                  <strong>{selected.name ?? person.name ?? personName(selected)}</strong>.
                </p>
              )
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
