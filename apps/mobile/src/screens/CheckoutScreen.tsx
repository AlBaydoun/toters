import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ScrollView, ActivityIndicator, TextInput, StyleSheet, Alert } from "react-native";
import { formatEur, t } from "@liefero/shared";
import { theme } from "../lib/theme";
import { api, ApiError, type Quote } from "../lib/api";
import { PriceBlock } from "../components/PriceBlock";

const TIP_PRESETS = [0, 100, 200, 300];

export function CheckoutScreen({
  route,
  navigation,
}: {
  route: { params: { addressId: string } };
  navigation: { replace: (s: string, p?: object) => void };
}) {
  const { addressId } = route.params;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<string | undefined>();
  const [tipAmount, setTipAmount] = useState(0);
  const [useCredit, setUseCredit] = useState(true);
  const [loading, setLoading] = useState(true);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await api.quote(addressId, { promoCode: appliedPromo, tipAmount, useCredit });
        if (!cancelled) { setQuote(result); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Preis konnte nicht berechnet werden.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [addressId, appliedPromo, tipAmount, useCredit]);

  async function applyPromo() {
    try {
      await api.quote(addressId, { promoCode, tipAmount, useCredit });
      setAppliedPromo(promoCode);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Code ungültig.");
    }
  }

  async function placeOrder() {
    setPlacing(true);
    try {
      const result = await api.checkout(addressId, { promoCode: appliedPromo, tipAmount, useCredit });
      navigation.replace("Tracking", { orderId: result.orderId });
    } catch (e) {
      if (e instanceof ApiError) {
        // These two are compliance gates, not generic failures — they get an
        // explanation the customer can act on.
        if (e.code === "AGE_RESTRICTED" || e.code === "DOB_REQUIRED") {
          Alert.alert(t("age.required", "de"), `${e.message}\n\n${t("age.explain", "de")}`);
        } else if (e.code === "ACTIVE_ORDER_EXISTS") {
          Alert.alert("Bestellung läuft bereits", e.message);
        } else {
          Alert.alert("Bestellung fehlgeschlagen", e.message);
        }
      }
    } finally {
      setPlacing(false);
    }
  }

  if (loading && !quote) {
    return <View style={styles.centred}><ActivityIndicator color={theme.colors.primary} /></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Bestellung prüfen</Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Gutscheincode</Text>
        <View style={styles.promoRow}>
          <TextInput
            style={styles.input}
            value={promoCode}
            onChangeText={setPromoCode}
            autoCapitalize="characters"
            placeholder="CODE"
            placeholderTextColor={theme.colors.textMuted}
          />
          <Pressable style={styles.promoButton} onPress={applyPromo}>
            <Text style={styles.promoButtonText}>Einlösen</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Trinkgeld für den Kurier</Text>
        <Text style={styles.sectionHint}>Geht zu 100 % an den Kurier.</Text>
        <View style={styles.tipRow}>
          {TIP_PRESETS.map((amount) => (
            <Pressable
              key={amount}
              style={[styles.tipChip, tipAmount === amount && styles.tipChipActive]}
              onPress={() => setTipAmount(amount)}
            >
              <Text style={[styles.tipText, tipAmount === amount && styles.tipTextActive]}>
                {amount === 0 ? "Kein" : formatEur(amount)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {quote && quote.creditApplied > 0 ? (
        <Pressable style={styles.creditRow} onPress={() => setUseCredit((v) => !v)}>
          <Text style={styles.sectionTitle}>Guthaben verwenden</Text>
          <Text style={styles.creditValue}>{useCredit ? `− ${formatEur(quote.creditApplied)}` : "Aus"}</Text>
        </Pressable>
      ) : null}

      {quote?.requiredAge ? (
        <View style={styles.ageNotice}>
          <Text style={styles.ageTitle}>{t("age.required", "de")} — ab {quote.requiredAge}</Text>
          <Text style={styles.ageBody}>{t("age.explain", "de")}</Text>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {quote ? <PriceBlock quote={quote} /> : null}

      <Pressable
        style={[styles.placeButton, placing && styles.placeButtonDisabled]}
        onPress={placeOrder}
        disabled={placing}
      >
        <Text style={styles.placeButtonText}>
          {placing ? "Wird bestellt…" : `Kostenpflichtig bestellen · ${quote ? formatEur(quote.grandTotal) : ""}`}
        </Text>
      </Pressable>
      {/* "Kostenpflichtig bestellen" is the wording §312j(3) BGB requires on the
          order button — a generic "Bestellen" makes the contract unenforceable. */}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing(2), gap: theme.spacing(2) },
  centred: { flex: 1, alignItems: "center", justifyContent: "center" },
  heading: { ...theme.type.h1, color: theme.colors.text },
  section: { gap: theme.spacing(0.5) },
  sectionTitle: { ...theme.type.body, fontWeight: "600", color: theme.colors.text },
  sectionHint: { ...theme.type.caption, color: theme.colors.textMuted },
  promoRow: { flexDirection: "row", gap: theme.spacing(1), marginTop: theme.spacing(0.5) },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.sm,
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(1.25),
    color: theme.colors.text,
  },
  promoButton: {
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing(2),
    justifyContent: "center",
    borderRadius: theme.radius.sm,
  },
  promoButtonText: { ...theme.type.body, fontWeight: "600", color: theme.colors.primary },
  tipRow: { flexDirection: "row", gap: theme.spacing(1), marginTop: theme.spacing(0.5) },
  tipChip: {
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1),
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
  },
  tipChipActive: { backgroundColor: theme.colors.primary },
  tipText: { ...theme.type.caption, color: theme.colors.text },
  tipTextActive: { color: "#FFFFFF", fontWeight: "600" },
  creditRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  creditValue: { ...theme.type.body, color: theme.colors.success, fontWeight: "600" },
  ageNotice: {
    backgroundColor: "#FDF3EE",
    borderRadius: theme.radius.md,
    padding: theme.spacing(1.5),
  },
  ageTitle: { ...theme.type.body, fontWeight: "600", color: theme.colors.danger },
  ageBody: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 2 },
  error: { ...theme.type.caption, color: theme.colors.danger },
  placeButton: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing(2),
    alignItems: "center",
    marginTop: theme.spacing(1),
  },
  placeButtonDisabled: { opacity: 0.6 },
  placeButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
});
