import React, { useEffect, useState } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { theme } from "./src/lib/theme";
import { loadSession } from "./src/lib/api";
import { DiscoverScreen } from "./src/screens/DiscoverScreen";
import { CheckoutScreen } from "./src/screens/CheckoutScreen";
import { TrackingScreen } from "./src/screens/TrackingScreen";
import { ButlerScreen } from "./src/screens/ButlerScreen";
import { ChatScreen } from "./src/screens/ChatScreen";
import { ReviewScreen } from "./src/screens/ReviewScreen";
import { BonusScreen } from "./src/screens/BonusScreen";

import type { RootStackParamList } from "./src/lib/navigation";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadSession().finally(() => setReady(true));
  }, []);

  if (!ready) return null;

  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="Discover" component={DiscoverScreen} options={{ title: "Liefero" }} />
        <Stack.Screen name="Butler" component={ButlerScreen} options={{ title: "Butler" }} />
        <Stack.Screen name="Checkout" component={CheckoutScreen} options={{ title: "Kasse" }} />
        <Stack.Screen name="Tracking" component={TrackingScreen} options={{ title: "Deine Bestellung" }} />
        <Stack.Screen name="Chat" component={ChatScreen} options={{ title: "Chat mit dem Kurier" }} />
        <Stack.Screen name="Review" component={ReviewScreen} options={{ title: "Bewerten" }} />
        <Stack.Screen name="Bonus" component={BonusScreen} options={{ title: "Bonus" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
