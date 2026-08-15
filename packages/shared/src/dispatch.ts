/**
 * Courier assignment scoring.
 *
 * Nearest-courier is the obvious approach and it degrades badly under load: it
 * starves couriers who happen to be positioned away from dense merchant clusters
 * and it ignores batching entirely. This scores candidates on four axes instead.
 */

export interface CourierCandidate {
  courierId: string;
  distanceToPickupKm: number;
  /** Assignments currently in flight for this courier. */
  activeAssignments: number;
  /** How far below the shift's expected earnings this courier is, in cents. */
  earningsDeficit: number;
  /** True if they already hold an order from the same merchant. */
  sameMerchantBatch: boolean;
  /** Bearing difference to an existing drop, in degrees. 180 = opposite way. */
  headingDeltaDeg: number | null;
  ageCheckCertified: boolean;
}

export interface DispatchContext {
  /** Seconds until the order is expected to be ready for pickup. */
  prepEtaSeconds: number;
  requiresAgeCheck: boolean;
  /** Average courier speed, km/h, by vehicle mix in this city. */
  avgSpeedKmh?: number;
}

export interface ScoredCourier {
  courierId: string;
  score: number;
  reasonCodes: string[];
}

const W_ETA = 1.0;
const W_FAIRNESS = 0.4;
const W_BATCH = 0.8;
const W_LOAD = 0.6;

const MAX_ACTIVE_ASSIGNMENTS = 3;

/**
 * Lower is better. Returns candidates sorted best-first, with the reason codes
 * that produced each score — those are what makes the Platform Work Directive's
 * algorithmic-transparency duty answerable.
 */
export function scoreCouriers(
  candidates: CourierCandidate[],
  ctx: DispatchContext,
): ScoredCourier[] {
  const speed = ctx.avgSpeedKmh ?? 16;

  return candidates
    .filter((c) => {
      if (c.activeAssignments >= MAX_ACTIVE_ASSIGNMENTS) return false;
      // An uncertified courier legally cannot complete an age-restricted handover.
      if (ctx.requiresAgeCheck && !c.ageCheckCertified) return false;
      return true;
    })
    .map((c) => {
      const reasonCodes: string[] = [];

      const travelSeconds = (c.distanceToPickupKm / speed) * 3600;
      // Arriving before the food is ready is not a benefit — it is idle time at a
      // counter. Only lateness against prep time is penalised.
      const waitPenalty = Math.max(0, travelSeconds - ctx.prepEtaSeconds);
      const etaTerm = (W_ETA * waitPenalty) / 60;
      if (c.distanceToPickupKm < 1.5) reasonCodes.push("PROXIMITY");

      // Levelling earnings across the shift keeps the wage top-up bill down and
      // stops the same couriers absorbing all the slow jobs.
      const fairnessTerm = -W_FAIRNESS * (c.earningsDeficit / 100);
      if (c.earningsDeficit > 500) reasonCodes.push("EARNINGS_BALANCE");

      let batchTerm = 0;
      if (c.sameMerchantBatch) {
        batchTerm -= W_BATCH * 10;
        reasonCodes.push("BATCH_SAME_MERCHANT");
      } else if (c.headingDeltaDeg != null && c.headingDeltaDeg < 45) {
        batchTerm -= W_BATCH * 5;
        reasonCodes.push("BATCH_SAME_DIRECTION");
      }

      const loadTerm = W_LOAD * c.activeAssignments * 5;
      if (c.activeAssignments === 0) reasonCodes.push("IDLE");

      return {
        courierId: c.courierId,
        score: etaTerm + fairnessTerm + batchTerm + loadTerm,
        reasonCodes,
      };
    })
    .sort((a, b) => a.score - b.score);
}

/** Haversine distance in km. */
export function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * ETA shown to the customer. Deliberately padded and rounded up to a 5-minute
 * boundary: customers forgive slow, they do not forgive wrong.
 */
export function customerEtaMinutes(prepSeconds: number, travelSeconds: number): number {
  const raw = (prepSeconds + travelSeconds) / 60;
  const padded = raw * 1.15 + 4;
  return Math.ceil(padded / 5) * 5;
}
