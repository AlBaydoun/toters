const BASE_URL = "/v1";

let accessToken: string | null = localStorage.getItem("merchantAccessToken");

export function isSignedIn() {
  return accessToken != null;
}

export function signOut() {
  accessToken = null;
  localStorage.removeItem("merchantAccessToken");
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

  if (response.status === 401) {
    signOut();
    throw new ApiError("UNAUTHORIZED", "Sitzung abgelaufen. Bitte neu anmelden.");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = (payload as { error?: { code: string; message: string; details?: unknown } }).error;
    throw new ApiError(err?.code ?? "UNKNOWN", err?.message ?? "Fehler", err?.details);
  }
  return payload as T;
}

export interface QueueOrder {
  id: string;
  reference: string;
  status: string;
  placedAt: string | null;
  scheduledFor: string | null;
  fulfilmentMode: string;
  itemsSubtotal: number;
  requiredAge: number | null;
  courier: { firstName: string; vehicle: string } | null;
  destination: string;
  minutesWaiting: number | null;
  items: {
    id: string; name: string; quantity: number; note: string | null;
    substitutionStatus: string | null; options: string[];
  }[];
}

export interface StoreInfo {
  id: string;
  name: string;
  status: string;
  type: string;
  avgPrepMinutes: number;
  minimumBasket: number | null;
  commissionBps: number;
  rating: number;
  ratingCount: number;
  openingHours: { weekday: number; opensAt: string; closesAt: string }[];
  trader: { legalName: string; registrationNo: string; vatId: string; verifiedAt: string | null };
  compliance: { productsBlockedByMissingAllergens: number };
}

export interface MerchantProduct {
  id: string;
  name: string;
  category: { id: string; name: string } | null;
  price: number;
  vatCategory: string;
  isAvailable: boolean;
  stockCount: number | null;
  allergens: string[];
  additives: string[];
  allergenDataComplete: boolean;
  minimumAge: number | null;
  depositScheme: string;
  contentAmount: number | null;
  contentUnit: string | null;
  blockedReason: string | null;
}

export interface Statement {
  period: { from: string; to: string };
  orderCount: number;
  goodsTotal: number;
  depositTotal: number;
  commissionBps: number;
  commission: number;
  payout: number;
  orders: { reference: string; deliveredAt: string | null; goods: number; deposit: number; commission: number }[];
}

export const api = {
  async login(email: string, password: string) {
    const result = await request<{
      accessToken: string;
      merchant: { id: string; name: string; status: string };
      staff: { id: string; role: string; firstName: string | null };
    }>("/auth/merchant/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    accessToken = result.accessToken;
    localStorage.setItem("merchantAccessToken", result.accessToken);
    return result;
  },

  orders: (scope: "live" | "today" | "history" = "live") =>
    request<QueueOrder[]>(`/merchant/orders?scope=${scope}`),

  accept: (id: string, prepMinutes?: number) =>
    request<{ status: string }>(`/merchant/orders/${id}/accept`, {
      method: "POST",
      body: JSON.stringify(prepMinutes ? { prepMinutes } : {}),
    }),

  reject: (id: string, reason: string) =>
    request<{ status: string }>(`/merchant/orders/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  ready: (id: string) =>
    request<{ status: string }>(`/merchant/orders/${id}/ready`, { method: "POST" }),

  store: () => request<StoreInfo>("/merchant/store"),

  pause: (paused: boolean) =>
    request<{ status: string }>("/merchant/store/pause", {
      method: "POST",
      body: JSON.stringify({ paused }),
    }),

  updateStore: (body: { avgPrepMinutes?: number; minimumBasket?: number }) =>
    request<{ avgPrepMinutes: number }>("/merchant/store", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  products: () => request<MerchantProduct[]>("/merchant/products"),

  setAvailability: (id: string, isAvailable: boolean) =>
    request<{ id: string; isAvailable: boolean }>(`/merchant/products/${id}/availability`, {
      method: "POST",
      body: JSON.stringify({ isAvailable }),
    }),

  saveFoodInfo: (
    id: string,
    body: { allergens: string[]; additives: string[]; confirmed: boolean; minimumAge?: number | null },
  ) =>
    request<{ allergenDataComplete: boolean; sellable: boolean }>(
      `/merchant/products/${id}/food-info`,
      { method: "PUT", body: JSON.stringify(body) },
    ),

  statement: (from: string, to: string) =>
    request<Statement>(`/merchant/statement?from=${from}&to=${to}`),
};
