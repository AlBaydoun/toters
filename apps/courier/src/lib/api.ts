import * as SecureStore from "expo-secure-store";

const BASE_URL = "http://10.0.2.2:4000/v1";

let accessToken: string | null = null;

export async function loadSession() {
  accessToken = await SecureStore.getItemAsync("courierAccessToken");
  return accessToken;
}

export async function getCourierId() {
  return SecureStore.getItemAsync("courierId");
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = (payload as { error?: { code: string; message: string; details?: unknown } }).error;
    throw new ApiError(err?.code ?? "UNKNOWN", err?.message ?? "Fehler", err?.details);
  }
  return payload as T;
}

export interface ShiftState {
  active: boolean;
  shiftId?: string;
  startedAt?: string;
  dropsCompleted?: number;
  earnedCents?: number;
  projectedFloorCents?: number;
  projectedTopUpCents?: number;
  projectedTotalCents?: number;
}

export interface ShiftSummary {
  workedSeconds: number;
  dropsCompleted: number;
  earnedCents: number;
  wageFloorCents: number;
  topUpCents: number;
  totalPayableCents: number;
  complianceIssues: { code: string; message: string }[];
}

export interface AssignmentExplanation {
  assignmentId: string;
  decidedAt: string;
  factors: { code: string; explanation: string }[];
  humanReviewContact: string;
}

export const api = {
  currentShift: (courierId: string) => request<ShiftState>(`/shifts/current?courierId=${courierId}`),

  startShift: (courierId: string) =>
    request<{ shiftId: string; startedAt: string; guaranteedHourlyRate: number }>("/shifts/start", {
      method: "POST",
      body: JSON.stringify({ courierId }),
    }),

  endShift: (shiftId: string, breakSeconds: number) =>
    request<ShiftSummary>(`/shifts/${shiftId}/end`, {
      method: "POST",
      body: JSON.stringify({ breakSeconds }),
    }),

  respondToOffer: (assignmentId: string, accept: boolean) =>
    request<{ status: string }>(`/dispatch/assignments/${assignmentId}/respond`, {
      method: "POST",
      body: JSON.stringify({ accept }),
    }),

  explainAssignment: (assignmentId: string) =>
    request<AssignmentExplanation>(`/dispatch/assignments/${assignmentId}/explanation`),

  pingLocation: (courierId: string, latitude: number, longitude: number, accuracy?: number) =>
    request<{ ok: boolean }>("/dispatch/location", {
      method: "POST",
      body: JSON.stringify({ courierId, latitude, longitude, accuracy }),
    }),

  transition: (orderId: string, to: string) =>
    request<{ status: string; settlement?: unknown }>(`/orders/${orderId}/transition`, {
      method: "POST",
      body: JSON.stringify({ to, actorType: "COURIER" }),
    }),

  proposeSubstitution: (orderId: string, orderItemId: string, replacementProductId: string | null) =>
    request<{ priceDelta: number; expiresInSeconds: number }>(`/orders/${orderId}/substitutions`, {
      method: "POST",
      body: JSON.stringify({ orderItemId, replacementProductId }),
    }),

  markUnavailable: (orderId: string, itemId: string) =>
    request<{ newTotal: number }>(`/orders/${orderId}/items/${itemId}/unavailable`, { method: "POST" }),

  verifyAge: (orderId: string, verified: boolean, documentType: string | null) =>
    request<{ verified: boolean }>(`/orders/${orderId}/age-check`, {
      method: "POST",
      body: JSON.stringify({ verified, documentType }),
    }),
};
