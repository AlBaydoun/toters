import type { NativeStackScreenProps } from "@react-navigation/native-stack";

/**
 * One typed param list for the whole stack. Without this each screen invents its
 * own shape for `route`/`navigation` and the compiler can't check that a
 * navigate() call passes the params the destination actually needs.
 */
export type RootStackParamList = {
  Discover: undefined;
  Merchant: { slug: string };
  /** Optional: the screen falls back to the account default address. */
  Butler: { addressId?: string } | undefined;
  Checkout: { addressId: string };
  Tracking: { orderId: string };
  Chat: { orderId: string };
  Review: { orderId: string; courierName: string | null; courierPhotoUrl: string | null };
  AddressPicker: undefined;
  Waitlist: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;
