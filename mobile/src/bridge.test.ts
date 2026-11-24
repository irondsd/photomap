import { expect, test } from "bun:test";
import { parseWebMessage, stateScript, type AppSyncState } from "./bridge";

const state: AppSyncState = {
  server: "MacBook",
  host: "192.168.1.20:4747",
  ranges: [{ id: "30d", label: "30 days" }],
  range: "30d",
  running: true,
  auto: true,
  run: 1,
  progress: { phase: "checking", scanned: 0, missing: 0 },
  result: null,
  notice: { text: "odd name </script>" },
  finishedAt: null,
};

test("the state script hands the page the state and tells it", () => {
  const events: string[] = [];
  const window = {
    photomapApp: { version: 1 } as { version: number; state?: AppSyncState },
    dispatchEvent: (e: Event) => events.push(e.type),
  };
  new Function("window", stateScript(state))(window);
  expect(window.photomapApp.state).toEqual(state);
  expect(events).toEqual(["photomap-app-state"]);
});

test("the state script does nothing on a page that isn't listening", () => {
  expect(() => new Function("window", stateScript(state))({})).not.toThrow();
});

test("messages from the page", () => {
  expect(parseWebMessage('{"type":"range","id":"7d"}')).toEqual({ type: "range", id: "7d" });
  expect(parseWebMessage("not json")).toBeNull();
  expect(parseWebMessage('{"no":"type"}')).toBeNull();
});
