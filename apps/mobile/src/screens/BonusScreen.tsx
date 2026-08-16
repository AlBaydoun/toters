import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl } from "react-native";
import { formatEur, formatRate, TIER_CASHBACK_BPS } from "@liefero/shared";
import { theme } from "../lib/theme";
import { api, type CashbackOverview } from "../lib/api";

const TIER_LABELS: Record<string, string> = {
  BRONZE: "Bronze",
  SILVER: "Silber",
  GOLD: "Gold",
};

/**
 * The Bonus section.
 *
 * Cashback is money, so this screen leads with the balance in euros rather than
 * an abstract point count. Points programmes bury the exchange rate; the whole
 * appeal of cashback is that there isn't one.
 *
 * The two things most rewards screens hide, shown here on purpose: what is
 * excluded from earning, and what is about to expire.
 */
export function BonusScreen() {
  const [data, setData] = useState<CashbackOverview | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.cashback());
    } catch {
      // Retried on pull-to-refresh.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!data) {
    return (
      <View style={styles.centred}>
        <ActivityIndicator color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
        />
      }
    >
      <View style={styles.hero}>
        <Text style={styles.heroLabel}>Dein Guthaben</Text>
        <Text style={styles.heroAmount}>{formatEur(data.balance)}</Text>
        <Text style={styles.heroSub}>
          Bei jeder Bestellung bekommst du {formatRate(data.currentRateBps)} zurück.
        </Text>
      </View>

      {data.expiringWithin60Days > 0 ? (
        <View style={styles.warning}>
          <Text style={styles.warningText}>
            {formatEur(data.expiringWithin60Days)} verfallen in den nächsten 60 Tagen.
          </Text>
        </View>
      ) : null}

      {data.activeCampaigns.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Aktuelle Aktionen</Text>
          {data.activeCampaigns.map((campaign) => (
            <View key={campaign.id} style={styles.campaignRow}>
              <Text style={styles.campaignLabel}>{campaign.label}</Text>
              <Text style={styles.campaignBonus}>+{formatRate(campaign.bonusBps)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Deine Stufe: {TIER_LABELS[data.tier] ?? data.tier}</Text>
        {(["BRONZE", "SILVER", "GOLD"] as const).map((tier) => (
          <View key={tier} style={styles.tierRow}>
            <Text style={[styles.tierName, tier === data.tier && styles.tierActive]}>
              {TIER_LABELS[tier]}
            </Text>
            <Text style={[styles.tierRate, tier === data.tier && styles.tierActive]}>
              {formatRate(TIER_CASHBACK_BPS[tier])}
            </Text>
          </View>
        ))}
        <Text style={styles.fineprint}>
          Mehr Bestellungen, höhere Stufe, mehr Cashback.
        </Text>
      </View>

      {/* Stated plainly rather than buried in the T&Cs. A rewards programme that
          surprises people about what doesn't earn is a programme people stop
          trusting. */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>So funktioniert's</Text>
        <Text style={styles.rule}>
          • Du bekommst {formatRate(data.currentRateBps)} auf den Warenwert zurück, sobald
          die Bestellung geliefert ist.
        </Text>
        <Text style={styles.rule}>
          • Kein Cashback auf Pfand, Trinkgeld, Gebühren oder auf Beträge, die du mit
          Guthaben bezahlt hast.
        </Text>
        <Text style={styles.rule}>
          • Maximal {formatEur(data.capPerOrder)} pro Bestellung.
        </Text>
        <Text style={styles.rule}>
          • Dein Guthaben ist drei Jahre gültig und wird beim nächsten Einkauf automatisch
          angeboten.
        </Text>
        <Text style={styles.rule}>
          • Bei einer Erstattung wird das dazugehörige Cashback zurückgebucht.
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Bisher gesammelt</Text>
      <Text style={styles.lifetime}>{formatEur(data.lifetimeEarned)}</Text>

      {data.history.length === 0 ? (
        <Text style={styles.empty}>Noch kein Cashback — deine erste Bestellung bringt welches.</Text>
      ) : (
        data.history.map((entry) => (
          <View key={entry.id} style={styles.historyRow}>
            <View style={styles.historyMeta}>
              <Text style={styles.historyMerchant}>{entry.merchantName}</Text>
              <Text style={styles.historySub}>
                {entry.orderReference} · {formatRate(entry.rateBps)} ·{" "}
                {new Date(entry.createdAt).toLocaleDateString("de-DE")}
              </Text>
              {entry.clawedBack > 0 ? (
                <Text style={styles.clawback}>
                  {formatEur(entry.clawedBack)} zurückgebucht (Erstattung)
                </Text>
              ) : null}
            </View>
            <Text style={styles.historyAmount}>+{formatEur(entry.net)}</Text>
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing(2.5), gap: theme.spacing(2) },
  centred: { flex: 1, alignItems: "center", justifyContent: "center" },
  hero: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.lg,
    padding: theme.spacing(3),
  },
  heroLabel: { ...theme.type.caption, color: "#C9E7DC" },
  heroAmount: { fontSize: 40, fontWeight: "700", color: "#FFFFFF", marginTop: 4 },
  heroSub: { ...theme.type.body, color: "#DCEFE7", marginTop: 8, lineHeight: 21 },
  warning: {
    backgroundColor: "#FDF3EE",
    borderRadius: theme.radius.md,
    padding: theme.spacing(1.5),
  },
  warningText: { ...theme.type.caption, color: theme.colors.danger },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.spacing(2),
    gap: theme.spacing(0.75),
  },
  cardTitle: { ...theme.type.body, fontWeight: "700", color: theme.colors.text, marginBottom: 4 },
  campaignRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  campaignLabel: { ...theme.type.body, color: theme.colors.text, flex: 1 },
  campaignBonus: { ...theme.type.body, fontWeight: "700", color: theme.colors.primary },
  tierRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  tierName: { ...theme.type.body, color: theme.colors.textMuted },
  tierRate: { ...theme.type.body, color: theme.colors.textMuted },
  tierActive: { color: theme.colors.primary, fontWeight: "700" },
  fineprint: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 6 },
  rule: { ...theme.type.caption, color: theme.colors.textMuted, lineHeight: 19 },
  sectionTitle: { ...theme.type.h2, color: theme.colors.text },
  lifetime: { ...theme.type.h1, color: theme.colors.primary, marginTop: -8 },
  empty: { ...theme.type.caption, color: theme.colors.textMuted },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing(1.25),
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  historyMeta: { flex: 1 },
  historyMerchant: { ...theme.type.body, color: theme.colors.text },
  historySub: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 2 },
  clawback: { ...theme.type.caption, color: theme.colors.danger, marginTop: 2 },
  historyAmount: { ...theme.type.body, fontWeight: "700", color: theme.colors.success },
});
