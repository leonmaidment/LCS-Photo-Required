import 'react-native-gesture-handler';
import React from 'react';
// `crypto.getRandomValues` polyfill for `uuid` on RN
import 'react-native-get-random-values';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ActivityIndicator, View } from 'react-native';

import { AuthProvider, useAuth } from './src/store/AuthContext';
import { VisitStoreProvider } from './src/store/VisitStore';
import { colors } from './src/theme/theme';

import DashboardScreen from './src/screens/DashboardScreen';
import NewVisitScreen from './src/screens/NewVisitScreen';
import RecordScreen from './src/screens/RecordScreen';
import ReviewScreen from './src/screens/ReviewScreen';
import VisitDetailScreen from './src/screens/VisitDetailScreen';

export type RootStackParamList = {
  Dashboard: undefined;
  NewVisit: { visitId: string };
  Record: { visitId: string };
  Review: { visitId: string };
  VisitDetail: { visitId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

function Routes() {
  const { ready } = useAuth();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  // Mock-mode mobile flow: no login required. App opens directly on the
  // Visits dashboard. The backend may still enforce auth in production —
  // see README for re-enabling the gate.
  return (
    <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="Dashboard" component={DashboardScreen} />
      <Stack.Screen name="NewVisit" component={NewVisitScreen} />
      <Stack.Screen name="Record" component={RecordScreen} />
      <Stack.Screen name="Review" component={ReviewScreen} />
      <Stack.Screen name="VisitDetail" component={VisitDetailScreen} />
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <VisitStoreProvider>
          <StatusBar style="light" />
          <NavigationContainer>
            <Routes />
          </NavigationContainer>
        </VisitStoreProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
