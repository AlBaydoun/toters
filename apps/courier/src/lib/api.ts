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

export interface ChatMessage {
  id: string;
  sender: "CUSTOMER" | "COURIER" | "SYSTEM";
  kind: "TEXT" | "IMAGE" | "QUICK_REPLY" | "LOCATION";
  body: string | null;
  mediaUrl: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ChatThread {
  conversationId: string;
  closed: boolean;
  quickReplies: string[];
  messages: ChatMessage[];
}

/** Raw binary upload — one file, no other fields, so multipart adds nothing. */
export async function uploadImage(uri: string, mimeType: string) {
  const blob = await (await fetch(uri)).blob();
  const response = await fetch(`${BASE_URL}/media/upload`, {
    method: "POST",
    headers: {
      "Content-Type": mimeType,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: blob,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = (payload as { error?: { code: string; message: string } }).error;
    throw new ApiError(err?.code ?? "UPLOAD_FAILED", err?.message ?? "Upload fehlgeschlagen.");
  }
  return payload as { mediaId: string; url: string; metadataStripped: boolean };
}

export function chatSocketUrl(orderId: string) {
  return `${BASE_URL.replace(/^http/, "ws")}/orders/${orderId}/chat/live`;
}

export interface CourierFeedback {
  rating: number | null;
  ratingCount: number;
  compliments: { code: string; count: number }[];
  reviews: {
    id: string;
    rating: number | null;
    comment: string | null;
    compliments: string[];
    createdAt: string;
    contested: boolean;
    resolved: boolean;
    canContest: boolean;
  }[];
  yourRights: { explanation: string; contact: string };
}

export const api = {
  feedback: () => request<CourierFeedback>("/me/courier/feedback"),

  contestReview: (reviewId: string, reason: string) =>
    request<{ contested: boolean; message: string }>(
      `/me/courier/feedback/${reviewId}/contest`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),

  setPhoto: (mediaId: string) =>
    request<{ photoUrl: string; consentAt: string | null }>("/me/courier/photo", {
      method: "PUT",
      body: JSON.stringify({ mediaId, consent: true }),
    }),

  removePhoto: () => request<{ removed: boolean }>("/me/courier/photo", { method: "DELETE" }),

  chat: (orderId: string) => request<ChatThread>(`/orders/${orderId}/chat`),

  sendMessage: (
    orderId: string,
    body: { kind?: "TEXT" | "QUICK_REPLY"; body?: string; mediaId?: string },
  ) =>
    request<ChatMessage>(`/orders/${orderId}/chat/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

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
      // actorType is no longer accepted from the body — it comes from the token.
      body: JSON.stringify({ to }),
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
