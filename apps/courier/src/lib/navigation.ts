import type { NativeStackScreenProps } from "@react-navigation/native-stack";

export type RootStackParamList = {
  Shift: undefined;
  Offer: { assignmentId: string; orderId: string };
  Delivery: { orderId: string };
  AgeCheck: { orderId: string; requiredAge: number };
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;
