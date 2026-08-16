import React, { useEffect, useState, useCallback } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, StyleSheet, ScrollView } from "react-native";
import * as Location from "expo-location";
import { formatEur } from "@liefero/shared";
import { theme } from "../lib/theme";
import { api, type MerchantCard } from "../lib/api";
import type { ScreenProps } from "../lib/navigation";

const VERTICALS = [
  { key: undefined, label: "Alles" },
  { key: "RESTAURANT", label: "Restaurants" },
  { key: "GROCERY", label: "Supermarkt" },
  { key: "CAFE", label: "Café" },
  { key: "PHARMACY", label: "Apotheke" },
  { key: "RETAIL", label: "Shops" },
] as const;

/**
 * Discovery is address-first: fee, availability and ETA all depend on where the
 * customer is, so nothing renders until we have a position.
 */
export function DiscoverScreen({ navigation }: ScreenProps<"Discover">) {
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [merchants, setMerchants] = useState<MerchantCard[]>([]);
  const [serviceable, setServiceable] = useState(true);
  const [vertical, setVertical] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        // Location is a convenience, not a requirement — the customer can always
        // pick an address manually rather than being locked out.
        setPermissionDenied(true);
        setLoading(false);
        return;
      }
      const position = await Location.getCurrentPositionAsync({});
      setCoords({ latitude: position.coords.latitude, longitude: position.coords.longitude });
    })();
  }, []);

  const load = useCallback(async () => {
    if (!coords) return;
    setLoading(true);
    try {
      const result = await api.discover(coords.latitude, coords.longitude, vertical);
      setServiceable(result.serviceable);
      setMerchants(result.merchants);
    } finally {
      setLoading(false);
    }
  }, [coords, vertical]);

  useEffect(() => { void load(); }, [load]);

  if (permissionDenied) {
    return (
      <View style={styles.centred}>
        <Text style={styles.emptyTitle}>Wo sollen wir hinliefern?</Text>
        <Text style={styles.emptyBody}>Gib eine Adresse ein, um Läden in deiner Nähe zu sehen.</Text>
        <Pressable style={styles.cta} onPress={() => navigation.navigate("AddressPicker")}>
          <Text style={styles.ctaText}>Adresse eingeben</Text>
        </Pressable>
      </View>
    );
  }

  if (loading && merchants.length === 0) {
    return <View style={styles.centred}><ActivityIndicator color={theme.colors.primary} /></View>;
  }

  if (!serviceable) {
    return (
      <View style={styles.centred}>
        <Text style={styles.emptyTitle}>Hier sind wir noch nicht</Text>
        <Text style={styles.emptyBody}>
          Wir liefern noch nicht an diese Adresse — aber wir arbeiten daran.
        </Text>
        <Pressable style={styles.cta} onPress={() => navigation.navigate("Waitlist")}>
          <Text style={styles.ctaText}>Benachrichtige mich</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters} contentContainerStyle={styles.filtersContent}>
        {VERTICALS.map((v) => (
          <Pressable
            key={v.label}
            style={[styles.chip, vertical === v.key && styles.chipActive]}
            onPress={() => setVertical(v.key)}
          >
            <Text style={[styles.chipText, vertical === v.key && styles.chipTextActive]}>{v.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <Pressable style={styles.bonusCard} onPress={() => navigation.navigate("Bonus")}>
        <Text style={styles.bonusTitle}>Bonus</Text>
        <Text style={styles.bonusSubtitle}>
          Bei jeder Bestellung Geld zurück — direkt als Guthaben.
        </Text>
      </Pressable>

      {/* The Butler entry point sits above the store grid: it is the wedge, and
          it is the one thing no competitor offers. */}
      <Pressable style={styles.butlerCard} onPress={() => navigation.navigate("Butler")}>
        <Text style={styles.butlerTitle}>Butler</Text>
        <Text style={styles.butlerSubtitle}>Wir holen dir alles, was aufs Rad passt — auch von Läden ohne Partnerschaft.</Text>
      </Pressable>

      <FlatList
        data={merchants}
        keyExtractor={(m) => m.id}
        refreshing={loading}
        onRefresh={load}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.card, !item.isOpen && styles.cardClosed]}
            onPress={() => navigation.navigate("Merchant", { slug: item.slug })}
          >
            <View style={styles.cardBody}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardName} numberOfLines={1}>{item.name}</Text>
                {/* P2B: paid placement must be labelled as advertising. */}
                {item.sponsored ? <Text style={styles.sponsored}>Anzeige</Text> : null}
              </View>
              <Text style={styles.cardMeta}>
                ★ {item.rating.toFixed(1)} ({item.ratingCount}) · {item.distanceKm} km · {item.etaMinutes} Min
              </Text>
              <Text style={styles.cardMeta}>
                Lieferung {item.deliveryFee === 0 ? "gratis" : formatEur(item.deliveryFee)} · min. {formatEur(item.minimumBasket)}
              </Text>
              {!item.isOpen ? <Text style={styles.closed}>Zurzeit geschlossen</Text> : null}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.centred}>
            <Text style={styles.emptyBody}>Keine Läden in dieser Kategorie.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  centred: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing(3) },
  filters: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  filtersContent: { paddingHorizontal: theme.spacing(2), paddingVertical: theme.spacing(1.5), gap: theme.spacing(1) },
  chip: {
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(0.75),
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
  },
  chipActive: { backgroundColor: theme.colors.primary },
  chipText: { ...theme.type.caption, color: theme.colors.text },
  chipTextActive: { color: "#FFFFFF", fontWeight: "600" },
  bonusCard: {
    marginHorizontal: theme.spacing(2),
    marginTop: theme.spacing(2),
    padding: theme.spacing(2),
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  bonusTitle: { ...theme.type.h2, color: theme.colors.primary },
  bonusSubtitle: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 4, lineHeight: 18 },
  butlerCard: {
    marginHorizontal: theme.spacing(2),
    marginTop: theme.spacing(1.5),
    marginBottom: theme.spacing(2),
    padding: theme.spacing(2),
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primary,
  },
  butlerTitle: { ...theme.type.h2, color: "#FFFFFF" },
  butlerSubtitle: { ...theme.type.caption, color: "#DCEFE7", marginTop: 4, lineHeight: 18 },
  list: { paddingHorizontal: theme.spacing(2), paddingBottom: theme.spacing(4) },
  card: {
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.spacing(1.5),
    overflow: "hidden",
  },
  cardClosed: { opacity: 0.55 },
  cardBody: { padding: theme.spacing(1.5) },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardName: { ...theme.type.h2, fontSize: 17, color: theme.colors.text, flex: 1 },
  sponsored: { ...theme.type.caption, fontSize: 11, color: theme.colors.textMuted },
  cardMeta: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 3 },
  closed: { ...theme.type.caption, color: theme.colors.danger, marginTop: 4 },
  emptyTitle: { ...theme.type.h1, color: theme.colors.text, textAlign: "center" },
  emptyBody: { ...theme.type.body, color: theme.colors.textMuted, textAlign: "center", marginTop: theme.spacing(1) },
  cta: {
    marginTop: theme.spacing(3),
    backgroundColor: theme.colors.primary,
    paddingHorizontal: theme.spacing(3),
    paddingVertical: theme.spacing(1.5),
    borderRadius: theme.radius.md,
  },
  ctaText: { color: "#FFFFFF", fontWeight: "600" },
});
