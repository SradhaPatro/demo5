// Global fetch interceptor: attaches the JWT (Authorization: Bearer) to every
// same-origin /api request, and transparently refreshes an expired access token
// once on a 401 before retrying. Imported for its side effect in main.tsx.
import { getToken, getRefreshToken, setTokens, clearTokens } from './session';

// In production (Vercel), VITE_API_URL is set to the Railway backend URL
// e.g. https://movebuddy-backend.up.railway.app
// In development, it's empty so /api/* calls go to the local dev server.
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || '';

const origFetch = window.fetch.bind(window);

// Auth endpoints must NOT carry/refresh a Bearer token themselves.
const AUTH_EXEMPT = /\/api\/auth\/(login|register|verify-otp|refresh)\b/;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return (input as Request).url;
}

// Rewrite relative /api/* paths to full Railway URL in production
function resolveUrl(url: string): string {
  if (API_BASE && url.startsWith('/api/')) {
    return `${API_BASE}${url}`;
  }
  return url;
}

function withAuth(init: RequestInit = {}): RequestInit {
  const token = getToken();
  if (!token) return init;
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

// De-duplicate concurrent refreshes.
let refreshing: Promise<boolean> | null = null;
function tryRefresh(): Promise<boolean> {
  const rt = getRefreshToken();
  if (!rt) return Promise.resolve(false);
  if (!refreshing) {
    // Use resolveUrl so the refresh request hits the Railway backend in production,
    // not the Vercel origin (which would 404).
    refreshing = origFetch(resolveUrl('/api/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.token) {
          setTokens(data.token, data.refreshToken);
          return true;
        }
        return false;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

const customFetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const rawUrl = urlOf(input);
  const url = resolveUrl(rawUrl);
  // Rebuild input with resolved URL if it changed
  const resolvedInput = url !== rawUrl ? url : input;

  if (!rawUrl.includes('/api/') || AUTH_EXEMPT.test(rawUrl)) {
    return origFetch(resolvedInput, init);
  }

  let res = await origFetch(resolvedInput, withAuth(init));
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await origFetch(resolvedInput, withAuth(init));
    } else {
      // Session is no longer valid — clear it and notify the app to return to login.
      clearTokens();
      window.dispatchEvent(new Event('mb:session-expired'));
    }
  }
  return res;
};

try {
  window.fetch = customFetch;
} catch (e) {
  Object.defineProperty(window, 'fetch', {
    value: customFetch,
    configurable: true,
    writable: true,
    enumerable: true
  });
}
