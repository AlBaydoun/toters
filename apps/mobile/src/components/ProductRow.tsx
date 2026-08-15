import React from "react";
import { View, Text, Image, Pressable, StyleSheet } from "react-native";
import { formatEur, ALLERGEN_LABELS } from "@liefero/shared";
import { theme } from "../lib/theme";
import type { Product } from "../lib/api";

/**
 * A grocery row carries more mandatory information than a restaurant row:
 * Grundpreis (PAngV), Pfand (VerpackG), allergens (LMIV) and the age gate
 * (JuSchG) all have to be visible before the item goes in the basket.
 */
export function ProductRow({
  product,
  locale = "de",
  onPress,
}: {
  product: Product;
  locale?: "de" | "en";
  onPress: (p: Product) => void;
}) {
  const unavailable = !product.inStock;
  const allergenSummary = product.allergens
    .slice(0, 3)
    .map((a) => ALLERGEN_LABELS[a]?.[locale] ?? a)
    .join(", ");

  return (
    <Pressable
      style={[styles.container, unavailable && styles.unavailable]}
      onPress={() => !unavailable && onPress(product)}
      disabled={unavailable}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${formatEur(product.price)}`}
    >
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={2}>{product.name}</Text>
        {product.description ? (
          <Text style={styles.description} numberOfLines={2}>{product.description}</Text>
        ) : null}

        <View style={styles.priceRow}>
          <Text style={styles.price}>{formatEur(product.price)}</Text>
          {product.compareAtPrice ? (
            <Text style={styles.compareAt}>{formatEur(product.compareAtPrice)}</Text>
          ) : null}
          {/* PAngV Grundpreis, next to the selling price as required. */}
          {product.unitPrice ? <Text style={styles.unitPrice}>{product.unitPrice}</Text> : null}
        </View>

        <View style={styles.badges}>
          {product.depositScheme !== "NONE" ? (
            <Text style={styles.badge}>+ Pfand</Text>
          ) : null}
          {product.minimumAge ? (
            <Text style={[styles.badge, styles.ageBadge]}>ab {product.minimumAge}</Text>
          ) : null}
          {product.nutriScore ? (
            <Text style={styles.badge}>Nutri-Score {product.nutriScore}</Text>
          ) : null}
        </View>

        {allergenSummary ? (
          <Text style={styles.allergens} numberOfLines={1}>
            {locale === "de" ? "Allergene" : "Allergens"}: {allergenSummary}
          </Text>
        ) : null}
      </View>

      {product.imageUrl ? (
        <Image source={{ uri: product.imageUrl }} style={styles.image} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    gap: theme.spacing(1.5),
    paddingVertical: theme.spacing(1.5),
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  unavailable: { opacity: 0.45 },
  info: { flex: 1 },
  name: { ...theme.type.body, fontWeight: "600", color: theme.colors.text },
  description: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 2 },
  priceRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing(1), marginTop: 6 },
  price: { ...theme.type.price, color: theme.colors.text },
  compareAt: {
    ...theme.type.caption,
    color: theme.colors.textMuted,
    textDecorationLine: "line-through",
  },
  unitPrice: { ...theme.type.caption, color: theme.colors.textMuted },
  badges: { flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" },
  badge: {
    ...theme.type.caption,
    fontSize: 11,
    color: theme.colors.textMuted,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.radius.sm,
    overflow: "hidden",
  },
  ageBadge: { color: theme.colors.danger },
  allergens: { ...theme.type.caption, fontSize: 11, color: theme.colors.textMuted, marginTop: 4 },
  image: { width: 84, height: 84, borderRadius: theme.radius.md, backgroundColor: theme.colors.surface },
});
