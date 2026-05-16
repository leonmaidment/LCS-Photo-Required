import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Visit } from '../types/visit';

/**
 * Local persistence layer.
 *
 * - Drafts and visit history live in AsyncStorage as a single JSON
 *   document. Adequate for tens-to-hundreds of visits; if usage grows
 *   beyond that, swap this implementation for SQLite without changing
 *   the API.
 * - Auth token lives in expo-secure-store (Keychain on iOS, encrypted
 *   on Android).
 */

const VISITS_KEY = 'lcs.visits.v1';
const TOKEN_KEY = 'lcs.auth.token';
const USER_KEY = 'lcs.auth.user';

export async function loadVisits(): Promise<Visit[]> {
  try {
    const raw = await AsyncStorage.getItem(VISITS_KEY);
    if (!raw) return [];
    const parsed: Visit[] = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveVisits(visits: Visit[]): Promise<void> {
  await AsyncStorage.setItem(VISITS_KEY, JSON.stringify(visits));
}

export async function upsertVisit(visit: Visit): Promise<Visit[]> {
  const all = await loadVisits();
  const idx = all.findIndex(v => v.id === visit.id);
  const next = { ...visit, updatedAt: new Date().toISOString() };
  if (idx >= 0) all[idx] = next;
  else all.unshift(next);
  await saveVisits(all);
  return all;
}

export async function deleteVisit(id: string): Promise<Visit[]> {
  const all = await loadVisits();
  const next = all.filter(v => v.id !== id);
  await saveVisits(next);
  return next;
}

// --- Auth -------------------------------------------------------------------

export async function setAuthToken(token: string, user?: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  if (user) await SecureStore.setItemAsync(USER_KEY, user);
}

export async function getAuthToken(): Promise<string | null> {
  try {
    return (await SecureStore.getItemAsync(TOKEN_KEY)) || null;
  } catch {
    return null;
  }
}

export async function getAuthUser(): Promise<string | null> {
  try {
    return (await SecureStore.getItemAsync(USER_KEY)) || null;
  } catch {
    return null;
  }
}

export async function clearAuth(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(USER_KEY).catch(() => undefined);
}
