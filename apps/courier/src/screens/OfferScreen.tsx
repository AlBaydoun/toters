import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, Modal } from "react-native";
import { api, type AssignmentExplanation } from "../lib/api";
import type { ScreenProps } from "../lib/navigation";

const theme = {
  bg: "#14201B", surface: "#1D2C26", text: "#F4F7F5",
  muted: "#93A39C", accent: "#3FBF8F", danger: "#E06B52",
};

const OFFER_SECONDS = 45;

/**
 * An incoming assignment offer.
 *
 * The "Warum ich?" button is not a nicety — the EU Platform Work Directive
 * (Art. 6–11) gives platform workers a right to an explanation of automated
 * decisions that affect them, and a route to human review. Building it into the
 * offer screen means the answer is available at the moment it's relevant.
 */
export function OfferScreen({ route, navigation }: ScreenProps<"Offer">) {
  const { assignmentId, orderId } = route.params;
  const [secondsLeft, setSecondsLeft] = useState(OFFER_SECONDS);
  const [explanation, setExplanation] = useState<AssignmentExplanation | null>(null);
  const [showExplanation, setShowExplanation] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, []);

  // Declining by silence has the same effect as declining explicitly, so it is
  // handled identically rather than leaving the offer hanging.
  useEffect(() => {
    if (secondsLeft === 0) void respond(false);
  }, [secondsLeft]);

  async function respond(accept: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await api.respondToOffer(assignmentId, accept);
      if (accept) navigation.replace("Delivery", { orderId });
      else navigation.replace("Shift");
    } finally {
      setBusy(false);
    }
  }

  async function loadExplanation() {
    setShowExplanation(true);
    if (!explanation) {
      setExplanation(await api.explainAssignment(assignmentId).catch(() => null));
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.timer}>{secondsLeft}s</Text>
      <Text style={styles.heading}>Neuer Auftrag</Text>

      <Pressable style={styles.why} onPress={loadExplanation}>
        <Text style={styles.whyText}>Warum ich?</Text>
      </Pressable>

      <View style={styles.actions}>
        <Pressable
          style={[styles.button, styles.decline]}
          onPress={() => respond(false)}
          disabled={busy}
        >
          <Text style={styles.declineText}>Ablehnen</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.accept]}
          onPress={() => respond(true)}
          disabled={busy}
        >
          <Text style={styles.acceptText}>Annehmen</Text>
        </Pressable>
      </View>

      <Text style={styles.noFault}>
        Ablehnen wirkt sich nicht auf deine Bewertung oder künftige Zuweisungen aus.
      </Text>

      <Modal visible={showExplanation} animationType="slide" transparent>
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Warum du diesen Auftrag bekommen hast</Text>
            {explanation ? (
              <>
                {explanation.factors.map((f) => (
                  <Text key={f.code} style={styles.factor}>• {f.explanation}</Text>
                ))}
                <Text style={styles.modalFoot}>
                  Du kannst diese Entscheidung von einem Menschen prüfen lassen:{" "}
                  {explanation.humanReviewContact}
                </Text>
              </>
            ) : (
              <Text style={styles.factor}>Erklärung nicht verfügbar.</Text>
            )}
            <Pressable style={styles.modalClose} onPress={() => setShowExplanation(false)}>
              <Text style={styles.modalCloseText}>Schließen</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg, padding: 24, justifyContent: "center" },
  timer: { color: theme.accent, fontSize: 52, fontWeight: "700", textAlign: "center" },
  heading: { color: theme.text, fontSize: 24, fontWeight: "700", textAlign: "center", marginTop: 8 },
  why: { alignSelf: "center", marginTop: 16, padding: 8 },
  whyText: { color: theme.muted, fontSize: 14, textDecorationLine: "underline" },
  actions: { flexDirection: "row", gap: 12, marginTop: 40 },
  button: { flex: 1, borderRadius: 12, paddingVertical: 18, alignItems: "center" },
  decline: { backgroundColor: theme.surface },
  accept: { backgroundColor: theme.accent },
  declineText: { color: theme.text, fontSize: 16, fontWeight: "600" },
  acceptText: { color: "#0B1512", fontSize: 16, fontWeight: "700" },
  noFault: { color: theme.muted, fontSize: 12, textAlign: "center", marginTop: 16, lineHeight: 18 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modal: { backgroundColor: theme.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, gap: 10 },
  modalTitle: { color: theme.text, fontSize: 18, fontWeight: "700", marginBottom: 4 },
  factor: { color: theme.text, fontSize: 15, lineHeight: 22 },
  modalFoot: { color: theme.muted, fontSize: 13, lineHeight: 19, marginTop: 8 },
  modalClose: { marginTop: 12, alignItems: "center", paddingVertical: 12 },
  modalCloseText: { color: theme.accent, fontSize: 15, fontWeight: "600" },
});
