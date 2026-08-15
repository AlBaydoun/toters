import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ScrollView } from "react-native";
import { api, ApiError } from "../lib/api";
import type { ScreenProps } from "../lib/navigation";

const theme = {
  bg: "#14201B", surface: "#1D2C26", text: "#F4F7F5",
  muted: "#93A39C", accent: "#3FBF8F", danger: "#E06B52",
};

/**
 * The active delivery. The courier drives the order forward from here.
 *
 * The completion button refuses to finish an age-restricted order without a
 * recorded ID check — the API enforces the same rule, but blocking it in the UI
 * means the courier finds out before they've handed over the goods rather than
 * after.
 */
export function DeliveryScreen({ route, navigation }: ScreenProps<"Delivery">) {
  const { orderId } = route.params;
  const [status, setStatus] = useState("AWAITING_COURIER");
  const [requiredAge] = useState<number | null>(null);
  const [ageVerified, setAgeVerified] = useState(false);
  const [busy, setBusy] = useState(false);

  async function advance(to: string) {
    setBusy(true);
    try {
      const result = await api.transition(orderId, to);
      setStatus(result.status);
      if (to === "DELIVERED") {
        Alert.alert("Geliefert", "Gut gemacht.");
        navigation.replace("Shift");
      }
    } catch (e) {
      Alert.alert("Nicht möglich", e instanceof ApiError ? e.message : "Unbekannter Fehler");
    } finally {
      setBusy(false);
    }
  }

  function completeDelivery() {
    if (requiredAge != null && !ageVerified) {
      navigation.navigate("AgeCheck", { orderId, requiredAge });
      return;
    }
    void advance("DELIVERED");
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Aktuelle Lieferung</Text>
      <Text style={styles.status}>{status}</Text>

      {requiredAge != null ? (
        <Pressable
          style={[styles.ageBanner, ageVerified && styles.ageBannerDone]}
          onPress={() => navigation.navigate("AgeCheck", { orderId, requiredAge })}
        >
          <Text style={styles.ageText}>
            {ageVerified
              ? "Altersnachweis erfasst"
              : `Ausweiskontrolle erforderlich — ab ${requiredAge}`}
          </Text>
        </Pressable>
      ) : null}

      {status === "AWAITING_COURIER" ? (
        <Pressable style={styles.button} onPress={() => advance("OUT_FOR_DELIVERY")} disabled={busy}>
          <Text style={styles.buttonText}>Abgeholt — losfahren</Text>
        </Pressable>
      ) : null}

      {status === "OUT_FOR_DELIVERY" ? (
        <Pressable style={styles.button} onPress={completeDelivery} disabled={busy}>
          <Text style={styles.buttonText}>Übergeben</Text>
        </Pressable>
      ) : null}

      <Text style={styles.hint}>
        Ist ein Artikel nicht verfügbar, schlage einen Ersatz vor. Der Kunde muss zustimmen —
        ohne Zustimmung wird der Artikel entfernt und erstattet.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 20, gap: 16 },
  heading: { color: theme.text, fontSize: 24, fontWeight: "700" },
  status: { color: theme.muted, fontSize: 14 },
  ageBanner: { backgroundColor: theme.danger, borderRadius: 12, padding: 16 },
  ageBannerDone: { backgroundColor: theme.surface },
  ageText: { color: theme.text, fontSize: 15, fontWeight: "600" },
  button: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 18, alignItems: "center" },
  buttonText: { color: "#0B1512", fontSize: 16, fontWeight: "700" },
  hint: { color: theme.muted, fontSize: 12, lineHeight: 18 },
});
