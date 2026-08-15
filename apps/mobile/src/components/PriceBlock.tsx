import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { formatEur, t, type Locale } from "@liefero/shared";
import { theme } from "../lib/theme";
import type { Quote } from "../lib/api";

/**
 * The checkout summary. Every line here is legally load-bearing:
 * PAngV requires the full gross total before commitment, §14 UStG requires VAT
 * rates shown separately, and Pfand must be visible as its own line.
 */
export function PriceBlock({ quote, locale = "de" }: { quote: Quote; locale?: Locale }) {
  const rows: { label: string; value: number; muted?: boolean }[] = [
    { label: locale === "de" ? "Zwischensumme" : "Subtotal", value: quote.itemsSubtotal },
  ];

  if (quote.depositTotal > 0) rows.push({ label: t("checkout.deposit", locale), value: quote.depositTotal });
  rows.push({ label: t("checkout.deliveryFee", locale), value: quote.deliveryFee });
  if (quote.smallBasketSurcharge > 0) {
    rows.push({ label: t("checkout.smallBasket", locale), value: quote.smallBasketSurcharge });
  }
  rows.push({ label: t("checkout.serviceFee", locale), value: quote.serviceFee });
  if (quote.discountTotal > 0) rows.push({ label: t("checkout.discount", locale), value: -quote.discountTotal });
  if (quote.creditApplied > 0) rows.push({ label: "Guthaben", value: -quote.creditApplied });
  if (quote.tipAmount > 0) rows.push({ label: t("checkout.tip", locale), value: quote.tipAmount });

  return (
    <View style={styles.container}>
      {rows.map((row) => (
        <View key={row.label} style={styles.row}>
          <Text style={styles.label}>{row.label}</Text>
          <Text style={[styles.value, row.value < 0 && styles.discount]}>{formatEur(row.value)}</Text>
        </View>
      ))}

      <View style={styles.divider} />

      <View style={styles.row}>
        <Text style={styles.totalLabel}>{t("checkout.total", locale)}</Text>
        <Text style={styles.totalValue}>{formatEur(quote.grandTotal)}</Text>
      </View>

      {/* §14 UStG: rates shown separately. */}
      <Text style={styles.vat}>
        {t("checkout.vatIncluded", locale)}{" "}
        {Object.entries(quote.vatBreakdown)
          .map(([bps, amount]) => `${Number(bps) / 100}%: ${formatEur(amount)}`)
          .join(" · ")}
      </Text>

      {/* §312g BGB: the withdrawal position must be disclosed either way. */}
      <Text style={styles.legal}>{t("withdrawal.perishable", locale)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.spacing(2),
  },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  label: { ...theme.type.body, color: theme.colors.textMuted },
  value: { ...theme.type.body, color: theme.colors.text },
  discount: { color: theme.colors.success },
  divider: { height: 1, backgroundColor: theme.colors.border, marginVertical: theme.spacing(1) },
  totalLabel: { ...theme.type.h2, color: theme.colors.text },
  totalValue: { ...theme.type.h2, color: theme.colors.text },
  vat: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: theme.spacing(0.5) },
  legal: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: theme.spacing(1), lineHeight: 18 },
});
