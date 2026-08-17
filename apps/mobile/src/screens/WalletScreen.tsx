import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert,
} from "react-native";
import { formatEur, formatRate } from "@liefero/shared";
import { theme } from "../lib/theme";
import { api, ApiError, type Wallet, type TopUpQuote } from "../lib/api";

const PRESETS = [1000, 2000, 5000, 10_000];

/**
 * Wallet: deposit money now, spend it on future orders.
 *
 * The balance is shown split into "your money" and "bonus" rather than as one
 * number, because the two behave differently — one is refundable and permanent,
 * the other expires and is not. Presenting them as a single figure would make
 * the refund rules feel like a trick when someone eventually hits them.
 */
export function WalletScreen() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [selected, setSelected] = useState<number>(2000);
  const [quote, setQuote] = useState<TopUpQuote | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setWallet(await api.wallet());
    } catch {
      // Retried on next interaction.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    void api
      .topUpQuote(selected)
      .then((q) => { if (!cancelled) setQuote(q); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [selected]);

  async function topUp() {
    setBusy(true);
    try {
      const result = await api.topUp(selected);
      if (result.requiresAction) {
        // The PSP challenge is handled by the payment sheet; surfaced plainly
        // rather than silently stalling.
        Alert.alert("Bestätigung nötig", "Bitte bestätige die Zahlung bei deiner Bank.");
      } else {
        Alert.alert("Aufgeladen", `${formatEur(result.credited)} sind jetzt in deinem Guthaben.`);
      }
      await load();
    } catch (e) {
      Alert.alert("Aufladen fehlgeschlagen", e instanceof ApiError ? e.message : "Bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  function requestRefund() {
    if (!wallet) return;
    Alert.alert(
      "Guthaben auszahlen?",
      wallet.refundExplanation,
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Auszahlen",
          onPress: async () => {
            try {
              const result = await api.refundWallet();
              Alert.alert("Auszahlung veranlasst", `${formatEur(result.refunded)} gehen zurück auf dein Zahlungsmittel.`);
              await load();
            } catch (e) {
              Alert.alert("Nicht möglich", e instanceof ApiError ? e.message : "Bitte Support kontaktieren.");
            }
          },
        },
      ],
    );
  }

  if (!wallet) {
    return <View style={styles.centred}><ActivityIndicator color={theme.colors.primary} /></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.heroLabel}>Guthaben</Text>
        <Text style={styles.heroAmount}>{formatEur(wallet.balance)}</Text>
        <View style={styles.split}>
          <Text style={styles.splitItem}>Aufgeladen {formatEur(wallet.purchased)}</Text>
          <Text style={styles.splitItem}>Bonus {formatEur(wallet.granted)}</Text>
        </View>
      </View>

      {wallet.expiringWithin60Days > 0 ? (
        <View style={styles.warning}>
          <Text style={styles.warningText}>
            {formatEur(wallet.expiringWithin60Days)} Bonusguthaben verfallen in 60 Tagen.
          </Text>
        </View>
      ) : null}

      <Text style={styles.sectionTitle}>Guthaben aufladen</Text>
      <View style={styles.presets}>
        {PRESETS.map((amount) => (
          <Pressable
            key={amount}
            style={[styles.preset, selected === amount && styles.presetActive]}
            onPress={() => setSelected(amount)}
          >
            <Text style={[styles.presetText, selected === amount && styles.presetTextActive]}>
              {formatEur(amount)}
            </Text>
          </Pressable>
        ))}
      </View>

      {quote ? (
        <View style={styles.quoteCard}>
          {quote.bonus > 0 ? (
            <Text style={styles.quoteBonus}>
              + {formatEur(quote.bonus)} Bonus ({formatRate(quote.bonusBps)})
            </Text>
          ) : null}
          <Text style={styles.quoteTotal}>
            Du bekommst {formatEur(quote.credited)} Guthaben.
          </Text>
          {/* Truthful nudge: states the actual next tier rather than implying
              the current amount already earns it. */}
          {quote.nextTier ? (
            <Text style={styles.quoteNext}>
              Noch {formatEur(quote.nextTier.extraNeeded)} für {formatRate(quote.nextTier.bonusBps)} Bonus.
            </Text>
          ) : null}
        </View>
      ) : null}

      <Pressable style={[styles.cta, busy && styles.ctaDisabled]} onPress={topUp} disabled={busy}>
        <Text style={styles.ctaText}>
          {busy ? "Wird geladen…" : `${formatEur(selected)} aufladen`}
        </Text>
      </Pressable>

      <View style={styles.rules}>
        <Text style={styles.rule}>
          • Dein Guthaben gilt nur für Bestellungen bei uns. Es ist nicht übertragbar und
          nicht in bar auszahlbar.
        </Text>
        <Text style={styles.rule}>
          • Beim Bezahlen wird zuerst Bonusguthaben verbraucht, damit nichts verfällt.
        </Text>
        <Text style={styles.rule}>
          • Aufgeladenes Guthaben kannst du dir jederzeit zurückzahlen lassen. Bonusguthaben
          und Cashback sind davon ausgenommen.
        </Text>
      </View>

      {wallet.refundable > 0 ? (
        <Pressable style={styles.linkButton} onPress={requestRefund}>
          <Text style={styles.linkText}>
            {formatEur(wallet.refundable)} auszahlen lassen
          </Text>
        </Pressable>
      ) : null}

      {wallet.topUps.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Aufladungen</Text>
          {wallet.topUps.map((t) => (
            <View key={t.id} style={styles.historyRow}>
              <View style={styles.grow}>
                <Text style={styles.historyMain}>{formatEur(t.amount)}</Text>
                <Text style={styles.historySub}>
                  {new Date(t.createdAt).toLocaleDateString("de-DE")}
                  {t.bonus > 0 ? ` · +${formatEur(t.bonus)} Bonus` : ""}
                  {t.refunded > 0 ? ` · ${formatEur(t.refunded)} erstattet` : ""}
                </Text>
              </View>
              <Text style={styles.historyAmount}>+{formatEur(t.credited)}</Text>
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing(2.5), gap: theme.spacing(1.5) },
  centred: { flex: 1, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1 },
  hero: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.lg,
    padding: theme.spacing(3),
  },
  heroLabel: { ...theme.type.caption, color: "#C9E7DC" },
  heroAmount: { fontSize: 40, fontWeight: "700", color: "#FFFFFF", marginTop: 4 },
  split: { flexDirection: "row", gap: theme.spacing(2), marginTop: theme.spacing(1) },
  splitItem: { ...theme.type.caption, color: "#DCEFE7" },
  warning: { backgroundColor: "#FDF3EE", borderRadius: theme.radius.md, padding: theme.spacing(1.5) },
  warningText: { ...theme.type.caption, color: theme.colors.danger },
  sectionTitle: { ...theme.type.h2, color: theme.colors.text, marginTop: theme.spacing(1) },
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
  quoteCard: {
    backgroundColor: "#E9F5F0",
    borderRadius: theme.radius.md,
    padding: theme.spacing(1.5),
    gap: 2,
  },
  quoteBonus: { ...theme.type.body, fontWeight: "700", color: theme.colors.primary },
  quoteTotal: { ...theme.type.body, color: theme.colors.text },
  quoteNext: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 4 },
  cta: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing(2),
    alignItems: "center",
  },
  ctaDisabled: { opacity: 0.5 },
  ctaText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
  rules: { gap: 6, marginTop: theme.spacing(1) },
  rule: { ...theme.type.caption, color: theme.colors.textMuted, lineHeight: 19 },
  linkButton: { alignItems: "center", paddingVertical: theme.spacing(1.5) },
  linkText: { ...theme.type.body, color: theme.colors.primary },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing(1.25),
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  historyMain: { ...theme.type.body, color: theme.colors.text },
  historySub: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 2 },
  historyAmount: { ...theme.type.body, fontWeight: "700", color: theme.colors.success },
});
