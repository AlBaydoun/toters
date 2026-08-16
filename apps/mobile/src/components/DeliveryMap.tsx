import React, { useEffect, useRef } from "react";
import { StyleSheet, View, Text, Platform } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT, type Region } from "react-native-maps";
import { theme } from "../lib/theme";
import type { Tracking } from "../lib/api";

/**
 * The live delivery map.
 *
 * Two details do most of the work here:
 *
 * 1. Positions arrive every ~10s, but a marker that teleports every ten seconds
 *    reads as broken. The marker is animated between fixes so movement looks
 *    continuous, which is the entire perceived quality of a tracking screen.
 *
 * 2. The camera fits courier and destination together rather than following the
 *    courier. Customers want to see the gap closing, not a close-up of a street
 *    they can't place.
 */
export function DeliveryMap({ tracking }: { tracking: Tracking }) {
  const mapRef = useRef<MapView | null>(null);
  // Marker is exported as a value, so its ref type comes via ElementRef.
  const markerRef = useRef<React.ElementRef<typeof Marker> | null>(null);
  const lastPosition = useRef<{ latitude: number; longitude: number } | null>(null);

  const courier = tracking.courierPosition;
  const destination = tracking.destination;
  const route = tracking.route;

  // Animate the marker to each new fix instead of re-rendering it in place.
  useEffect(() => {
    if (!courier) return;
    const next = { latitude: courier.latitude, longitude: courier.longitude };

    if (lastPosition.current && markerRef.current) {
      // Slightly longer than the poll interval, so the marker is still gliding
      // when the next fix lands and never visibly stalls.
      markerRef.current.animateMarkerToCoordinate(next, 11_000);
    }
    lastPosition.current = next;
  }, [courier?.latitude, courier?.longitude]);

  // Keep both ends of the journey in frame as the courier closes in.
  useEffect(() => {
    if (!mapRef.current) return;
    const points = [destination, ...(courier ? [courier] : []), ...(route?.points ?? [])];
    if (points.length < 2) return;

    mapRef.current.fitToCoordinates(points, {
      edgePadding: { top: 80, right: 60, bottom: 140, left: 60 },
      animated: true,
    });
  }, [courier?.latitude, courier?.longitude, route?.points.length]);

  const initialRegion: Region = {
    latitude: courier?.latitude ?? destination.latitude,
    longitude: courier?.longitude ?? destination.longitude,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02,
  };

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_DEFAULT}
        initialRegion={initialRegion}
        showsUserLocation={false}
        showsMyLocationButton={false}
        toolbarEnabled={false}
        // Nothing on this map is worth a 3D building render at the cost of
        // battery on a phone the user is staring at for 25 minutes.
        pitchEnabled={false}
        rotateEnabled={false}
      >
        {route && route.points.length > 1 ? (
          <Polyline
            coordinates={route.points}
            strokeWidth={4}
            strokeColor={theme.colors.primary}
            lineCap="round"
          />
        ) : null}

        <Marker coordinate={destination} anchor={{ x: 0.5, y: 0.5 }}>
          <View style={styles.destinationPin}>
            <View style={styles.destinationDot} />
          </View>
        </Marker>

        {tracking.merchant ? (
          <Marker
            coordinate={{
              latitude: tracking.merchant.latitude,
              longitude: tracking.merchant.longitude,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={styles.merchantPin} />
          </Marker>
        ) : null}

        {courier ? (
          <Marker
            ref={markerRef}
            coordinate={{ latitude: courier.latitude, longitude: courier.longitude }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            rotation={tracking.courierBearing ?? 0}
          >
            <View style={styles.courierPin}>
              <View style={styles.courierArrow} />
            </View>
          </Marker>
        ) : null}
      </MapView>

      {!courier ? (
        <View style={styles.overlay}>
          <Text style={styles.overlayText}>
            {tracking.status === "OUT_FOR_DELIVERY"
              ? "Standort wird gesucht…"
              : "Der Kurier ist noch nicht unterwegs."}
          </Text>
        </View>
      ) : null}

      {route ? (
        <View style={styles.distanceBadge}>
          <Text style={styles.distanceText}>
            noch {(route.distanceMeters / 1000).toFixed(1)} km
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 280,
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.surface,
  },
  destinationPin: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "#FFFFFF",
    borderWidth: 3, borderColor: theme.colors.text,
    alignItems: "center", justifyContent: "center",
  },
  destinationDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.text },
  merchantPin: {
    width: 16, height: 16, borderRadius: 4,
    backgroundColor: theme.colors.accent,
    borderWidth: 2, borderColor: "#FFFFFF",
  },
  courierPin: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: theme.colors.primary,
    borderWidth: 3, borderColor: "#FFFFFF",
    alignItems: "center", justifyContent: "center",
    ...Platform.select({
      android: { elevation: 4 },
      default: { shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 4 },
    }),
  },
  courierArrow: {
    width: 0, height: 0,
    borderLeftWidth: 5, borderRightWidth: 5, borderBottomWidth: 10,
    borderLeftColor: "transparent", borderRightColor: "transparent",
    borderBottomColor: "#FFFFFF",
    marginBottom: 2,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(20,32,27,0.55)",
    alignItems: "center", justifyContent: "center",
  },
  overlayText: { color: "#FFFFFF", ...theme.type.body },
  distanceBadge: {
    position: "absolute", bottom: 12, alignSelf: "center",
    backgroundColor: theme.colors.text,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 999,
  },
  distanceText: { color: "#FFFFFF", ...theme.type.caption, fontWeight: "600" },
});
