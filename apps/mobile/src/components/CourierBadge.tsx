import React from "react";
import { View, Text, Image, StyleSheet } from "react-native";
import { theme } from "../lib/theme";

/**
 * The courier's identity at the door.
 *
 * The photo's purpose is recognition — the customer needs to know the person
 * holding their food is the right person. Falling back to an initial rather
 * than a generic silhouette matters: a placeholder avatar reads as "no data",
 * whereas an initial reads as a person who chose not to add a photo.
 */
export function CourierBadge({
  firstName,
  photoUrl,
  rating,
  ratingCount,
  vehicle,
  size = 52,
}: {
  firstName: string;
  photoUrl: string | null;
  rating: number | null;
  ratingCount: number;
  vehicle?: string;
  size?: number;
}) {
  return (
    <View style={styles.row}>
      {photoUrl ? (
        <Image
          source={{ uri: photoUrl }}
          style={[styles.photo, { width: size, height: size, borderRadius: size / 2 }]}
          accessibilityLabel={`Foto von ${firstName}`}
        />
      ) : (
        <View
          style={[styles.fallback, { width: size, height: size, borderRadius: size / 2 }]}
          accessibilityLabel={firstName}
        >
          <Text style={[styles.initial, { fontSize: size * 0.4 }]}>
            {firstName.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}

      <View style={styles.meta}>
        <Text style={styles.name}>{firstName}</Text>
        <Text style={styles.sub}>
          {rating != null
            ? `★ ${rating.toFixed(1)} · ${ratingCount} Bewertungen`
            : /* A rating off two deliveries is noise, so say so plainly rather
                 than printing a flattering number. */
              "Noch keine Bewertungen"}
          {vehicle ? ` · ${vehicleLabel(vehicle)}` : ""}
        </Text>
      </View>
    </View>
  );
}

function vehicleLabel(vehicle: string): string {
  const labels: Record<string, string> = {
    BICYCLE: "Fahrrad", E_BIKE: "E-Bike", E_SCOOTER: "E-Roller",
    CAR: "Auto", ON_FOOT: "zu Fuß",
  };
  return labels[vehicle] ?? vehicle;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing(1.5) },
  photo: { backgroundColor: theme.colors.surface },
  fallback: {
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  initial: { color: "#FFFFFF", fontWeight: "700" },
  meta: { flex: 1 },
  name: { ...theme.type.h2, fontSize: 17, color: theme.colors.text },
  sub: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 2 },
});
