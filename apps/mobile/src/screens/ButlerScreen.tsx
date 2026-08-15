import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, Alert, ScrollView } from "react-native";
import { formatEur } from "@liefero/shared";
import { theme } from "../lib/theme";
import { api, ApiError } from "../lib/api";

const BUDGET_PRESETS = [1000, 2500, 5000, 10_000];

/**
 * Butler: the buy-anything errand. No catalog, no partner merchant — the
 * customer describes what they want and caps what we may spend.
 *
 * The pricing honesty matters here: the budget is an upper limit, and we charge
 * what the courier actually spends. Charging the full budget regardless would be
 * both a trust problem and, under German price-transparency rules, a legal one.
 */
export function ButlerScreen({
  route,
  navigation,
}: {
  route: { params: { addressId: string } };
  navigation: { replace: (s: string, p?: object) => void };
}) {
  const [text, setText] = useState("");
  const [budget, setBudget] = useState(2500);
  const [submitting, setSubmitting] = useState(false);

  const tooShort = text.trim().length < 10;

  async function submit() {
    setSubmitting(true);
    try {
      const result = await api.createButler({
        addressId: route.params.addressId,
        request: text.trim(),
        budget,
      });
      navigation.replace("Tracking", { orderId: result.orderId });
    } catch (e) {
      Alert.alert("Butler nicht verfügbar", e instanceof ApiError ? e.message : "Bitte später erneut versuchen.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Butler</Text>
      <Text style={styles.subheading}>
        Sag uns, was du brauchst. Wir holen alles, was aufs Rad passt — auch aus Läden, die keine Partner sind.
      </Text>

      <Text style={styles.label}>Was sollen wir besorgen?</Text>
      <TextInput
        style={styles.textarea}
        value={text}
        onChangeText={setText}
        multiline
        numberOfLines={5}
        maxLength={1000}
        textAlignVertical="top"
        placeholder="z. B. Zwei Packungen Ibuprofen 400 aus der Apotheke am Markt und eine Tageszeitung."
        placeholderTextColor={theme.colors.textMuted}
      />
      <Text style={styles.counter}>{text.length}/1000</Text>

      <Text style={styles.label}>Maximaler Einkaufswert</Text>
      <Text style={styles.hint}>
        Wir buchen diesen Betrag nur vor. Abgerechnet wird, was der Kurier tatsächlich bezahlt.
      </Text>
      <View style={styles.budgetRow}>
        {BUDGET_PRESETS.map((amount) => (
          <Pressable
            key={amount}
            style={[styles.budgetChip, budget === amount && styles.budgetChipActive]}
            onPress={() => setBudget(amount)}
          >
            <Text style={[styles.budgetText, budget === amount && styles.budgetTextActive]}>
              {formatEur(amount)}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.notice}>
        <Text style={styles.noticeText}>
          Rezeptpflichtige Medikamente, Alkohol über 18 und Tabak kann der Butler nicht ohne Ausweiskontrolle liefern.
          Der Kurier prüft bei der Übergabe.
        </Text>
      </View>

      <Pressable
        style={[styles.submit, (tooShort || submitting) && styles.submitDisabled]}
        onPress={submit}
        disabled={tooShort || submitting}
      >
        <Text style={styles.submitText}>
          {submitting ? "Wird gesendet…" : "Kostenpflichtig beauftragen"}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing(2.5), gap: theme.spacing(1) },
  heading: { ...theme.type.h1, color: theme.colors.text },
  subheading: { ...theme.type.body, color: theme.colors.textMuted, lineHeight: 21, marginBottom: theme.spacing(1) },
  label: { ...theme.type.body, fontWeight: "600", color: theme.colors.text, marginTop: theme.spacing(1) },
  hint: { ...theme.type.caption, color: theme.colors.textMuted },
  textarea: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: theme.spacing(1.5),
    minHeight: 120,
    color: theme.colors.text,
    ...theme.type.body,
  },
  counter: { ...theme.type.caption, color: theme.colors.textMuted, textAlign: "right" },
  budgetRow: { flexDirection: "row", gap: theme.spacing(1), flexWrap: "wrap", marginTop: theme.spacing(0.5) },
  budgetChip: {
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1),
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
  },
  budgetChipActive: { backgroundColor: theme.colors.primary },
  budgetText: { ...theme.type.body, color: theme.colors.text },
  budgetTextActive: { color: "#FFFFFF", fontWeight: "600" },
  notice: {
    marginTop: theme.spacing(2),
    padding: theme.spacing(1.5),
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
  },
  noticeText: { ...theme.type.caption, color: theme.colors.textMuted, lineHeight: 18 },
  submit: {
    marginTop: theme.spacing(2),
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing(2),
    alignItems: "center",
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
});
