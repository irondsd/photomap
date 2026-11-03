import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { check } from "./api";
import { host, type Connection } from "./connection";
import { formatBytes, plural } from "./format";
import { listSince, requestLibraryAccess } from "./library";
import type { Pairing } from "./pairing";
import { loadSyncRange, rangeStart, saveSyncRange, SYNC_RANGES, type SyncRangeId } from "./settings";
import { runSync, type SyncProgress, type SyncResult } from "./sync";
import { useTheme, type Theme } from "./theme";
import { uploadItem } from "./transfer";
import { useConnection } from "./useConnection";

const KEEP_AWAKE = "sync";

export function SyncScreen({
  pairing,
  onUnpair,
  onRescan,
}: {
  pairing: Pairing;
  onUnpair: () => void;
  /** Scan a new code, e.g. after the Mac's address changed. Cancelling comes back here. */
  onRescan: () => void;
}) {
  const theme = useTheme();
  const [range, setRange] = useState<SyncRangeId>("30d");
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [notice, setNotice] = useState<{ text: string; settings?: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const [connection, recheck] = useConnection(pairing, running);

  useEffect(() => {
    loadSyncRange().then(setRange);
  }, []);

  function pickRange(id: SyncRangeId) {
    setRange(id);
    saveSyncRange(id);
  }

  async function sync() {
    if (running) return;
    setRunning(true);
    setNotice(null);
    setResult(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const access = await requestLibraryAccess();
      if (access === "denied") {
        setNotice({
          text: "Photomap Sync needs access to your photos and videos. Tap to open Settings.",
          settings: true,
        });
        return;
      }
      if (access === "limited") setNotice({ text: "You've allowed only some photos, so only those will sync." });

      setProgress({ phase: "checking", scanned: 0, missing: 0 });
      await activateKeepAwakeAsync(KEEP_AWAKE);
      const since = rangeStart(range);
      const res = await runSync(
        {
          listPage: (offset, limit) => listSince(since, offset, limit),
          check: (items) => check(pairing, items),
          upload: (item, onBytes, signal) => uploadItem(pairing, item, onBytes, signal),
        },
        { onProgress: setProgress, signal: controller.signal },
      );
      setResult(res);
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : String(e) });
    } finally {
      abort.current = null;
      setProgress(null);
      setRunning(false);
      deactivateKeepAwake(KEEP_AWAKE);
    }
  }

  // A sync that stopped early may have lost the Mac; check again once it's over.
  useEffect(() => {
    if (!running && result?.stopped) recheck();
  }, [running, result, recheck]);

  function confirmUnpair() {
    Alert.alert("Unpair this phone?", `It will stop syncing to ${pairing.name} until you scan the code again.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Unpair", style: "destructive", onPress: onUnpair },
    ]);
  }

  const s = makeStyles(theme);

  return (
    <SafeAreaView style={s.screen}>
      <ScrollView contentContainerStyle={s.content}>
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Photomap Sync</Text>
            <ConnectionLine connection={connection} pairing={pairing} theme={theme} />
          </View>
          {!running ? (
            <Pressable onPress={confirmUnpair} hitSlop={12}>
              <Text style={s.link}>Unpair</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={s.card}>
          <Text style={s.label}>Sync photos and videos from the last</Text>
          <View style={s.chips}>
            {SYNC_RANGES.map((r) => (
              <Pressable
                key={r.id}
                disabled={running}
                onPress={() => pickRange(r.id)}
                style={[s.chip, r.id === range && s.chipActive, running && s.disabled]}
              >
                <Text style={[s.chipText, r.id === range && s.chipTextActive]}>{r.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.help}>Files already in Photomap are skipped, so a longer range is safe.</Text>
        </View>

        {!running && connection.state === "offline" ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>{connection.reason}</Text>
            <Text style={s.help}>
              If the Mac is asleep, wake it and tap Try again. Check that the phone is on the same wifi, and that Accept
              phones on this network is ticked in Photomap's Library. If the Mac's address changed, scan the code again.
            </Text>
          </View>
        ) : null}
        {!running && connection.state === "unpaired" ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>{pairing.name} no longer accepts this phone</Text>
            <Text style={s.help}>The phones were unpaired in Photomap. Scan the new code in Library → Phone sync.</Text>
          </View>
        ) : null}
        {progress ? <ProgressCard progress={progress} theme={theme} /> : null}
        {result && !progress ? <ResultCard result={result} theme={theme} /> : null}
        {notice ? (
          <Pressable disabled={!notice.settings} onPress={() => Linking.openSettings()}>
            <Text style={s.notice}>{notice.text}</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <View style={s.bottom}>
        {running ? (
          <Pressable style={[s.button, s.buttonSecondary]} onPress={() => abort.current?.abort()}>
            <Text style={[s.buttonText, { color: theme.text }]}>Stop</Text>
          </Pressable>
        ) : connection.state === "online" ? (
          <Pressable style={s.button} onPress={sync}>
            <Text style={s.buttonText}>Sync now</Text>
          </Pressable>
        ) : connection.state === "checking" ? (
          <View style={[s.button, s.buttonSecondary, s.row]}>
            <ActivityIndicator color={theme.muted} />
            <Text style={[s.buttonText, { color: theme.muted }]}>Connecting…</Text>
          </View>
        ) : connection.state === "offline" ? (
          <>
            <Pressable style={s.button} onPress={recheck}>
              <Text style={s.buttonText}>Try again</Text>
            </Pressable>
            <Pressable style={s.secondaryAction} onPress={onRescan} hitSlop={8}>
              <Text style={s.link}>Scan new code</Text>
            </Pressable>
          </>
        ) : (
          <Pressable style={s.button} onPress={onRescan}>
            <Text style={s.buttonText}>Scan new code</Text>
          </Pressable>
        )}
      </View>
    </SafeAreaView>
  );
}

function ConnectionLine({ connection, pairing, theme }: { connection: Connection; pairing: Pairing; theme: Theme }) {
  const s = makeStyles(theme);
  const [color, text] =
    connection.state === "online"
      ? [theme.ok, `Connected to ${connection.name}`]
      : connection.state === "checking"
        ? [theme.muted, `Connecting to ${pairing.name}…`]
        : connection.state === "offline"
          ? [theme.danger, `${pairing.name} isn't answering`]
          : [theme.danger, "Not paired"];
  return (
    <View style={[s.row, { marginTop: 2 }]}>
      <View style={[s.dot, { backgroundColor: color }]} />
      <Text style={s.subtitle} numberOfLines={1}>
        {text} · {host(pairing.url)}
      </Text>
    </View>
  );
}

function ProgressCard({ progress, theme }: { progress: SyncProgress; theme: Theme }) {
  const s = makeStyles(theme);
  if (progress.phase === "checking") {
    return (
      <View style={s.card}>
        <Text style={s.cardTitle}>Checking what Photomap already has…</Text>
        <Text style={s.help}>
          {plural(progress.scanned, "file")} checked, {progress.missing.toLocaleString()} to send
        </Text>
      </View>
    );
  }
  const fileShare = progress.bytesTotal > 0 ? progress.bytesSent / progress.bytesTotal : 0;
  const overall = progress.total > 0 ? (progress.done + fileShare) / progress.total : 1;
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>
        Sending {Math.min(progress.done + 1, progress.total).toLocaleString()} of {progress.total.toLocaleString()}
      </Text>
      <View style={s.track}>
        <View style={[s.bar, { width: `${Math.round(overall * 100)}%` }]} />
      </View>
      {progress.current ? (
        <Text style={s.help} numberOfLines={1}>
          {progress.current}
          {progress.bytesTotal > 0
            ? ` · ${formatBytes(progress.bytesSent)} of ${formatBytes(progress.bytesTotal)}`
            : ""}
        </Text>
      ) : null}
      {progress.failed > 0 ? <Text style={s.error}>{plural(progress.failed, "file")} failed so far</Text> : null}
    </View>
  );
}

function ResultCard({ result, theme }: { result: SyncResult; theme: Theme }) {
  const s = makeStyles(theme);
  const headline = result.cancelled
    ? "Stopped"
    : result.stopped
      ? "Sync didn't finish"
      : result.uploaded === 0 && result.failed.length === 0
        ? "Everything is already in Photomap"
        : "Sync finished";
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{headline}</Text>
      <Text style={s.help}>
        {plural(result.uploaded, "file")} sent, {result.present.toLocaleString()} already there
        {result.scanned > 0 ? ` (${plural(result.scanned, "file")} checked)` : ""}
      </Text>
      {result.stopped ? <Text style={s.error}>{result.stopped}</Text> : null}
      {result.failed.length > 0 ? (
        <View style={{ gap: 4, marginTop: 4 }}>
          <Text style={s.error}>{plural(result.failed.length, "file")} failed. Sync again to retry them.</Text>
          {result.failed.slice(0, 5).map((f) => (
            <Text key={f.filename} style={s.help} numberOfLines={2}>
              {f.filename}: {f.error}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.background },
    content: { padding: 20, gap: 16 },
    header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
    title: { fontSize: 26, fontWeight: "700", color: t.text },
    subtitle: { fontSize: 14, color: t.muted, flexShrink: 1 },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    secondaryAction: { alignItems: "center", paddingTop: 14 },
    link: { fontSize: 15, color: t.accent, fontWeight: "500" },
    card: {
      backgroundColor: t.surface,
      borderRadius: 16,
      padding: 16,
      gap: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.border,
    },
    cardTitle: { fontSize: 17, fontWeight: "600", color: t.text },
    label: { fontSize: 15, color: t.text, fontWeight: "500" },
    help: { fontSize: 14, color: t.muted, lineHeight: 19 },
    error: { fontSize: 14, color: t.danger, lineHeight: 19 },
    notice: { fontSize: 14, color: t.muted, lineHeight: 19, paddingHorizontal: 4 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: t.border,
    },
    chipActive: { backgroundColor: t.accent, borderColor: t.accent },
    chipText: { fontSize: 14, color: t.text },
    chipTextActive: { color: t.accentText, fontWeight: "600" },
    disabled: { opacity: 0.5 },
    track: { height: 8, borderRadius: 4, backgroundColor: t.progressTrack, overflow: "hidden" },
    bar: { height: 8, borderRadius: 4, backgroundColor: t.accent },
    bottom: { padding: 20, paddingTop: 8 },
    button: { backgroundColor: t.accent, borderRadius: 14, paddingVertical: 16, alignItems: "center" },
    buttonSecondary: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border },
    buttonText: { fontSize: 17, fontWeight: "600", color: t.accentText },
  });
}
