import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet, Alert, ScrollView } from "react-native";
import { t } from "@liefero/shared";
import { theme } from "../lib/theme";
import { api, type Tracking } from "../lib/api";
import { DeliveryMap } from "../components/DeliveryMap";
import type { ScreenProps } from "../lib/navigation";

const STEPS = ["AWAITING_MERCHANT", "PREPARING", "AWAITING_COURIER", "OUT_FOR_DELIVERY", "DELIVERED"];

export function TrackingScreen({ route, navigation }: ScreenProps<"Tracking">) {
  const { orderId } = route.params;
  const [tracking, setTracking] = useState<Tracking | null>(null);

  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const result = await api.tracking(orderId);
        if (active) setTracking(result);
      } catch {
        // Transient failures are expected on mobile networks; the next tick retries.
      }
    }
    void poll();
    // Polling rather than sockets: it survives backgrounding and flaky mobile
    // networks. Faster once the courier is moving, because that is the only
    // phase where a stale position is visible to the customer.
    const interval = tracking?.status === "OUT_FOR_DELIVERY" ? 10_000 : 20_000;
    const timer = setInterval(poll, interval);
    return () => { active = false; clearInterval(timer); };
  }, [orderId, tracking?.status]);

  if (!tracking) {
    return <View style={styles.centred}><ActivityIndicator color={theme.colors.primary} /></View>;
  }

  const currentStep = STEPS.indexOf(tracking.status);

  async function cancel() {
    Alert.alert(
      "Bestellung stornieren?",
      t(tracking!.cancellation.explanationKey, "de"),
      [
        { text: "Zurück", style: "cancel" },
        {
          text: "Stornieren",
          style: "destructive",
          onPress: async () => {
            const result = await api.cancelOrder(orderId);
            Alert.alert(
              "Storniert",
              result.refundedAsCredit > 0
                ? `${(result.refundedAsCredit / 100).toFixed(2)} € wurden deinem Guthaben gutgeschrieben.`
                : "Deine Bestellung wurde storniert.",
            );
          },
        },
      ],
    );
  }

  const showMap =
    tracking.status === "OUT_FOR_DELIVERY" ||
    tracking.status === "PREPARING" ||
    tracking.status === "AWAITING_COURIER";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {showMap ? <DeliveryMap tracking={tracking} /> : null}

      <Text style={styles.reference}>{tracking.reference}</Text>
      <Text style={styles.status}>{t(`order.status.${tracking.status}`, "de")}</Text>
      {tracking.etaMinutes ? <Text style={styles.eta}>Ankunft in ca. {tracking.etaMinutes} Minuten</Text> : null}

      <View style={styles.steps}>
        {STEPS.map((step, index) => (
          <View key={step} style={styles.step}>
            <View style={[styles.dot, index <= currentStep && styles.dotActive]} />
            <Text style={[styles.stepLabel, index <= currentStep && styles.stepLabelActive]}>
              {t(`order.status.${step}`, "de")}
            </Text>
          </View>
        ))}
      </View>

      {tracking.courier ? (
        <View style={styles.courierCard}>
          <Text style={styles.courierName}>{tracking.courier.firstName}</Text>
          <Text style={styles.courierMeta}>★ {tracking.courier.rating.toFixed(1)} · {tracking.courier.vehicle}</Text>
          {/* Chat rather than a phone call: neither side ever learns the
              other's number, and a courier on a bike can answer a tap but not
              a call. */}
          <Pressable
            style={styles.callButton}
            onPress={() => navigation.navigate("Chat", { orderId })}
          >
            <Text style={styles.callButtonText}>Mit dem Kurier chatten</Text>
          </Pressable>
        </View>
      ) : null}

      {tracking.requiredAge ? (
        <View style={styles.ageNotice}>
          <Text style={styles.ageText}>
            {tracking.ageVerifiedAt
              ? "Altersnachweis bestätigt."
              : `Halte deinen Ausweis bereit — diese Bestellung ist ab ${tracking.requiredAge}.`}
          </Text>
        </View>
      ) : null}

      {tracking.cancellation.customerMayCancel ? (
        <Pressable style={styles.cancelButton} onPress={cancel}>
          <Text style={styles.cancelText}>Bestellung stornieren</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing(2.5), paddingBottom: theme.spacing(4) },
  centred: { flex: 1, alignItems: "center", justifyContent: "center" },
  reference: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: theme.spacing(2) },
  status: { ...theme.type.h1, color: theme.colors.text, marginTop: 4 },
  eta: { ...theme.type.body, color: theme.colors.primary, marginTop: 4, fontWeight: "600" },
  steps: { marginTop: theme.spacing(3), gap: theme.spacing(2) },
  step: { flexDirection: "row", alignItems: "center", gap: theme.spacing(1.5) },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.colors.border },
  dotActive: { backgroundColor: theme.colors.primary },
  stepLabel: { ...theme.type.body, color: theme.colors.textMuted },
  stepLabelActive: { color: theme.colors.text, fontWeight: "600" },
  courierCard: {
    marginTop: theme.spacing(3),
    padding: theme.spacing(2),
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface,
  },
  courierName: { ...theme.type.h2, color: theme.colors.text },
  courierMeta: { ...theme.type.caption, color: theme.colors.textMuted, marginTop: 2 },
  callButton: {
    marginTop: theme.spacing(1.5),
    backgroundColor: theme.colors.primary,
    borderRadius: theme.radius.sm,
    paddingVertical: theme.spacing(1.25),
    alignItems: "center",
  },
  callButtonText: { color: "#FFFFFF", fontWeight: "600" },
  ageNotice: {
    marginTop: theme.spacing(2),
    padding: theme.spacing(1.5),
    borderRadius: theme.radius.md,
    backgroundColor: "#FDF3EE",
  },
  ageText: { ...theme.type.caption, color: theme.colors.text },
  cancelButton: { marginTop: theme.spacing(3), alignItems: "center", paddingVertical: theme.spacing(2) },
  cancelText: { ...theme.type.body, color: theme.colors.danger },
});
