import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ScrollView, AppState } from "react-native";
import * as Location from "expo-location";
import { formatEur } from "@liefero/shared";
import { api, getCourierId, type ShiftState } from "../lib/api";
import type { ScreenProps } from "../lib/navigation";

const theme = {
  bg: "#14201B",
  surface: "#1D2C26",
  text: "#F4F7F5",
  muted: "#93A39C",
  accent: "#3FBF8F",
  danger: "#E06B52",
};

const LOCATION_PING_MS = 15_000;

/**
 * The courier's home screen. Two jobs: control the shift, and make earnings
 * legible in real time.
 *
 * Showing the guaranteed floor alongside actual earnings is deliberate. A wage
 * guarantee the courier can't see during the shift is one they can't factor in
 * when deciding whether a slow evening is worth working.
 */
export function ShiftScreen({ navigation }: ScreenProps<"Shift">) {
  const [courierId, setCourierId] = useState<string | null>(null);
  const [shift, setShift] = useState<ShiftState | null>(null);
  const [busy, setBusy] = useState(false);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { void getCourierId().then(setCourierId); }, []);

  const refresh = useCallback(async () => {
    if (!courierId) return;
    try {
      setShift(await api.currentShift(courierId));
    } catch {
      // Transient network failures are normal on a bike; the next tick retries.
    }
  }, [courierId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Location is reported only while a shift is open. Tracking a courier off
  // shift would be both a GDPR problem and a trust one.
  useEffect(() => {
    if (!shift?.active || !courierId) {
      if (pingTimer.current) clearInterval(pingTimer.current);
      return;
    }

    async function ping() {
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") return;
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      await api
        .pingLocation(
          courierId!,
          position.coords.latitude,
          position.coords.longitude,
          position.coords.accuracy ?? undefined,
        )
        .catch(() => undefined);
    }

    void ping();
    pingTimer.current = setInterval(ping, LOCATION_PING_MS);

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });

    return () => {
      if (pingTimer.current) clearInterval(pingTimer.current);
      sub.remove();
    };
  }, [shift?.active, courierId, refresh]);

  async function startShift() {
    if (!courierId) return;
    setBusy(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Standort erforderlich",
          "Ohne Standortfreigabe können wir dir keine Aufträge zuweisen. Der Standort wird nur während der Schicht erfasst.",
        );
        return;
      }
      await api.startShift(courierId);
      await refresh();
    } catch (e) {
      // The rest-period block is a legal guard, not an error — explain it.
      Alert.alert("Schicht kann nicht starten", e instanceof Error ? e.message : "Unbekannter Fehler");
    } finally {
      setBusy(false);
    }
  }

  async function endShift() {
    if (!shift?.shiftId) return;
    setBusy(true);
    try {
      const summary = await api.endShift(shift.shiftId, 0);
      const lines = [
        `${summary.dropsCompleted} Lieferungen`,
        `Verdient: ${formatEur(summary.earnedCents)}`,
      ];
      if (summary.topUpCents > 0) {
        lines.push(`Mindestlohn-Ausgleich: ${formatEur(summary.topUpCents)}`);
      }
      lines.push(`Gesamt: ${formatEur(summary.totalPayableCents)}`);
      Alert.alert("Schicht beendet", lines.join("\n"));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const active = shift?.active === true;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.status}>{active ? "Im Dienst" : "Nicht im Dienst"}</Text>

      {active ? (
        <>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Heute verdient</Text>
            <Text style={styles.bigNumber}>{formatEur(shift.projectedTotalCents ?? 0)}</Text>
            <Text style={styles.cardMeta}>{shift.dropsCompleted ?? 0} Lieferungen</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardLabel}>Aufschlüsselung</Text>
            <Row label="Pro Lieferung" value={formatEur(shift.earnedCents ?? 0)} />
            <Row label="Mindestlohn-Garantie" value={formatEur(shift.projectedFloorCents ?? 0)} />
            {(shift.projectedTopUpCents ?? 0) > 0 ? (
              <Row
                label="Ausgleich zum Mindestlohn"
                value={formatEur(shift.projectedTopUpCents ?? 0)}
                highlight
              />
            ) : null}
            <Text style={styles.guarantee}>
              Du bekommst immer mindestens den gesetzlichen Mindestlohn für deine Schichtzeit —
              unabhängig davon, wie viele Aufträge kommen.
            </Text>
          </View>

          <Pressable style={[styles.button, styles.buttonDanger]} onPress={endShift} disabled={busy}>
            <Text style={styles.buttonText}>Schicht beenden</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.intro}>
            Starte deine Schicht, um Aufträge zu erhalten. Dein Standort wird nur während der
            Schicht erfasst und nach 30 Tagen gelöscht.
          </Text>
          <Pressable style={styles.button} onPress={startShift} disabled={busy || !courierId}>
            <Text style={styles.buttonText}>Schicht starten</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, highlight && styles.rowValueHighlight]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 20, gap: 16 },
  status: { color: theme.text, fontSize: 28, fontWeight: "700" },
  intro: { color: theme.muted, fontSize: 15, lineHeight: 22 },
  card: { backgroundColor: theme.surface, borderRadius: 16, padding: 16, gap: 6 },
  cardLabel: { color: theme.muted, fontSize: 13 },
  cardMeta: { color: theme.muted, fontSize: 13 },
  bigNumber: { color: theme.text, fontSize: 34, fontWeight: "700" },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  rowLabel: { color: theme.muted, fontSize: 14 },
  rowValue: { color: theme.text, fontSize: 14, fontWeight: "600" },
  rowValueHighlight: { color: theme.accent },
  guarantee: { color: theme.muted, fontSize: 12, lineHeight: 18, marginTop: 8 },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: "center",
  },
  buttonDanger: { backgroundColor: theme.danger },
  buttonText: { color: "#0B1512", fontSize: 16, fontWeight: "700" },
});
