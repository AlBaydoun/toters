import * as SecureStore from "expo-secure-store";

const BASE_URL = "http://10.0.2.2:4000/v1"; // Android emulator -> host machine

let accessToken: string | null = null;

export async function loadSession() {
  accessToken = await SecureStore.getItemAsync("accessToken");
  return accessToken;
}

export async function saveSession(access: string, refresh: string) {
  accessToken = access;
  await SecureStore.setItemAsync("accessToken", access);
  await SecureStore.setItemAsync("refreshToken", refresh);
}

export async function clearSession() {
  accessToken = null;
  await SecureStore.deleteItemAsync("accessToken");
  await SecureStore.deleteItemAsync("refreshToken");
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  // One transparent refresh attempt, then surface the failure to the caller.
  if (response.status === 401 && retry) {
    const refreshed = await tryRefresh();
    if (refreshed) return request<T>(path, init, false);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = (payload as { error?: { code: string; message: string; details?: unknown } }).error;
    throw new ApiError(err?.code ?? "UNKNOWN", err?.message ?? "Something went wrong.", err?.details);
  }
  return payload as T;
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = await SecureStore.getItemAsync("refreshToken");
  if (!refreshToken) return false;
  try {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { accessToken: string; refreshToken: string };
    await saveSession(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export const api = {
  requestOtp: (destination: string) =>
    request<{ sent: boolean }>("/auth/otp/request", { method: "POST", body: JSON.stringify({ destination }) }),

  verifyOtp: (destination: string, code: string) =>
    request<{ accessToken: string; refreshToken: string }>("/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ destination, code }),
    }),

  discover: (latitude: number, longitude: number, type?: string) =>
    request<DiscoverResponse>(
      `/discover?latitude=${latitude}&longitude=${longitude}${type ? `&type=${type}` : ""}`,
    ),

  merchant: (slug: string) => request<MerchantDetail>(`/merchants/${slug}`),

  cart: () => request<Cart>("/cart"),

  addToCart: (productId: string, quantity: number, optionIds: string[] = []) =>
    request<Cart>("/cart/items", {
      method: "POST",
      body: JSON.stringify({ productId, quantity, optionIds }),
    }),

  updateCartItem: (itemId: string, quantity: number) =>
    request<Cart>(`/cart/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ quantity }) }),

  quote: (addressId: string, opts: { promoCode?: string; tipAmount?: number; useCredit?: boolean } = {}) =>
    request<Quote>("/checkout/quote", { method: "POST", body: JSON.stringify({ addressId, ...opts }) }),

  checkout: (addressId: string, opts: { promoCode?: string; tipAmount?: number; useCredit?: boolean } = {}) =>
    request<CheckoutResult>("/checkout", { method: "POST", body: JSON.stringify({ addressId, ...opts }) }),

  orders: () => request<OrderSummary[]>("/orders"),

  tracking: (orderId: string) => request<Tracking>(`/orders/${orderId}/tracking`),

  cancelOrder: (orderId: string, reason?: string) =>
    request<{ charged: number; refundedAsCredit: number }>(`/orders/${orderId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  addresses: () => request<Address[]>("/me/addresses"),

  createAddress: (body: Omit<Address, "id" | "serviceable">) =>
    request<Address>("/me/addresses", { method: "POST", body: JSON.stringify(body) }),

  serviceability: (latitude: number, longitude: number) =>
    request<{ serviceable: boolean; zoneId: string | null; cityName: string | null }>(
      `/serviceability?latitude=${latitude}&longitude=${longitude}`,
    ),

  createButler: (body: { addressId: string; request: string; budget: number }) =>
    request<{ orderId: string; reference: string; authorisedTotal: number }>("/butler", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

// --- Response shapes -------------------------------------------------------

export interface Address {
  id: string;
  label: string | null;
  street: string;
  houseNumber: string;
  floor: string | null;
  entryCode: string | null;
  postalCode: string;
  city: string;
  latitude: number;
  longitude: number;
  deliveryNote: string | null;
  isDefault: boolean;
  serviceable: boolean;
}

export interface MerchantCard {
  id: string; slug: string; name: string; type: string;
  logoUrl: string | null; coverUrl: string | null;
  rating: number; ratingCount: number; distanceKm: number;
  deliveryFee: number; minimumBasket: number; etaMinutes: number;
  isOpen: boolean; sponsored: boolean;
}

export interface DiscoverResponse {
  serviceable: boolean;
  zoneId: string | null;
  merchants: MerchantCard[];
  waitlistEligible?: boolean;
}

export interface Product {
  id: string; name: string; description: string | null; imageUrl: string | null;
  price: number; compareAtPrice: number | null;
  unitPrice: string | null;
  allergens: string[]; additives: string[]; allergenDataComplete: boolean;
  minimumAge: number | null; depositScheme: string; nutriScore: string | null;
  inStock: boolean;
  optionGroups?: { id: string; name: string; minSelect: number; maxSelect: number; options: { id: string; name: string; priceDelta: number }[] }[];
}

export interface MerchantDetail {
  id: string; slug: string; name: string; type: string;
  description: string | null; coverUrl: string | null;
  rating: number; ratingCount: number; isOpen: boolean;
  trader: { legalName: string; legalAddress: string; registrationNo: string; vatId: string; contactEmail: string };
  categories: { id: string; name: string; products: Product[] }[];
}

export interface Cart {
  id: string; merchantId: string | null;
  items: { id: string; productId: string; name: string; imageUrl: string | null; unitPrice: number; quantity: number; lineTotal: number; allergens: string[]; minimumAge: number | null }[];
  subtotal: number;
  requiredAge: number | null;
}

export interface Quote {
  itemsSubtotal: number; depositTotal: number; deliveryFee: number; serviceFee: number;
  smallBasketSurcharge: number; discountTotal: number; creditApplied: number;
  tipAmount: number; grandTotal: number;
  vatBreakdown: Record<string, number>; totalVat: number;
  requiredAge: number | null;
}

export interface CheckoutResult {
  orderId: string; reference: string; status: string; grandTotal: number;
  withdrawalNotice: string; nextAction: string;
}

export interface OrderSummary {
  id: string; reference: string; status: string; isActive: boolean;
  merchantName: string; merchantLogo: string | null;
  grandTotal: number; itemCount: number; etaMinutes: number | null;
  placedAt: string | null; deliveredAt: string | null;
}

export interface Tracking {
  id: string; reference: string; status: string; etaMinutes: number | null;
  requiredAge: number | null; ageVerifiedAt: string | null;
  merchant: { name: string; latitude: number; longitude: number } | null;
  destination: { latitude: number; longitude: number };
  courier: { firstName: string; rating: number; vehicle: string } | null;
  courierPosition: { latitude: number; longitude: number } | null;
  timeline: { status: string; at: string }[];
  cancellation: { tier: string; customerMayCancel: boolean; explanationKey: string };
}
