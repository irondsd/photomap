import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect, useRef, useState } from "react";
import { check } from "./api";
import type { SyncNotice } from "./bridge";
import { listSince, requestLibraryAccess } from "./library";
import type { Pairing } from "./pairing";
import { loadSyncRange, rangeStart, saveSyncRange, SYNC_RANGES, type SyncRangeId } from "./settings";
import { runSync, type SyncProgress, type SyncResult } from "./sync";
import { uploadItem } from "./transfer";

const KEEP_AWAKE = "sync";

/** Coming back to the app within this long of the last run doesn't start another by itself. */
export const AUTO_SYNC_GAP_MS = 60_000;

export type SyncState = {
  range: SyncRangeId;
  running: boolean;
  auto: boolean;
  run: number;
  progress: SyncProgress | null;
  result: SyncResult | null;
  notice: SyncNotice | null;
  finishedAt: number | null;
};

export type SyncController = {
  state: SyncState;
  /** Starts a run unless one is going. `auto` runs also skip if the last one just ended. */
  start(auto: boolean): void;
  stop(): void;
  setRange(id: string): void;
};

/** Runs syncs to the paired computer and keeps what the UI needs to show about them. */
export function useSync(pairing: Pairing, onStopped: (result: SyncResult) => void): SyncController {
  const [state, setState] = useState<SyncState>({
    range: "30d",
    running: false,
    auto: false,
    run: 0,
    progress: null,
    result: null,
    notice: null,
    finishedAt: null,
  });
  const latest = useRef(state);
  latest.current = state;
  const abort = useRef<AbortController | null>(null);
  /** When the last run ended, kept outside state so a start right after it already sees it. */
  const finished = useRef<number | null>(null);
  const loaded = useRef<Promise<void> | null>(null);
  const stopped = useRef(onStopped);
  stopped.current = onStopped;

  if (!loaded.current) {
    loaded.current = loadSyncRange().then((range) => setState((s) => ({ ...s, range })));
  }

  const update = (patch: Partial<SyncState>) => setState((s) => ({ ...s, ...patch }));

  const start = useCallback(
    async (auto: boolean) => {
      // Set synchronously below, so two quick calls can't both start.
      if (abort.current) return;
      if (auto && finished.current !== null && Date.now() - finished.current < AUTO_SYNC_GAP_MS) return;
      const controller = new AbortController();
      abort.current = controller;
      await loaded.current;
      update({
        running: true,
        auto,
        run: latest.current.run + 1,
        progress: { phase: "checking", scanned: 0, missing: 0 },
        result: null,
        notice: null,
      });
      let result: SyncResult | null = null;
      try {
        const access = await requestLibraryAccess();
        if (access === "denied") {
          update({
            notice: { text: "Photomap needs access to your photos and videos to sync them.", settings: true },
          });
          return;
        }
        if (access === "limited") update({ notice: { text: "You've allowed only some photos, so only those sync." } });
        await activateKeepAwakeAsync(KEEP_AWAKE).catch(() => {});
        const since = rangeStart(latest.current.range);
        result = await runSync(
          {
            listPage: (offset, limit) => listSince(since, offset, limit),
            check: (items) => check(pairing, items),
            upload: (item, onBytes, signal) => uploadItem(pairing, item, onBytes, signal),
          },
          { onProgress: (progress) => update({ progress }), signal: controller.signal },
        );
        update({ result });
      } catch (e) {
        update({ notice: { text: e instanceof Error ? e.message : String(e) } });
      } finally {
        abort.current = null;
        finished.current = Date.now();
        update({ running: false, progress: null, finishedAt: finished.current });
        deactivateKeepAwake(KEEP_AWAKE);
        if (result?.stopped) stopped.current(result);
      }
    },
    [pairing],
  );

  const stop = useCallback(() => abort.current?.abort(), []);

  const setRange = useCallback((id: string) => {
    const range = SYNC_RANGES.find((r) => r.id === id)?.id;
    if (!range || abort.current) return;
    update({ range });
    void saveSyncRange(range);
  }, []);

  // Unmounting (unpairing, going offline) ends a run rather than leaving it uploading unseen.
  useEffect(() => () => abort.current?.abort(), []);

  const startNow = useCallback((auto: boolean) => void start(auto), [start]);
  return { state, start: startNow, stop, setRange };
}
