import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, Pressable, ScrollView, StyleSheet, Alert,
  TextInput, Modal, ActivityIndicator, Image,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { api, uploadImage, ApiError, type CourierFeedback } from "../lib/api";
import type { ScreenProps } from "../lib/navigation";

const theme = {
  bg: "#14201B", surface: "#1D2C26", text: "#F4F7F5",
  muted: "#93A39C", accent: "#3FBF8F", danger: "#E06B52",
};

const COMPLIMENT_LABELS: Record<string, string> = {
  FRIENDLY: "Freundlich",
  FAST: "Schnell",
  CAREFUL_WITH_FOOD: "Sorgfältig",
  GOOD_COMMUNICATION: "Gute Kommunikation",
  FOUND_TRICKY_ADDRESS: "Adresse gut gefunden",
  WENT_ABOVE_AND_BEYOND: "Ging die Extrameile",
};

/**
 * The courier's own feedback.
 *
 * Two things this screen exists to make true:
 *
 *  - The courier sees exactly what customers said about them, including the
 *    free text. Feedback that affects someone's work but that they cannot read
 *    is the opaque management the Platform Work Directive exists to stop.
 *  - Contesting is a visible button, not a support email nobody sends. A
 *    contested review stops counting immediately, before a human looks at it,
 *    because the courier should not carry a disputed rating while they wait.
 */
export function FeedbackScreen({ navigation }: ScreenProps<"Feedback">) {
  const [feedback, setFeedback] = useState<CourierFeedback | null>(null);
  const [contesting, setContesting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setFeedback(await api.feedback());
    } catch {
      // Retried on next focus.
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function changePhoto() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return;

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.6,
      allowsEditing: true,
      aspect: [1, 1],
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (result.canceled || !result.assets[0]) return;

    setBusy(true);
    try {
      const uploaded = await uploadImage(result.assets[0].uri, result.assets[0].mimeType ?? "image/jpeg");
      const saved = await api.setPhoto(uploaded.mediaId);
      setPhotoUrl(saved.photoUrl);
    } catch (e) {
      Alert.alert("Foto nicht gespeichert", e instanceof ApiError ? e.message : "Erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  function removePhoto() {
    Alert.alert(
      "Foto entfernen?",
      "Kunden sehen dann nur deinen Vornamen. Du kannst jederzeit ein neues hinzufügen.",
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Entfernen",
          style: "destructive",
          onPress: async () => {
            await api.removePhoto();
            setPhotoUrl(null);
          },
        },
      ],
    );
  }

  async function submitContest() {
    if (!contesting || reason.trim().length < 10) return;
    setBusy(true);
    try {
      const result = await api.contestReview(contesting, reason.trim());
      setContesting(null);
      setReason("");
      Alert.alert("Eingereicht", result.message);
      await load();
    } catch (e) {
      Alert.alert("Fehler", e instanceof ApiError ? e.message : "Erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  if (!feedback) {
    return (
      <View style={styles.centred}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.photoRow}>
        {photoUrl ? (
          <Image source={{ uri: photoUrl }} style={styles.photo} />
        ) : (
          <View style={[styles.photo, styles.photoEmpty]}>
            <Text style={styles.photoEmptyText}>Kein Foto</Text>
          </View>
        )}
        <View style={styles.photoMeta}>
          <Pressable style={styles.smallButton} onPress={changePhoto} disabled={busy}>
            <Text style={styles.smallButtonText}>{photoUrl ? "Foto ändern" : "Foto hinzufügen"}</Text>
          </Pressable>
          {photoUrl ? (
            <Pressable style={styles.linkButton} onPress={removePhoto}>
              <Text style={styles.linkText}>Entfernen</Text>
            </Pressable>
          ) : null}
          {/* Purpose stated plainly. Consent that does not say what for is not
              informed consent. */}
          <Text style={styles.photoHint}>
            Freiwillig. Kunden sehen dein Foto nur, damit sie dich an der Tür erkennen.
          </Text>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Deine Bewertung</Text>
        {feedback.rating != null ? (
          <>
            <Text style={styles.bigNumber}>★ {feedback.rating.toFixed(1)}</Text>
            <Text style={styles.cardMeta}>aus {feedback.ratingCount} Bewertungen</Text>
          </>
        ) : (
          <Text style={styles.cardMeta}>Noch keine Bewertungen.</Text>
        )}
      </View>

      {feedback.compliments.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Was Kunden über dich sagen</Text>
          <View style={styles.chips}>
            {feedback.compliments.map((c) => (
              <View key={c.code} style={styles.chip}>
                <Text style={styles.chipText}>
                  {COMPLIMENT_LABELS[c.code] ?? c.code} · {c.count}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.rights}>
        <Text style={styles.rightsText}>{feedback.yourRights.explanation}</Text>
        <Text style={styles.rightsContact}>{feedback.yourRights.contact}</Text>
      </View>

      <Text style={styles.sectionTitle}>Einzelne Rückmeldungen</Text>
      {feedback.reviews.length === 0 ? (
        <Text style={styles.muted}>Noch nichts da.</Text>
      ) : (
        feedback.reviews.map((review) => (
          <View key={review.id} style={[styles.card, review.contested && styles.cardContested]}>
            <Text style={styles.stars}>{"★".repeat(review.rating ?? 0)}</Text>
            {review.comment ? <Text style={styles.comment}>{review.comment}</Text> : null}
            {review.compliments.length > 0 ? (
              <Text style={styles.cardMeta}>
                {review.compliments.map((c) => COMPLIMENT_LABELS[c] ?? c).join(" · ")}
              </Text>
            ) : null}
            <Text style={styles.date}>
              {new Date(review.createdAt).toLocaleDateString("de-DE")}
            </Text>

            {review.contested ? (
              <Text style={styles.contestedNote}>
                {review.resolved
                  ? "Geprüft und bestätigt."
                  : "In Prüfung — zählt aktuell nicht zu deinem Schnitt."}
              </Text>
            ) : review.canContest ? (
              <Pressable style={styles.linkButton} onPress={() => setContesting(review.id)}>
                <Text style={styles.linkText}>Widersprechen</Text>
              </Pressable>
            ) : null}
          </View>
        ))
      )}

      <Modal visible={contesting != null} transparent animationType="slide">
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Was ist wirklich passiert?</Text>
            <Text style={styles.modalHint}>
              Ein Mensch liest das. Solange zählt diese Bewertung nicht zu deinem Schnitt.
            </Text>
            <TextInput
              style={styles.modalInput}
              value={reason}
              onChangeText={setReason}
              multiline
              maxLength={1000}
              textAlignVertical="top"
              placeholder="Beschreib kurz, was aus deiner Sicht passiert ist."
              placeholderTextColor={theme.muted}
            />
            <Pressable
              style={[styles.button, (reason.trim().length < 10 || busy) && styles.buttonDisabled]}
              onPress={submitContest}
              disabled={reason.trim().length < 10 || busy}
            >
              <Text style={styles.buttonText}>Einreichen</Text>
            </Pressable>
            <Pressable
              style={styles.linkButton}
              onPress={() => { setContesting(null); setReason(""); }}
            >
              <Text style={styles.linkText}>Abbrechen</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 20, gap: 16 },
  centred: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.bg },
  photoRow: { flexDirection: "row", gap: 16, alignItems: "center" },
  photo: { width: 84, height: 84, borderRadius: 42, backgroundColor: theme.surface },
  photoEmpty: { alignItems: "center", justifyContent: "center" },
  photoEmptyText: { color: theme.muted, fontSize: 12 },
  photoMeta: { flex: 1, gap: 4 },
  photoHint: { color: theme.muted, fontSize: 12, lineHeight: 17 },
  card: { backgroundColor: theme.surface, borderRadius: 16, padding: 16, gap: 6 },
  cardContested: { opacity: 0.6 },
  cardLabel: { color: theme.muted, fontSize: 13 },
  cardMeta: { color: theme.muted, fontSize: 13 },
  bigNumber: { color: theme.text, fontSize: 34, fontWeight: "700" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  chip: { backgroundColor: theme.bg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { color: theme.text, fontSize: 13 },
  rights: { padding: 14, borderRadius: 12, backgroundColor: "#182A22" },
  rightsText: { color: theme.text, fontSize: 13, lineHeight: 19 },
  rightsContact: { color: theme.accent, fontSize: 13, marginTop: 6 },
  sectionTitle: { color: theme.text, fontSize: 18, fontWeight: "700", marginTop: 8 },
  muted: { color: theme.muted },
  stars: { color: theme.accent, fontSize: 18 },
  comment: { color: theme.text, fontSize: 15, lineHeight: 21 },
  date: { color: theme.muted, fontSize: 12 },
  contestedNote: { color: theme.muted, fontSize: 13, fontStyle: "italic" },
  smallButton: {
    backgroundColor: theme.surface, borderRadius: 10,
    paddingVertical: 12, paddingHorizontal: 16, alignSelf: "flex-start",
  },
  smallButtonText: { color: theme.text, fontWeight: "600" },
  linkButton: { paddingVertical: 8, alignSelf: "flex-start" },
  linkText: { color: theme.accent, fontSize: 14 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modal: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 24, gap: 12,
  },
  modalTitle: { color: theme.text, fontSize: 20, fontWeight: "700" },
  modalHint: { color: theme.muted, fontSize: 13, lineHeight: 19 },
  modalInput: {
    backgroundColor: theme.bg, borderRadius: 12, padding: 14,
    minHeight: 110, color: theme.text, fontSize: 15,
  },
  button: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 16, alignItems: "center" },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#0B1512", fontWeight: "700", fontSize: 16 },
});
