/**
 * Route geometry for the tracking map.
 *
 * OSRM, self-hostable and EU-hosted, rather than Google Directions. That is a
 * GDPR decision as much as a cost one: every route request carries a customer's
 * home address, and keeping those inside the EU removes a transfer-impact
 * assessment from the critical path.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface Route {
  /** Decoded polyline, ready to hand to a map view. */
  points: LatLng[];
  distanceMeters: number;
  durationSeconds: number;
}

const ROUTING_URL = process.env.ROUTING_URL ?? "https://routing.openstreetmap.de/routed-bike";

/**
 * Decode an encoded polyline (precision 5, the OSRM default).
 * Implemented here rather than pulled in as a dependency — it is thirty lines
 * and it is on the hot path for every tracking poll.
 */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ latitude: lat / factor, longitude: lng / factor });
  }

  return points;
}

/**
 * A straight line between two points. Used when routing is unavailable — a map
 * with an approximate line is far better than a map with nothing on it, and the
 * courier marker is the part customers actually watch.
 */
export function straightLine(from: LatLng, to: LatLng): Route {
  const R = 6371e3;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude));
  const distanceMeters = 2 * R * Math.asin(Math.sqrt(h));

  return {
    points: [from, to],
    distanceMeters,
    // ~16 km/h, matching the dispatch model's assumed courier speed.
    durationSeconds: (distanceMeters / 1000 / 16) * 3600,
  };
}

export async function fetchRoute(from: LatLng, to: LatLng): Promise<Route> {
  const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const url = `${ROUTING_URL}/route/v1/cycling/${coords}?overview=full&geometries=polyline`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return straightLine(from, to);

    const payload = (await response.json()) as {
      routes?: { geometry: string; distance: number; duration: number }[];
    };
    const route = payload.routes?.[0];
    if (!route) return straightLine(from, to);

    return {
      points: decodePolyline(route.geometry),
      distanceMeters: route.distance,
      durationSeconds: route.duration,
    };
  } catch {
    // Never let a routing outage break order tracking.
    return straightLine(from, to);
  }
}
