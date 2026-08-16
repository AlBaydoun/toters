import React, { useEffect, useState } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { loadSession } from "./src/lib/api";
import type { RootStackParamList } from "./src/lib/navigation";
import { ShiftScreen } from "./src/screens/ShiftScreen";
import { OfferScreen } from "./src/screens/OfferScreen";
import { DeliveryScreen } from "./src/screens/DeliveryScreen";
import { AgeCheckScreen } from "./src/screens/AgeCheckScreen";
import { ChatScreen } from "./src/screens/ChatScreen";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => { void loadSession().finally(() => setReady(true)); }, []);
  if (!ready) return null;

  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: "#14201B" },
          headerTintColor: "#F4F7F5",
          headerShadowVisible: false,
          contentStyle: { backgroundColor: "#14201B" },
        }}
      >
        <Stack.Screen name="Shift" component={ShiftScreen} options={{ title: "Liefero Kurier" }} />
        <Stack.Screen
          name="Offer"
          component={OfferScreen}
          options={{ headerShown: false, presentation: "fullScreenModal" }}
        />
        <Stack.Screen name="Delivery" component={DeliveryScreen} options={{ title: "Lieferung" }} />
        <Stack.Screen name="AgeCheck" component={AgeCheckScreen} options={{ title: "Ausweiskontrolle" }} />
        <Stack.Screen name="Chat" component={ChatScreen} options={{ title: "Chat mit dem Kunden" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
