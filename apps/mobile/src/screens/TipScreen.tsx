import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ScrollView } from "react-native";
import { formatEur, TIP_WINDOW_HOURS } from "@liefero/shared";
import { theme } from "../lib/theme";
import { api, ApiError } from "../lib/api";
import type { ScreenProps } from "../lib/navigation";

const PRESETS = [100, 200, 300, 500];

/**
 * Tipping after delivery, which is when the customer actually knows whether it
 * went well. A tip taken at checkout is a guess.
 *
 * Charged to a card, never funded from wallet balance: a tip paid out of
 * cashback we granted would mean paying the courier from our own marketing
 * budget while the customer takes the credit for it.
 */
export function TipScreen({ route, navigation }: ScreenProps<"Tip">) {
  const { orderId, courierName } = route.params;
  const [amount, setAmount] = useState(200);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      const result = await api.tipOrder(orderId, amount);
      Alert.alert("Danke!", result.note);
      navigation.goBack();
    } catch (e) {
      Alert.alert("Nicht möglich", e instanceof ApiError ? e.message : "Bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>
        {courierName ? `Trinkgeld für ${courierName}` : "Trinkgeld"}
      </Text>
      <Text style={styles.sub}>
        Geht zu 100 % an deinen Kurier — wir behalten nichts davon ein.
      </Text>

      <View style={styles.presets}>
        {PRESETS.map((value) => (
          <Pressable
            key={value}
            style={[styles.preset, amount === value && styles.presetActive]}
            onPress={() => setAmount(value)}
          >
            <Text style={[styles.presetText, amount === value && styles.presetTextActive]}>
              {formatEur(value)}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable style={[styles.cta, busy && styles.ctaDisabled]} onPress={send} disabled={busy}>
        <Text style={styles.ctaText}>
          {busy ? "Wird gesendet…" : `${formatEur(amount)} Trinkgeld geben`}
        </Text>
      </Pressable>

      <Text style={styles.fineprint}>
        Trinkgeld ist bis {TIP_WINDOW_HOURS} Stunden nach der Lieferung möglich und wird
        über dein hinterlegtes Zahlungsmittel abgerechnet, nicht über dein Guthaben.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing(2.5), gap: theme.spacing(2) },
  heading: { ...theme.type.h1, color: theme.colors.text },
  sub: { ...theme.type.body, color: theme.colors.textMuted, lineHeight: 21 },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1) },
  preset: {
    paddingHorizontal: theme.spacing(2.5),
    paddingVertical: theme.spacing(1.5),
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
  },
  presetActive: { backgroundColor: theme.colors.primary },
  presetText: { ...theme.type.body, color: theme.colors.text },
  presetTextActive: { color: "#FFFFFF", fontWeight: "700" },
  cta: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing(2),
    alignItems: "center",
  },
  ctaDisabled: { opacity: 0.5 },
  ctaText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
  fineprint: { ...theme.type.caption, color: theme.colors.textMuted, lineHeight: 19 },
});
