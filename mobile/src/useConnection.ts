import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { probe, type Connection } from "./connection";
import type { Pairing } from "./pairing";

/**
 * Whether the paired Mac answers, checked on open and each time the app comes back to the
 * foreground. While `paused` (a sync is running) it keeps its last answer.
 */
export function useConnection(pairing: Pairing, paused: boolean): [Connection, () => void] {
  const [connection, setConnection] = useState<Connection>({ state: "checking" });
  const latest = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const check = useCallback(() => {
    if (pausedRef.current) return;
    // Only the newest check may update the state; an older one can finish after it.
    const id = ++latest.current;
    setConnection({ state: "checking" });
    probe(pairing).then((c) => {
      if (id === latest.current) setConnection(c);
    });
  }, [pairing]);

  useEffect(() => {
    check();
    const sub = AppState.addEventListener("change", (s) => s === "active" && check());
    return () => sub.remove();
  }, [check]);

  return [connection, check];
}
