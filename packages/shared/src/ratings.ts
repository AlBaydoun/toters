/**
 * Rating aggregation.
 *
 * Pure, because the rules here are easy to get subtly wrong and the failure is
 * invisible: a rating that quietly includes disputed feedback, or that displays
 * "5.0" off a single review, looks completely normal until someone's livelihood
 * depends on it.
 */

export interface RatingInput {
  /** Null when the reviewer skipped this half of the form. */
  score: number | null;
  /** Contested feedback stops counting until a human resolves it. */
  contested?: boolean;
}

export interface RatingSummary {
  /** Null until the sample is large enough to mean anything. */
  display: number | null;
  /** Underlying average, whether or not it is shown. */
  average: number;
  count: number;
  excludedAsContested: number;
}

/**
 * Below this, an average is noise. Showing "5.0" off one delivery flatters
 * nobody and misleads the customer who reads it as a track record.
 */
export const MIN_RATINGS_TO_DISPLAY = 5;

export function summariseRatings(
  reviews: RatingInput[],
  minToDisplay = MIN_RATINGS_TO_DISPLAY,
): RatingSummary {
  const scored = reviews.filter((r) => r.score != null);
  const counted = scored.filter((r) => !r.contested);
  const excludedAsContested = scored.length - counted.length;

  if (counted.length === 0) {
    return { display: null, average: 0, count: 0, excludedAsContested };
  }

  const total = counted.reduce((sum, r) => sum + (r.score ?? 0), 0);
  const average = total / counted.length;

  return {
    display: counted.length >= minToDisplay ? Math.round(average * 10) / 10 : null,
    average,
    count: counted.length,
    excludedAsContested,
  };
}

/**
 * Whether a courier's rating warrants a human looking at it.
 *
 * Deliberately returns a flag rather than an action. Under the EU Platform Work
 * Directive a decision that materially affects a platform worker requires human
 * review, so nothing here may ever deactivate an account on its own.
 */
export interface FlagDecision {
  flagForHumanReview: boolean;
  reason: string | null;
  /** Always false. Present so that any future caller must confront it. */
  automatedActionPermitted: false;
}

export function evaluateCourierRating(
  summary: RatingSummary,
  threshold = 3.5,
  minSample = 20,
): FlagDecision {
  if (summary.count < minSample) {
    return {
      flagForHumanReview: false,
      reason: null,
      automatedActionPermitted: false,
    };
  }
  if (summary.average >= threshold) {
    return { flagForHumanReview: false, reason: null, automatedActionPermitted: false };
  }
  return {
    flagForHumanReview: true,
    reason: `Average ${summary.average.toFixed(2)} over ${summary.count} ratings is below ${threshold}.`,
    automatedActionPermitted: false,
  };
}

/** Most-mentioned compliments first, for a profile card. */
export function topCompliments<T extends string>(
  reviews: { compliments: T[]; contested?: boolean }[],
  limit = 3,
): { code: T; count: number }[] {
  const counts = new Map<T, number>();
  for (const review of reviews) {
    if (review.contested) continue;
    for (const code of review.compliments) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([code, count]) => ({ code, count }));
}
