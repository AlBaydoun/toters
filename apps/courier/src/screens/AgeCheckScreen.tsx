import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { api } from "../lib/api";
import type { ScreenProps } from "../lib/navigation";

const theme = {
  bg: "#14201B", surface: "#1D2C26", text: "#F4F7F5",
  muted: "#93A39C", accent: "#3FBF8F", danger: "#E06B52",
};

const DOCUMENTS = [
  { key: "PERSONALAUSWEIS", label: "Personalausweis" },
  { key: "REISEPASS", label: "Reisepass" },
  { key: "AUFENTHALTSTITEL", label: "Aufenthaltstitel" },
  { key: "EU_DRIVING_LICENCE", label: "EU-Führerschein" },
] as const;

/**
 * ID verification at handover (JuSchG).
 *
 * Note what this screen does NOT do: no camera, no document number field, no
 * scan upload. The courier confirms the check happened and which document type
 * they saw. Capturing more would breach data minimisation and turn every
 * courier phone into a store of identity documents.
 */
export function AgeCheckScreen({ route, navigation }: ScreenProps<"AgeCheck">) {
  const { orderId, requiredAge } = route.params;
  const [documentType, setDocumentType] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm(verified: boolean) {
    if (verified && !documentType) return;
    setBusy(true);
    try {
      await api.verifyAge(orderId, verified, verified ? documentType : null);
      if (verified) {
        navigation.replace("Delivery", { orderId });
      } else {
        Alert.alert(
          "Übergabe abgebrochen",
          "Nimm die Ware zurück zum Laden. Die Bestellung wurde storniert.",
        );
        navigation.replace("Shift");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Ausweiskontrolle</Text>
      <Text style={styles.subheading}>
        Diese Bestellung ist ab {requiredAge}. Prüfe den Ausweis und wähle den Dokumenttyp.
      </Text>

      <Text style={styles.privacy}>
        Wir speichern nur, dass du geprüft hast und welchen Dokumenttyp — keine Nummer, kein Foto.
      </Text>

      <View style={styles.documents}>
        {DOCUMENTS.map((doc) => (
          <Pressable
            key={doc.key}
            style={[styles.document, documentType === doc.key && styles.documentActive]}
            onPress={() => setDocumentType(doc.key)}
          >
            <Text
              style={[styles.documentText, documentType === doc.key && styles.documentTextActive]}
            >
              {doc.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[styles.button, !documentType && styles.buttonDisabled]}
        onPress={() => confirm(true)}
        disabled={!documentType || busy}
      >
        <Text style={styles.buttonText}>Alter bestätigt — übergeben</Text>
      </Pressable>

      <Pressable style={styles.reject} onPress={() => confirm(false)} disabled={busy}>
        <Text style={styles.rejectText}>Nachweis nicht erbracht — zurücknehmen</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.bg, padding: 24, gap: 12 },
  heading: { color: theme.text, fontSize: 26, fontWeight: "700" },
  subheading: { color: theme.text, fontSize: 15, lineHeight: 22 },
  privacy: { color: theme.muted, fontSize: 12, lineHeight: 18 },
  documents: { gap: 8, marginTop: 8 },
  document: { backgroundColor: theme.surface, borderRadius: 12, padding: 16 },
  documentActive: { backgroundColor: theme.accent },
  documentText: { color: theme.text, fontSize: 15 },
  documentTextActive: { color: "#0B1512", fontWeight: "700" },
  button: {
    backgroundColor: theme.accent, borderRadius: 12,
    paddingVertical: 18, alignItems: "center", marginTop: "auto",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#0B1512", fontSize: 16, fontWeight: "700" },
  reject: { alignItems: "center", paddingVertical: 16 },
  rejectText: { color: theme.danger, fontSize: 14 },
});
