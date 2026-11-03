import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { hello } from "./api";
import { parsePairing, type Pairing } from "./pairing";
import { useTheme } from "./theme";

/** Scans the code in Photomap's Library → Phone sync and checks the server answers before accepting it. */
export function Scanner({ onPaired, onCancel }: { onPaired: (p: Pairing) => void; onCancel: () => void }) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // The camera keeps firing for the same code while we're still checking it.
  const busy = useRef(false);

  async function onScanned(data: string) {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const pairing = parsePairing(data);
      setConnecting(true);
      const server = await hello(pairing);
      onPaired({ ...pairing, name: server.name || pairing.name });
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "Couldn't reach Photomap. Make sure the phone is on the same wifi as the computer."
          : e instanceof Error
            ? e.message
            : String(e),
      );
      setConnecting(false);
      // Give the message a moment before the same code is scanned again.
      setTimeout(() => (busy.current = false), 1500);
    }
  }

  if (!permission) return <View style={{ flex: 1, backgroundColor: "#000" }} />;

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: theme.background }]}>
        <Text style={[styles.message, { color: theme.text }]}>The camera is only used to scan the pairing code.</Text>
        <Pressable
          style={[styles.button, { backgroundColor: theme.accent }]}
          onPress={() => (permission.canAskAgain ? requestPermission() : Linking.openSettings())}
        >
          <Text style={[styles.buttonText, { color: theme.accentText }]}>
            {permission.canAskAgain ? "Allow camera" : "Open settings"}
          </Text>
        </Pressable>
        <Pressable onPress={onCancel} hitSlop={12}>
          <Text style={[styles.link, { color: theme.muted }]}>Cancel</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => onScanned(data)}
      />
      <SafeAreaView style={styles.overlay}>
        <Text style={styles.hint}>
          Open Photomap on your computer, go to Library → Phone sync, and point the camera at the code.
        </Text>
        <View style={styles.frame} />
        <View style={styles.footer}>
          {connecting ? <ActivityIndicator color="#fff" /> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable onPress={onCancel} hitSlop={12}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 20, padding: 32 },
  message: { fontSize: 16, textAlign: "center", lineHeight: 22 },
  button: { paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12 },
  buttonText: { fontSize: 16, fontWeight: "600" },
  link: { fontSize: 15 },
  overlay: { flex: 1, alignItems: "center", justifyContent: "space-between", padding: 24 },
  hint: { color: "#fff", fontSize: 16, textAlign: "center", lineHeight: 22, marginTop: 16 },
  frame: { width: 240, height: 240, borderRadius: 20, borderWidth: 3, borderColor: "rgba(255,255,255,0.85)" },
  footer: { alignItems: "center", gap: 14, marginBottom: 16 },
  error: {
    color: "#fff",
    backgroundColor: "rgba(194,59,48,0.92)",
    padding: 12,
    borderRadius: 10,
    textAlign: "center",
    overflow: "hidden",
  },
  cancel: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
