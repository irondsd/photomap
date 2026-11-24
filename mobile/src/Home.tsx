import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { webLink } from "./api";
import { injectedBeforeLoad, parseWebMessage, stateScript, type AppSyncState } from "./bridge";
import { host, probe, type Connection } from "./connection";
import type { Pairing } from "./pairing";
import { SYNC_RANGES } from "./settings";
import { radius, useTheme, type Theme } from "./theme";
import { useSync } from "./useSync";

// The typings default WebView's extra props to `undefined`, which TypeScript now intersects to `never`.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
const PageView = WebView<{}>;
type PageView = WebView<{}>;

/** The web app's `--panel`: its top bar and tab bar, which the system bars sit against. */
const BAR = { light: "#ffffff", dark: "#1b1b1b" };

/**
 * The paired phone's home: the Photomap web app once the computer answers, a "can't reach it"
 * screen when it doesn't. Syncs by itself on opening and on coming back to the app.
 */
export function Home({
  pairing,
  onUnpair,
  onRescan,
}: {
  pairing: Pairing;
  onUnpair: () => void;
  onRescan: () => void;
}) {
  const [connection, setConnection] = useState<Connection>({ state: "checking" });
  /** The one-time sign-in link the WebView opens with; null until the computer answers. */
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const latest = useRef(0);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  const sync = useSync(pairing, () => void connect(true));
  const runningRef = useRef(sync.state.running);
  runningRef.current = sync.state.running;
  const startSync = sync.start;

  /**
   * Checks the computer is there. A `quiet` check (the web app is already showing) keeps it on
   * screen while it asks, and only swaps it out if the computer has gone.
   */
  const connect = useCallback(
    async (quiet: boolean) => {
      const id = ++latest.current;
      if (!quiet) setConnection({ state: "checking" });
      const next = await probe(pairing);
      if (id !== latest.current) return;
      if (next.state !== "online") {
        setConnection(next);
        setWebUrl(null);
        return;
      }
      if (!quiet || connectionRef.current.state !== "online") {
        try {
          const url = await webLink(pairing);
          if (id !== latest.current) return;
          setWebUrl(url);
        } catch (e) {
          if (id === latest.current) {
            setConnection({ state: "offline", reason: e instanceof Error ? e.message : String(e) });
          }
          return;
        }
      }
      setConnection(next);
      startSync(true);
    },
    [pairing, startSync],
  );

  useEffect(() => {
    void connect(false);
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active" || runningRef.current) return;
      void connect(connectionRef.current.state === "online");
    });
    return () => sub.remove();
  }, [connect]);

  if (connection.state === "online" && webUrl) {
    return (
      <WebShell
        pairing={pairing}
        url={webUrl}
        state={{
          server: connection.name,
          host: host(pairing.url),
          ranges: SYNC_RANGES.map(({ id, label }) => ({ id, label })),
          ...sync.state,
        }}
        onSync={() => sync.start(false)}
        onStop={sync.stop}
        onRange={sync.setRange}
        onRescan={onRescan}
        onUnpair={() => confirmUnpair(pairing, onUnpair)}
        onLost={() => void connect(false)}
        onExpired={async () => {
          try {
            setWebUrl(await webLink(pairing));
          } catch {
            void connect(false);
          }
        }}
      />
    );
  }

  return <Status connection={connection} pairing={pairing} onRetry={() => connect(false)} onRescan={onRescan} />;
}

function confirmUnpair(pairing: Pairing, onUnpair: () => void) {
  Alert.alert("Unpair this phone?", `It will stop syncing to ${pairing.name} until you scan the code again.`, [
    { text: "Cancel", style: "cancel" },
    { text: "Unpair", style: "destructive", onPress: onUnpair },
  ]);
}

function WebShell({
  pairing,
  url,
  state,
  onSync,
  onStop,
  onRange,
  onRescan,
  onUnpair,
  onLost,
  onExpired,
}: {
  pairing: Pairing;
  url: string;
  state: AppSyncState;
  onSync(): void;
  onStop(): void;
  onRange(id: string): void;
  onRescan(): void;
  onUnpair(): void;
  /** The page couldn't load at all: the computer has probably gone to sleep. */
  onLost(): void;
  /** The computer refused the page: the sign-in link expired before it was used. */
  onExpired(): void;
}) {
  const web = useRef<PageView>(null);
  const system = useColorScheme();
  const [dark, setDark] = useState(system === "dark");
  const [loaded, setLoaded] = useState(false);
  const canGoBack = useRef(false);
  const retried = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const json = JSON.stringify(state);

  // Every change goes to the page whole; it's small, and the page then never has to catch up.
  useEffect(() => {
    web.current?.injectJavaScript(stateScript(stateRef.current));
  }, [json]);

  // Android's back button walks back through the web app (closing a photo, the library…) before leaving.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!canGoBack.current) return false;
      web.current?.goBack();
      return true;
    });
    return () => sub.remove();
  }, []);

  function onMessage(e: WebViewMessageEvent) {
    const msg = parseWebMessage(e.nativeEvent.data);
    switch (msg?.type) {
      case "ready":
        web.current?.injectJavaScript(stateScript(stateRef.current));
        break;
      case "sync":
        onSync();
        break;
      case "stop":
        onStop();
        break;
      case "range":
        onRange(msg.id);
        break;
      case "settings":
        void Linking.openSettings();
        break;
      case "rescan":
        onRescan();
        break;
      case "unpair":
        onUnpair();
        break;
      case "theme":
        setDark(msg.dark);
        break;
    }
  }

  const bar = dark ? BAR.dark : BAR.light;
  const theme = useTheme();

  return (
    // Edge to edge: the page pads itself for the system bars with env(safe-area-inset-*), which the
    // WebView reports, so padding here as well would leave a gap above and below it.
    <View style={[styles.fill, { backgroundColor: bar }]}>
      <StatusBar style={dark ? "light" : "dark"} />
      <PageView
        ref={web}
        source={{ uri: url }}
        style={[styles.fill, { backgroundColor: bar }]}
        injectedJavaScriptBeforeContentLoaded={injectedBeforeLoad}
        onMessage={onMessage}
        onNavigationStateChange={(nav) => {
          canGoBack.current = nav.canGoBack;
        }}
        onShouldStartLoadWithRequest={(req) => {
          // Links out of Photomap (a map's attribution, say) open in the browser instead.
          if (req.isTopFrame === false || req.url.startsWith(pairing.url) || !/^https?:/.test(req.url)) return true;
          void Linking.openURL(req.url);
          return false;
        }}
        onLoadEnd={() => setLoaded(true)}
        onError={onLost}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode !== 401 || retried.current) return;
          retried.current = true;
          onExpired();
        }}
        onRenderProcessGone={() => web.current?.reload()}
        domStorageEnabled
        javaScriptEnabled
        allowsInlineMediaPlayback
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction={false}
        setSupportMultipleWindows={false}
        overScrollMode="never"
        // The page sets its own sizes; the system font scale would only break its layout.
        textZoom={100}
        webviewDebuggingEnabled={__DEV__}
      />
      {!loaded ? (
        <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: theme.background }]}>
          <ActivityIndicator color={theme.muted} />
        </View>
      ) : null}
    </View>
  );
}

/** Shown while connecting, and when the computer can't be reached or no longer accepts this phone. */
function Status({
  connection,
  pairing,
  onRetry,
  onRescan,
}: {
  connection: Connection;
  pairing: Pairing;
  onRetry(): void;
  onRescan(): void;
}) {
  const theme = useTheme();
  const s = makeStyles(theme);

  if (connection.state === "checking" || connection.state === "online") {
    return (
      <SafeAreaView style={[s.screen, styles.center]}>
        <StatusBar style="auto" />
        <Image source={require("../assets/splash-icon.png")} style={s.logo} accessibilityIgnoresInvertColors />
        <ActivityIndicator color={theme.muted} />
        <Text style={s.help}>Connecting to {pairing.name}…</Text>
      </SafeAreaView>
    );
  }

  const unpaired = connection.state === "unpaired";
  return (
    <SafeAreaView style={s.screen}>
      <StatusBar style="auto" />
      <View style={s.copy}>
        <Image source={require("../assets/splash-icon.png")} style={s.logoStart} accessibilityIgnoresInvertColors />
        <Text style={s.title}>
          {unpaired ? `${pairing.name} no longer accepts this phone` : `Can't reach ${pairing.name}`}
        </Text>
        <Text style={s.body}>
          {unpaired
            ? "The phones were unpaired in Photomap. Scan the new code in Library → Phone sync."
            : "It's probably asleep. Wake it and try again."}
        </Text>
        {!unpaired ? (
          <Text style={s.help}>
            {connection.reason} If it's awake, check the phone is on the same wifi and that Accept phones on this
            network is ticked in Photomap's Library → Phone sync.
          </Text>
        ) : null}
      </View>
      {unpaired ? (
        <Pressable style={s.button} onPress={onRescan}>
          <Text style={s.buttonText}>Scan new code</Text>
        </Pressable>
      ) : (
        <>
          <Pressable style={s.button} onPress={onRetry}>
            <Text style={s.buttonText}>Try again</Text>
          </Pressable>
          <Pressable style={s.secondary} onPress={onRescan} hitSlop={8}>
            <Text style={s.link}>Scan new code</Text>
          </Pressable>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center", gap: 14 },
});

function makeStyles(t: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, padding: 24, backgroundColor: t.background },
    copy: { flex: 1, justifyContent: "center", gap: 14 },
    logo: { width: 96, height: 96 },
    // The pin fills the middle 45% of the image: pull it back so it lines up with the text.
    logoStart: { width: 96, height: 96, marginLeft: -26, marginBottom: -8 },
    title: { fontSize: 26, fontWeight: "600", color: t.text },
    body: { fontSize: 16, lineHeight: 23, color: t.text },
    help: { fontSize: 14, lineHeight: 20, color: t.muted },
    button: { backgroundColor: t.accent, borderRadius: radius.control, paddingVertical: 15, alignItems: "center" },
    buttonText: { fontSize: 17, fontWeight: "600", color: t.accentText },
    secondary: { alignItems: "center", paddingTop: 14 },
    link: { fontSize: 15, color: t.accentInk, fontWeight: "600" },
  });
}
