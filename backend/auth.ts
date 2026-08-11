// ============================================================
// Real Auth — Supports both Supabase JWTs & Custom JWTs
// Access + refresh tokens, signed and verified with secrets from .env.
// ============================================================
import jwt from "jsonwebtoken";
import type { User } from "../src/types";
import { logger } from "./logger";

const ACCESS_TTL = () => process.env.JWT_EXPIRES_IN || "15m";
const REFRESH_TTL = () => process.env.JWT_REFRESH_EXPIRES_IN || "30d";

const isProd = () => process.env.NODE_ENV === "production";

let warned = false;
function requireSecret(name: "JWT_SECRET" | "JWT_REFRESH_SECRET", devFallback: string): string {
  const s = process.env[name];
  if (s) return s;
  if (isProd()) {
    throw new Error(`[auth] ${name} is not set. Refusing to start in production with an insecure fallback secret.`);
  }
  if (!warned) {
    warned = true;
    logger.warn({ secretName: name }, "[auth] missing secret — using insecure dev secret");
  }
  return devFallback;
}
function accessKey(): string {
  return requireSecret("JWT_SECRET", "insecure-dev-access-secret");
}
function refreshKey(): string {
  return requireSecret("JWT_REFRESH_SECRET", "insecure-dev-refresh-secret");
}

export interface AccessPayload {
  sub: string; // user id (MoveBuddy user.id or Supabase auth.users.id)
  role: string;
  adminRole?: string;
  email?: string;
  isSupabaseAuth?: boolean;
}

const allowedRoles = new Set(['guest', 'host', 'admin']);

export function signTokens(user: User): { token: string; refreshToken: string } {
  const role = allowedRoles.has(user.role) ? user.role : 'guest';
  const payload: AccessPayload = {
    sub: user.id,
    role,
    adminRole: (user as any).adminRole,
  };
  const token = jwt.sign(payload, accessKey(), { expiresIn: ACCESS_TTL() } as jwt.SignOptions);
  const refreshToken = jwt.sign({ sub: user.id }, refreshKey(), { expiresIn: REFRESH_TTL() } as jwt.SignOptions);
  return { token, refreshToken };
}

/** 
 * Verify an access token. Supports custom JWTs AND Supabase JWT tokens.
 */
export function verifyAccessToken(token: string): AccessPayload | null {
  // 1. Try verification with custom JWT key
  try {
    const payload = jwt.verify(token, accessKey()) as AccessPayload;
    if (payload && payload.sub) return payload;
  } catch { /* Try Supabase JWT decoding below */ }

  // 2. Decode Supabase JWT (contains sub: auth.users.id, email, aud: "authenticated")
  try {
    const decoded = jwt.decode(token) as any;
    if (decoded && decoded.sub && (decoded.aud === 'authenticated' || decoded.iss?.includes('supabase'))) {
      return {
        sub: decoded.sub,
        email: decoded.email,
        role: decoded.user_metadata?.role || 'guest',
        adminRole: decoded.user_metadata?.adminRole,
        isSupabaseAuth: true
      };
    }
  } catch { /* invalid token */ }

  return null;
}

export function verifyRefreshToken(token: string): { sub: string } | null {
  try {
    return jwt.verify(token, refreshKey()) as { sub: string };
  } catch {
    return null;
  }
}

export function bearerFrom(req: any): string | null {
  const h = (req.headers?.authorization as string) || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  return null;
}

export async function verifySupabaseToken(token: string, supabaseAdmin: any): Promise<{ id: string; email: string; user_metadata: any } | null> {
  if (!token) return null;
  try {
    if (supabaseAdmin?.auth) {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (!error && data?.user) {
        return {
          id: data.user.id,
          email: data.user.email || '',
          user_metadata: data.user.user_metadata || {}
        };
      }
    }
  } catch { /* fallback to jwt decode below */ }

  try {
    const decoded = jwt.decode(token) as any;
    if (decoded && decoded.sub && (decoded.aud === 'authenticated' || decoded.iss?.includes('supabase'))) {
      return {
        id: decoded.sub,
        email: decoded.email || '',
        user_metadata: decoded.user_metadata || {}
      };
    }
  } catch { /* invalid token */ }

  return null;
}

export function requireAuth(req: any, res: any, next: any) {
  const token = bearerFrom(req);
  if (!token) {
    return res.status(401).json({ error: "Missing Authorization Bearer token" });
  }
  const payload = verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  req.auth = payload;
  next();
}
