import { supabase } from './supabaseClient';

const TOKEN_KEY = 'mb_token';
const REFRESH_KEY = 'mb_refresh';

export function setTokens(token?: string, refreshToken?: string) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  // Also sign out from Supabase Auth
  try {
    supabase.auth.signOut();
  } catch { /* ignore */ }
}
