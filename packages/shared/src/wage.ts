/**
 * Statutory minimum wage enforcement for employed couriers.
 *
 * This lives in code, not a spreadsheet, because per-drop earnings can fall below
 * the floor on a slow shift and the employer owes the difference regardless.
 * The rate table is dated so historical shifts recompute correctly.
 */
import type { Money } from "./money.js";

interface WageRate {
  from: string; // ISO date the rate takes effect
  centsPerHour: number;
}

/** German gesetzlicher Mindestlohn. */
const DE_MINIMUM_WAGE: WageRate[] = [
  { from: "2024-01-01", centsPerHour: 1241 },
  { from: "2025-01-01", centsPerHour: 1282 },
  { from: "2026-01-01", centsPerHour: 1390 },
  { from: "2027-01-01", centsPerHour: 1460 },
];

export function minimumWageAt(date: Date, country = "DE"): number {
  if (country !== "DE") throw new Error(`No wage table for ${country}`);
  const iso = date.toISOString().slice(0, 10);
  let rate = DE_MINIMUM_WAGE[0]!.centsPerHour;
  for (const entry of DE_MINIMUM_WAGE) {
    if (entry.from <= iso) rate = entry.centsPerHour;
  }
  return rate;
}

export interface ShiftInput {
  startedAt: Date;
  endedAt: Date;
  breakSeconds: number;
  /** Base + per-drop earnings. Tips are excluded: they are not employer wages. */
  earnedCents: Money;
  contractedHourlyRate?: number;
}

export interface WageResult {
  workedSeconds: number;
  floorCents: Money;
  earnedCents: Money;
  topUpCents: Money;
}

export function enforceWageFloor(shift: ShiftInput, country = "DE"): WageResult {
  const grossSeconds = (shift.endedAt.getTime() - shift.startedAt.getTime()) / 1000;
  const workedSeconds = Math.max(0, grossSeconds - shift.breakSeconds);
  const hours = workedSeconds / 3600;

  const statutory = minimumWageAt(shift.startedAt, country);
  // The contract rate governs when it is above the statutory floor.
  const applicable = Math.max(statutory, shift.contractedHourlyRate ?? 0);

  const floorCents = Math.round(hours * applicable);
  const topUpCents = Math.max(0, floorCents - shift.earnedCents);

  return { workedSeconds, floorCents, earnedCents: shift.earnedCents, topUpCents };
}

// ---------------------------------------------------------------------------
// Working-time guards (ArbZG)
// ---------------------------------------------------------------------------

export interface ShiftValidationIssue {
  code: string;
  message: string;
}

const HOUR = 3600;

/**
 * §3 ArbZG: 8h/day, extendable to 10h with compensation.
 * §4: 30 min break above 6h, 45 min above 9h.
 * §5: 11 hours uninterrupted rest between shifts.
 */
export function validateShift(
  shift: { startedAt: Date; endedAt: Date; breakSeconds: number },
  previousShiftEndedAt?: Date,
): ShiftValidationIssue[] {
  const issues: ShiftValidationIssue[] = [];
  const workedSeconds =
    (shift.endedAt.getTime() - shift.startedAt.getTime()) / 1000 - shift.breakSeconds;

  if (workedSeconds > 10 * HOUR) {
    issues.push({ code: "MAX_DAILY_HOURS", message: "Shift exceeds the 10-hour daily maximum (§3 ArbZG)." });
  }
  if (workedSeconds > 9 * HOUR && shift.breakSeconds < 45 * 60) {
    issues.push({ code: "BREAK_45", message: "Shifts over 9 hours require a 45-minute break (§4 ArbZG)." });
  } else if (workedSeconds > 6 * HOUR && shift.breakSeconds < 30 * 60) {
    issues.push({ code: "BREAK_30", message: "Shifts over 6 hours require a 30-minute break (§4 ArbZG)." });
  }
  if (previousShiftEndedAt) {
    const restSeconds = (shift.startedAt.getTime() - previousShiftEndedAt.getTime()) / 1000;
    if (restSeconds < 11 * HOUR) {
      issues.push({ code: "REST_11", message: "Less than 11 hours rest since the previous shift (§5 ArbZG)." });
    }
  }
  return issues;
}
