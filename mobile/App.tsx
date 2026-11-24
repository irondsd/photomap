import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Pairing } from "./src/pairing";
import { Home } from "./src/Home";
import { Scanner } from "./src/Scanner";
import { loadPairing, savePairing } from "./src/settings";
import { radius, useTheme } from "./src/theme";

type Screen =
  | { kind: "loading" }
  | { kind: "welcome" }
  /** `previous` is the pairing to go back to if scanning a new code is cancelled. */
  | { kind: "scanning"; previous: Pairing | null }
  | { kind: "paired"; pairing: Pairing };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  useEffect(() => {
    loadPairing()
      .then((pairing) => setScreen(pairing ? { kind: "paired", pairing } : { kind: "welcome" }))
      .catch(() => setScreen({ kind: "welcome" }));
  }, []);

  async function paired(pairing: Pairing) {
    await savePairing(pairing);
    setScreen({ kind: "paired", pairing });
  }

  async function unpair() {
    await savePairing(null);
    setScreen({ kind: "welcome" });
  }

  return (
    <SafeAreaProvider>
      {/* Home sets its own, to match the web app's bars. */}
      {screen.kind === "paired" ? null : <StatusBar style={screen.kind === "scanning" ? "light" : "auto"} />}
      {screen.kind === "loading" ? null : screen.kind === "scanning" ? (
        <Scanner
          onPaired={paired}
          onCancel={() =>
            setScreen(screen.previous ? { kind: "paired", pairing: screen.previous } : { kind: "welcome" })
          }
        />
      ) : screen.kind === "paired" ? (
        <Home
          pairing={screen.pairing}
          onUnpair={unpair}
          onRescan={() => setScreen({ kind: "scanning", previous: screen.pairing })}
        />
      ) : (
        <Welcome onScan={() => setScreen({ kind: "scanning", previous: null })} />
      )}
    </SafeAreaProvider>
  );
}

function Welcome({ onScan }: { onScan: () => void }) {
  const theme = useTheme();
  return (
    <SafeAreaView style={[styles.welcome, { backgroundColor: theme.background }]}>
      <View style={styles.copy}>
        <Image source={require("./assets/splash-icon.png")} style={styles.logo} accessibilityIgnoresInvertColors />
        <Text style={[styles.title, { color: theme.text }]}>Photomap</Text>
        <Text style={[styles.body, { color: theme.muted }]}>
          Your Photomap library on this phone, over wifi. Photos and videos you take sync to it by themselves, with
          their locations intact.
        </Text>
        <Text style={[styles.body, { color: theme.muted }]}>
          To pair, open Photomap on your computer and go to Library → Phone sync.
        </Text>
      </View>
      <Pressable style={[styles.button, { backgroundColor: theme.accent }]} onPress={onScan}>
        <Text style={[styles.buttonText, { color: theme.accentText }]}>Scan pairing code</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  welcome: { flex: 1, padding: 24, justifyContent: "space-between" },
  copy: { flex: 1, justifyContent: "center", gap: 14 },
  // The pin fills the middle 45% of the image: pull it back so it lines up with the text.
  logo: { width: 96, height: 96, marginLeft: -26, marginBottom: -8 },
  title: { fontSize: 28, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 23 },
  button: { borderRadius: radius.control, paddingVertical: 15, alignItems: "center" },
  buttonText: { fontSize: 17, fontWeight: "600" },
});
