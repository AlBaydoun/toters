import React, { useState } from "react";
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert,
} from "react-native";
import { theme } from "../lib/theme";
import { api, ApiError } from "../lib/api";
import { CourierBadge } from "../components/CourierBadge";
import type { ScreenProps } from "../lib/navigation";

const COMPLIMENTS = [
  { code: "FRIENDLY", label: "Freundlich" },
  { code: "FAST", label: "Schnell" },
  { code: "CAREFUL_WITH_FOOD", label: "Sorgfältig" },
  { code: "GOOD_COMMUNICATION", label: "Gute Kommunikation" },
  { code: "FOUND_TRICKY_ADDRESS", label: "Adresse gut gefunden" },
  { code: "WENT_ABOVE_AND_BEYOND", label: "Ging die Extrameile" },
];

/**
 * One screen covers the food and the delivery. Asking twice is how a review
 * prompt drops to a 30% completion rate.
 *
 * Compliments sit above the free-text box for the courier, because a tapped tag
 * is both far more likely to be given and far more useful to the person
 * receiving it than an empty comment field.
 */
export function ReviewScreen({ route, navigation }: ScreenProps<"Review">) {
  const { orderId, courierName, courierPhotoUrl } = route.params;

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [courierRating, setCourierRating] = useState(0);
  const [courierComment, setCourierComment] = useState("");
  const [compliments, setCompliments] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function toggleCompliment(code: string) {
    setCompliments((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  }

  async function submit() {
    if (rating === 0) return;
    setSubmitting(true);
    try {
      await api.submitReview(orderId, {
        rating,
        comment: comment.trim() || undefined,
        courierRating: courierRating > 0 ? courierRating : undefined,
        courierComment: courierComment.trim() || undefined,
        compliments,
      });
      navigation.goBack();
    } catch (e) {
      Alert.alert("Nicht gesendet", e instanceof ApiError ? e.message : "Bitte erneut versuchen.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Wie war deine Bestellung?</Text>

      <View style={styles.section}>
        <Text style={styles.label}>Essen und Laden</Text>
        <Stars value={rating} onChange={setRating} />
        <TextInput
          style={styles.input}
          value={comment}
          onChangeText={setComment}
          placeholder="Was lief gut oder weniger gut? (optional)"
          placeholderTextColor={theme.colors.textMuted}
          multiline
          maxLength={2000}
          textAlignVertical="top"
        />
      </View>

      {courierName ? (
        <View style={styles.section}>
          <Text style={styles.label}>Deine Lieferung</Text>

          <View style={styles.courierRow}>
            <CourierBadge
              firstName={courierName}
              photoUrl={courierPhotoUrl}
              rating={null}
              ratingCount={0}
            />
          </View>

          <Stars value={courierRating} onChange={setCourierRating} />

          {courierRating > 0 ? (
            <>
              <Text style={styles.hint}>
                {courierRating >= 4 ? "Was hat gut geklappt?" : "Was ist schiefgelaufen?"}
              </Text>
              <View style={styles.chips}>
                {COMPLIMENTS.map((c) => (
                  <Pressable
                    key={c.code}
                    style={[styles.chip, compliments.includes(c.code) && styles.chipActive]}
                    onPress={() => toggleCompliment(c.code)}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        compliments.includes(c.code) && styles.chipTextActive,
                      ]}
                    >
                      {c.label}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <TextInput
                style={styles.input}
                value={courierComment}
                onChangeText={setCourierComment}
                placeholder={`Nachricht an ${courierName} (optional)`}
                placeholderTextColor={theme.colors.textMuted}
                multiline
                maxLength={1000}
                textAlignVertical="top"
              />
              {/* Say who reads it. People write differently when they know a
                  named person will see it, and that is the point. */}
              <Text style={styles.privacy}>
                {courierName} sieht diese Nachricht. Sie erscheint nicht öffentlich.
              </Text>
            </>
          ) : null}
        </View>
      ) : null}

      <Pressable
        style={[styles.submit, (rating === 0 || submitting) && styles.submitDisabled]}
        onPress={submit}
        disabled={rating === 0 || submitting}
      >
        <Text style={styles.submitText}>{submitting ? "Wird gesendet…" : "Bewertung senden"}</Text>
      </Pressable>

      <Pressable style={styles.skip} onPress={() => navigation.goBack()}>
        <Text style={styles.skipText}>Später</Text>
      </Pressable>
    </ScrollView>
  );
}

function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <View style={styles.stars}>
      {[1, 2, 3, 4, 5].map((star) => (
        <Pressable
          key={star}
          onPress={() => onChange(star)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`${star} von 5 Sternen`}
        >
          <Text style={[styles.star, star <= value && styles.starFilled]}>★</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing(2.5), gap: theme.spacing(2.5) },
  heading: { ...theme.type.h1, color: theme.colors.text },
  section: { gap: theme.spacing(1) },
  label: { ...theme.type.body, fontWeight: "600", color: theme.colors.text },
  hint: { ...theme.type.caption, color: theme.colors.textMuted },
  courierRow: { paddingVertical: theme.spacing(0.5) },
  stars: { flexDirection: "row", gap: theme.spacing(1) },
  star: { fontSize: 38, color: theme.colors.border },
  starFilled: { color: theme.colors.accent },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing(1) },
  chip: {
    paddingHorizontal: theme.spacing(1.5),
    paddingVertical: theme.spacing(1),
    borderRadius: 999,
    backgroundColor: theme.colors.surface,
  },
  chipActive: { backgroundColor: theme.colors.primary },
  chipText: { ...theme.type.caption, color: theme.colors.text },
  chipTextActive: { color: "#FFFFFF", fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: theme.spacing(1.5),
    minHeight: 90,
    color: theme.colors.text,
    ...theme.type.body,
  },
  privacy: { ...theme.type.caption, fontSize: 12, color: theme.colors.textMuted },
  submit: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing(2),
    alignItems: "center",
  },
  submitDisabled: { opacity: 0.45 },
  submitText: { color: "#FFFFFF", fontWeight: "700", fontSize: 16 },
  skip: { alignItems: "center", paddingVertical: theme.spacing(1) },
  skipText: { ...theme.type.body, color: theme.colors.textMuted },
});
