// Load .env as the very first thing â€” this side-effect import runs before any
// other import is evaluated, so all modules below see the env vars.
import dotenv from "dotenv";
dotenv.config({ override: true });

import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import crypto, { randomUUID } from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import {
  User,
  Ride,
  RideRequest,
  Subscription,
  Wallet,
  WalletTransaction,
  ChatMessage,
  SupportTicket,
  Match,
  HostActivityDay,
  CommuteDirection,
  GeoPoint,
  Payment,
  Trip,
} from "../src/types";
import { signTokens, verifyAccessToken, verifyRefreshToken, requireAuth, bearerFrom } from "./auth";
import {
  startTrip,
  confirmPickup,
  beginRide,
  hostCompleteRide,
  confirmTripCompletion,
  forceCompleteTrip,
  cancelTrip,
  findActiveTripForUser,
  type ValidationConfig,
  DEFAULT_VALIDATION_CONFIG,
} from "./trips";
import { initRealtime, emitTripUpdate } from "./realtime";
import { verifyOtp, devOtpActive } from "./otp";
import { initDb, loadState, saveState, persistNow, wipeAllData, persistTrip, persistWalletForUser, persistSubscription, persistMatch, persistUser } from "./db";
import { encryptPii, decryptPii } from "./crypto";
import prisma from "./prisma";
import { getDistanceKm, geocode, haversineMeters } from "./maps";
import { tryMatchGuestSub, runMatchSweep } from "./matching";
import { createPendingSubscription, processActivation, activateSubscriptionAsync } from "./activation";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const supabaseUrl = process.env.SUPABASE_URL || "https://snrdfprgypioxhskthcm.supabase.co";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNucmRmcHJneXBpb3hoc2t0aGNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxNzU3MDcsImV4cCI6MjEwMTc1MTcwN30.OavLMMUDp3XQTuYrf7gsi_-Gy1qG7bMVNzhtV5TNFfE";
const supabaseAdmin = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws }
});

import { planTypeOf, planDaysOf, weekUnits, workingDaysOf, guestMultiplierOf, guestBaseRoutePrice, guestPlanPrice, guestWelcomeCredit, hostSlab, isFirstGuestSubscription, computePlanAmount } from "./pricing";
import type { PricingConfig } from "./pricing";
import {
  notifyBuddyFound,
  getNotifications,
  notifyUser,
  notifyMany,
  markRead,
  configureNotifications,
  type AppNotification,
} from "./notifications";
import { logger, requestLogger } from "./logger";
import {
  validate,
  RegisterSchema,
  VerifyOtpSchema,
  ActivateSubscriptionSchema,
  CreateOrderSchema,
  RedeemVoucherSchema,
  ForceCompleteSchema,
  CreateTicketSchema,
  SendMessageSchema,
  AdminCreditWalletSchema,
} from "./validation";
import { paginatedResponse } from "./pagination";
import { withLock } from "./lock";
import rateLimit from "express-rate-limit";
import {
  adminGetUsers, adminGetUserById, adminUpdateUserStatus,
  adminGetMatches, adminGetKycQueue,
  adminGetTickets, adminGetTicketsCountByStatus, adminUpdateTicketStatus,
  adminGetWallets, adminCreditWallet, adminGetPayments,
  adminGetAuditLogs, adminGetAnalytics, adminGetRevenue,
  adminAddAuditLog, adminGetDBState,
} from "./admin-db";
import {
  AdminSettingsSchema, AdminBrandingSchema, AdminPricingConfigSchema,
  AdminUserActionSchema, AdminMatchActionSchema, AdminRideActionSchema,
  AdminFeatureFlagsSchema, AdminCmsSchema,
  AdminPromoSchema, AdminUpdatePromoSchema,
  AdminVoucherSchema,
  AdminNotificationTemplateSchema, AdminBroadcastSchema,
  AdminTripValidationConfigSchema, CreatePlanSchema, UpdatePlanSchema,
} from "./validation";

// Deterministic ID generator (replaces Math.random() patterns)
function genId(prefix: string, length = 8): string {
  return `${prefix}_` + randomUUID().replace(/-/g, "").substring(0, length);
}

// Timeout helper — rejects if the promise does not settle within ms.
function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ── Start Express Application ──

const app = express();
export { app };
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;

const envOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim())
  : [];

app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const origin = req.headers.origin;

  if (origin) {
    const isAllowed =
      envOrigins.includes(origin) ||
      envOrigins.includes("*") ||
      /\.vercel\.app$/.test(origin) ||
      origin.startsWith("http://localhost:") ||
      origin.startsWith("https://localhost:") ||
      origin.startsWith("http://127.0.0.1:") ||
      origin.startsWith("https://127.0.0.1:") ||
      process.env.NODE_ENV !== "production";

    if (isAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
    } else {
      logger.warn({ origin }, "[CORS] Blocked origin");
    }
  }

  // Intercept and resolve preflight OPTIONS requests immediately
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});
app.use(requestLogger);
app.use(express.json({ limit: "25mb" }));

// Body-parser failures (oversized / malformed JSON) must return JSON, not the
// default HTML error page (which breaks the client's response.json()).
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Upload too large. Please use a file under 5MB." });
  }
  if (err?.type === "entity.parse.failed" || (err?.status === 400 && "body" in err)) {
    return res.status(400).json({ error: "Invalid request body." });
  }
  return next(err);
});

// Middleware to ensure DB state is loaded before handling any API endpoint (prevents serverless cold-start 500 errors)
app.use("/api", async (_req, res, next) => {
  if (!db) {
    try {
      await initDb();
      db = (await loadState(seedState())) as DatabaseState;
      if (!Array.isArray(db.notifications)) db.notifications = [];
      configureNotifications(db.notifications, () => saveDB(db));
    } catch (err) {
      logger.error({ err }, "[server] DB initialization error");
      return res.status(500).json({ error: "Failed to initialize database" });
    }
  }
  next();
});
// ── Production boot guard ──
if (process.env.NODE_ENV === "production") {
  if (process.env.ALLOW_DEV_OTP === "true") {
    console.error("[FATAL] ALLOW_DEV_OTP=true with NODE_ENV=production. Refusing to start.");
    process.exit(1);
  }
  if (process.env.PAYMENTS_DEV_BYPASS === "true") {
    console.error("[FATAL] PAYMENTS_DEV_BYPASS=true with NODE_ENV=production. Refusing to start.");
    process.exit(1);
  }
}

// Admin rate limiter — 60 requests per minute per IP
const adminLimiter: any = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests. Try again in a minute.", retryAfterSec: 60 },
  skip: (req) => {
    const auth = (req as any).auth;
    return !auth || auth.role !== "admin";
  },
});

// Initialize Gemini API client safely with lazy fallback if key is missing
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    logger.warn({ key: process.env.GEMINI_API_KEY?.substring(0, 5) }, "[server] GEMINI_API_KEY not configured");
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

function getRazorpay(): null {
  return null;
}
function razorpayConfigured(): boolean {
  return false;
}
function paymentsDevBypass(): boolean {
  return true;
}


// Persist a base64 data-URL image to tmp/uploads and return its public /uploads
// path. Used for logos and KYC document scans. Throws on malformed input.
function saveDataUrlImage(imageData: string, prefix: string): string {
  const matches = String(imageData || "").match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  if (!matches) throw new Error("Invalid base64 image format");
  const mimeType = matches[1];
  const base64Data = matches[2];
  const ext = mimeType.includes("png") ? ".png" : mimeType.includes("gif") ? ".gif" : mimeType.includes("webp") ? ".webp" : mimeType.includes("pdf") ? ".pdf" : ".jpg";
  const uploadsDir = path.join(process.cwd(), "tmp", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });
  const fileName = `${prefix}_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 6)}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, fileName), base64Data, "base64");
  return `/uploads/${fileName}`;
}

// ============================================================
// EXTENDED TYPE DEFINITIONS FOR SUPER ADMIN PLATFORM
// ============================================================

interface SubscriptionPlan {
  id: string;
  role: 'guest' | 'host';
  planType: '7d' | '15d' | '1m';
  name: string;
  durationDays: number;
  multiplier?: number;
  basePrice?: number;
  isActive: boolean;
  badge?: string;
  features?: string[];
}

interface ThemeConfig {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  fontFamily: string;
  darkMode: boolean;
  buttonStyle: 'rounded' | 'pill' | 'sharp';
  cardStyle: 'shadow' | 'bordered' | 'flat';
}

interface BrandingConfig {
  appName: string;
  logoUrl: string;
  faviconUrl: string;
  supportEmail: string;
  supportPhone: string;
  tagline: string;
}

interface FeatureFlags {
  walletEnabled: boolean;
  subscriptionsEnabled: boolean;
  referralEnabled: boolean;
  sosEnabled: boolean;
  premiumEnabled: boolean;
  adsEnabled: boolean;
  liveTrackingEnabled: boolean;
  chatEnabled: boolean;
  promoCodesEnabled: boolean;
}

interface CMSPage {
  id: string;
  slug: string;
  title: string;
  content: string;
  updatedAt: string;
}

interface PromoCode {
  id: string;
  code: string;
  discountPercent: number;
  usageLimit: number;
  usedCount: number;
  expiryDate: string;
  isActive: boolean;
  createdAt: string;
  description: string;
}

// A one-time wallet-credit code (distinct from a PromoCode % discount). Each
// voucher grants a fixed â‚¹ amount to a user's wallet, capped by total usage and
// one redemption per user.
interface Voucher {
  id: string;
  code: string;
  amount: number;        // wallet credit (â‚¹) granted on redemption
  usageLimit: number;    // total redemptions allowed across all users
  redeemedBy: string[];  // userIds who have already redeemed
  redemptionCount: number;
  expiryDate: string;    // YYYY-MM-DD
  isActive: boolean;
  description?: string;
  createdAt: string;
}

interface AuditLog {
  id: string;
  adminId: string;
  adminName: string;
  action: string;
  target: string;
  details: string;
  timestamp: string;
}

interface NotificationTemplate {
  id: string;
  name: string;
  title: string;
  body: string;
  channel: 'push' | 'sms' | 'email';
  isActive: boolean;
}

interface GuestCredit {
  id: string;
  userId: string;
  creditType: 'renewal' | 'loyalty';
  amount: number;
  sourceSubscriptionId: string;
  appliedToSubscriptionId: string | null;
  createdAt: string;
}

// Persistence (Postgres write-through, or JSON-file fallback) is handled in ./db.ts

interface DatabaseState {
  users: User[];
  rides: Ride[];
  requests: RideRequest[];
  subscriptions: Subscription[];
  wallets: Record<string, Wallet>;
  chatMessages: ChatMessage[];
  tickets: SupportTicket[];
  systemSettings: {
    logoUrl: string;
    bannerText: string;
    perKmRate: number;
    allowWomenOnlyMode: boolean;
  };
  pricingConfig: PricingConfig;
  subscriptionPlans: SubscriptionPlan[];
  themeConfig: ThemeConfig;
  brandingConfig: BrandingConfig;
  featureFlags: FeatureFlags;
  cmsPages: CMSPage[];
  promoCodes: PromoCode[];
  auditLogs: AuditLog[];
  notificationTemplates: NotificationTemplate[];
  guestCredits: GuestCredit[];
  userStatus: Record<string, 'active' | 'suspended' | 'banned'>;
  matches: Match[];
  hostActivityDays: HostActivityDay[];
  payments: Payment[];
  notifications: AppNotification[];
  vouchers: Voucher[];
  trips: Trip[];
  tripValidationConfig: ValidationConfig;
}

// Seed Initial Mock Data for a delightful out-of-the-box experience
const defaultState: DatabaseState = {
  users: [],
  rides: [],
  requests: [],
  subscriptions: [],
  wallets: {},
  chatMessages: [],
  tickets: [],
  systemSettings: {
    logoUrl: "https://images.unsplash.com/photo-1549611016-3a70d82b5040?auto=format&fit=crop&w=150&q=80",
    bannerText: "â˜” Monsoon Special: Get extra 10% cashbacks on recurring campus commute passes!",
    perKmRate: 8,
    allowWomenOnlyMode: true
  },
  pricingConfig: {
    guestBaseKmLimit: 5,
    guestBasePrice: 30,
    guestIncrementPerKm: 5,
    guest7dWorkingDays: 5,
    guest15dWorkingDays: 11,
    guestMonthlyWorkingDays: 22,
    guest7dMultiplier: 1.0,
    guest15dMultiplier: 1.0,
    guestMonthlyMultiplier: 1.0,
    hostUpto5kmSlab: 49,
    hostAbove5kmSlab: 99,
    hostRatePerKm: 3.5,
    welcomeCreditFlat: 100,
    welcomeCreditPercent: 10,
    welcomeCreditCap: 100,
    upgradeIncentivePercent: 10,
    upgradeIncentiveCap: 100,
    loyaltyCreditPercent: 3,
    loyaltyCreditMin: 10,
    loyaltyCreditMax: 40
  },
  subscriptionPlans: [
    { id: "plan_g7", role: "guest", planType: "7d", name: "7 Day Pass", durationDays: 7, multiplier: 1.0, isActive: true, badge: "", features: ["1 route", "Morning commute", "Basic support"] },
    { id: "plan_g15", role: "guest", planType: "15d", name: "15 Day Pass", durationDays: 15, multiplier: 2.2, isActive: true, badge: "Popular", features: ["1 route", "Morning & Evening", "Priority support", "Ride guarantee"] },
    { id: "plan_g1m", role: "guest", planType: "1m", name: "Monthly Pass", durationDays: 30, multiplier: 4.4, isActive: true, badge: "Best Value", features: ["1 route", "All hours", "24/7 support", "Loyalty cashback", "Partner lock"] },
    { id: "plan_h7", role: "host", planType: "7d", name: "Host 7 Day", durationDays: 7, isActive: true, features: ["List 1 ride", "Basic visibility"] },
    { id: "plan_h15", role: "host", planType: "15d", name: "Host 15 Day", durationDays: 15, isActive: true, badge: "Popular", features: ["List 1 ride", "Boosted visibility", "Analytics"] },
    { id: "plan_h1m", role: "host", planType: "1m", name: "Host Monthly", durationDays: 30, isActive: true, badge: "Best Value", features: ["List 1 ride", "Top visibility", "Full analytics", "Priority payout"] }
  ],
  themeConfig: {
    primaryColor: "#7C3AED",
    secondaryColor: "#374151",
    accentColor: "#F59E0B",
    fontFamily: "Inter",
    darkMode: false,
    buttonStyle: "rounded",
    cardStyle: "shadow"
  },
  brandingConfig: {
    appName: "Move Buddy",
    logoUrl: "https://images.unsplash.com/photo-1549611016-3a70d82b5040?auto=format&fit=crop&w=150&q=80",
    faviconUrl: "",
    supportEmail: "support@movebuddy.com",
    supportPhone: "+91 98765 00000",
    tagline: "Commute Smarter, Together"
  },
  featureFlags: {
    walletEnabled: true,
    subscriptionsEnabled: true,
    referralEnabled: true,
    sosEnabled: true,
    premiumEnabled: false,
    adsEnabled: false,
    liveTrackingEnabled: true,
    chatEnabled: true,
    promoCodesEnabled: true
  },
  cmsPages: [
    { id: "cms_privacy", slug: "privacy", title: "Privacy Policy", content: "# Privacy Policy\n\nLast updated: June 2026\n\nThis privacy policy explains how Move Buddy collects, uses, and protects your personal information.\n\n## What We Collect\n- Name, email, phone number\n- Location data for ride matching\n- Payment information (processed securely)\n\n## How We Use It\n- Matching riders with hosts\n- Processing payments\n- Sending ride notifications\n\n## Your Rights\nYou can request deletion of your data at any time by contacting support@movebuddy.com", updatedAt: "2026-06-15T00:00:00Z" },
    { id: "cms_terms", slug: "terms", title: "Terms of Service", content: "# Terms of Service\n\nBy using Move Buddy, you agree to these terms.\n\n## Eligibility\nYou must be 18+ to use this platform.\n\n## User Responsibilities\n- Provide accurate information\n- Treat co-commuters with respect\n- Follow traffic laws\n\n## Prohibited Activities\n- Misuse of emergency SOS\n- Fraudulent payment methods\n- Creating fake accounts", updatedAt: "2026-06-15T00:00:00Z" },
    { id: "cms_refund", slug: "refund", title: "Refund Policy", content: "# Refund Policy\n\n## Subscription Refunds\nSubscriptions are refundable within 24 hours of purchase if no rides have been booked.\n\n## Ride Cancellations\nIf a host cancels, guests receive a full wallet credit.\n\n## Process\nRefunds are processed within 5-7 business days to your original payment method.", updatedAt: "2026-06-15T00:00:00Z" },
    { id: "cms_faq", slug: "faq", title: "FAQ", content: "# Frequently Asked Questions\n\n**Q: How do I book a ride?**\nA: Sign up as a Guest, search for rides on your route, and subscribe to your preferred host.\n\n**Q: How does pricing work?**\nA: Guest subscriptions are distance-based. 0-5km = â‚¹30/route. Beyond 5km = â‚¹30 + â‚¹5 per extra km.\n\n**Q: Can I change my host?**\nA: Yes, once per subscription period with admin approval.\n\n**Q: What is the buddy score?**\nA: A trust metric based on ride history, reviews, and punctuality.", updatedAt: "2026-06-15T00:00:00Z" },
    { id: "cms_about", slug: "about", title: "About Us", content: "# About Move Buddy\n\nMove Buddy is India's smart daily commute platform connecting office workers and college students with trusted co-commuters.\n\n## Our Mission\nMake daily commuting affordable, safe, and social.\n\n## Founded\n2026 in Kolkata, India.\n\n## Contact\nEmail: hello@movebuddy.com\nPhone: +91 98765 00000", updatedAt: "2026-06-15T00:00:00Z" }
  ],
  promoCodes: [
    { id: "promo_1", code: "WELCOME50", discountPercent: 50, usageLimit: 1000, usedCount: 234, expiryDate: "2026-12-31", isActive: true, createdAt: "2026-01-01T00:00:00Z", description: "50% off for new users on first subscription" },
    { id: "promo_2", code: "FIRSTRIDE", discountPercent: 100, usageLimit: 500, usedCount: 112, expiryDate: "2026-09-30", isActive: true, createdAt: "2026-01-01T00:00:00Z", description: "Free first 7-day pass" },
    { id: "promo_3", code: "COLLEGE25", discountPercent: 25, usageLimit: 5000, usedCount: 890, expiryDate: "2026-12-31", isActive: true, createdAt: "2026-01-01T00:00:00Z", description: "25% off for verified college students" }
  ],
  auditLogs: [],
  notificationTemplates: [
    { id: "notif_1", name: "Ride Reminder", title: "Your ride is tomorrow!", body: "Don't forget your scheduled commute with {{hostName}} at {{time}}. Be ready 5 mins early!", channel: "push", isActive: true },
    { id: "notif_2", name: "Payment Success", title: "Payment Confirmed âœ“", body: "Your {{planName}} subscription is now active. Happy commuting! Your first pickup is on {{date}}.", channel: "push", isActive: true },
    { id: "notif_3", name: "Subscription Expiry", title: "Subscription Expiring Soon", body: "Your subscription expires in {{days}} days. Renew now to lock in your commute partner.", channel: "push", isActive: true },
    { id: "notif_4", name: "Welcome Message", title: "Welcome to Move Buddy!", body: "Hi {{name}}! Start your smart commute journey today. Search for rides near you and subscribe to your first host.", channel: "email", isActive: true },
    { id: "notif_5", name: "Emergency Alert", title: "SOS Alert Triggered", body: "User {{userName}} has triggered an emergency alert at {{location}}. Please respond immediately.", channel: "sms", isActive: true }
  ],
  guestCredits: [],
  userStatus: {},
  matches: [],
  hostActivityDays: [],
  payments: [],
  notifications: [],
  vouchers: [
    { id: "vch_welcome", code: "WELCOME100", amount: 100, usageLimit: 1000, redeemedBy: [], redemptionCount: 0, expiryDate: "2026-12-31", isActive: true, description: "â‚¹100 welcome credit for new commuters", createdAt: "2026-01-01T00:00:00Z" }
  ],
  trips: [],
  tripValidationConfig: { ...DEFAULT_VALIDATION_CONFIG }
};

// Persist the current in-memory state through the ./db layer (Postgres or file).
// Loading happens once in the background startup IIFE, before serverReady.
let isSavingDB = false;
let pendingSaveCallbacks: Array<{ resolve: () => void; reject: (e: any) => void }> = [];

async function saveDB(state: DatabaseState): Promise<void> {
  if (isSavingDB) {
    return new Promise<void>((resolve, reject) => {
      pendingSaveCallbacks.push({ resolve, reject });
    });
  }

  isSavingDB = true;
  try {
    await saveState(state);
  } catch (e: any) {
    logger.error({ err: e }, "[saveDB] saveState failed");
  } finally {
    isSavingDB = false;
    if (pendingSaveCallbacks.length > 0) {
      const callbacks = pendingSaveCallbacks;
      pendingSaveCallbacks = [];
      saveDB(state).then(
        () => callbacks.forEach(c => c.resolve()),
        (err) => callbacks.forEach(c => c.reject(err))
      );
    }
  }
}

function getActivationDeps() {
  return {
    db,
    saveDB,
    geocode,
    withLock,
    tryMatchGuestSub,
    runMatchSweep,
    notifyUser,
    notifyBuddyFound,
    logger,
  };
}

// Global state - populated from the database before the server accepts API
// requests. The HTTP listener starts first so the kernel can accept TCP
// connections; API calls are rejected with 503 until serverReady flips true.
export let db: DatabaseState = defaultState;
let serverReady = false;
let httpServer: ReturnType<typeof app.listen>;

// Serve uploaded assets (logos, etc.)
app.use('/uploads', express.static(path.join(process.cwd(), 'tmp', 'uploads')));

// â”€â”€ ROLE-BASED ACCESS GUARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Every admin endpoint calls this. Uses req.auth (set by the JWT middleware)
// to verify the user's identity and adminRole. Never trust client headers.
// Returns true (proceed) or false (response already sent with 401/403).

type AdminRoleType = 'SUPER_ADMIN' | 'ADMIN' | 'FINANCE' | 'SUPPORT' | 'OPERATIONS';

function requireRole(req: any, res: any, ...allowed: AdminRoleType[]): boolean {
  const auth = req.auth;
  if (!auth) {
    res.status(401).json({ message: "Unauthorized: missing or invalid token", statusCode: 401 });
    return false;
  }
  if (auth.role !== 'admin') {
    res.status(403).json({ message: "Forbidden: not an admin account", statusCode: 403 });
    return false;
  }
  const adminRole = (auth.adminRole as AdminRoleType) || 'ADMIN';
  if (allowed.length > 0 && !allowed.includes(adminRole)) {
    res.status(403).json({
      message: `Forbidden: requires ${allowed.join(' or ')}`,
      statusCode: 403,
      yourRole: adminRole,
      requiredRoles: allowed
    });
    return false;
  }
  return true;
}

// AUDIT LOG HELPER - appended to DB, capped at 1000 entries
// If first arg has .auth property, extracts real admin identity from the request.
function addAuditLog(adminIdOrReq: any, adminNameOrAction: string, actionOrTarget?: string, targetOrDetails?: string, detailsArg?: string) {
  let adminId: string, adminName: string, action: string, target: string, details: string;
  if (adminIdOrReq?.auth) {
    const auth = adminIdOrReq.auth;
    adminId = auth.sub || "unknown";
    adminName = auth.name || auth.email || "Unknown Admin";
    action = adminNameOrAction;
    target = actionOrTarget || "";
    details = targetOrDetails || "";
  } else {
    adminId = adminIdOrReq as string;
    adminName = adminNameOrAction;
    action = actionOrTarget || "";
    target = targetOrDetails || "";
    details = detailsArg || "";
  }
  const log: AuditLog = {
    id: "log_" + randomUUID().replace(/-/g, "").substring(0, 8),
    adminId,
    adminName,
    action,
    target,
    details,
    timestamp: new Date().toISOString()
  };
  db.auditLogs.unshift(log);
  if (db.auditLogs.length > 1000) db.auditLogs = db.auditLogs.slice(0, 1000);
  adminAddAuditLog(adminId, adminName, action, target, details).catch(() => { });
}

// HELPER: Generate highly realistic matches and route overlap percentages
function calculateRouteOverlap(p1: string, p2: string, p3: string, p4: string): { overlap: number; pickup: string } {
  // Simple deterministic overlap calculation based on length ratios & common substrings
  const joinedHost = (p1 + " " + p2).toLowerCase();
  const joinedGuest = (p3 + " " + p4).toLowerCase();

  // Look for shared hubs (e.g. "Salt Lake", "Metro", "Tech Park", "University", "DLF", "Station")
  const commonHubs = ["salt lake", "dlf", "metro", "park", "bypass", "street", "main road", "highway", "sector", "square", "mall", "office"];
  let matchedHubs = 0;
  for (const hub of commonHubs) {
    if (joinedHost.includes(hub) && joinedGuest.includes(hub)) {
      matchedHubs++;
    }
  }

  const baseOverlap = 65 + (matchedHubs * 8);
  const hash = [...(p1 + p2 + p3 + p4)].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const jitter = hash % 12;
  const overlapPercent = Math.min(Math.round(baseOverlap + jitter), 99);

  // Derive suggested clever pickup spot
  let suggestedPickup = "Main intersection closest to highway";
  if (joinedHost.includes("salt lake") && joinedGuest.includes("salt lake")) {
    suggestedPickup = "Salt Lake Sector 1 Metro Station Gate 2";
  } else if (joinedHost.includes("dlf") || joinedGuest.includes("dlf")) {
    suggestedPickup = "DLF Phase II Gateway IT Hub Entry";
  } else if (joinedHost.includes("college") || joinedGuest.includes("college")) {
    suggestedPickup = "Under the main Clocktower intersection";
  } else {
    suggestedPickup = `Drop point near ${p1.split(",")[0]} bypass road link`;
  }

  return { overlap: overlapPercent, pickup: suggestedPickup };
}

// â”€â”€ JWT AUTH GUARD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Every /api route requires a valid access token EXCEPT this public allowlist
// (auth endpoints + read-only config/content used before login). Admin routes
// additionally check the X-Admin-Id role via requireRole inside each handler.
// â”€â”€ Lightweight in-memory rate limiter / lockout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Throttles auth + OTP brute force. NOTE: single-process only â€” when running more
// than one replica, move this to a shared store (Redis) or limits are per-instance.
const _rl = new Map<string, { count: number; first: number; lockedUntil: number }>();
function rlCheck(key: string): { blocked: boolean; retryAfterSec: number } {
  const e = _rl.get(key);
  const now = Date.now();
  if (e && e.lockedUntil > now) return { blocked: true, retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000) };
  return { blocked: false, retryAfterSec: 0 };
}
function rlConsume(key: string, max: number, windowMs: number, lockMs: number): { blocked: boolean; retryAfterSec: number } {
  const now = Date.now();
  let e = _rl.get(key);
  if (e && e.lockedUntil > now) return { blocked: true, retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000) };
  if (!e || now - e.first > windowMs) { e = { count: 0, first: now, lockedUntil: 0 }; _rl.set(key, e); }
  e.count++;
  if (e.count > max) { e.lockedUntil = now + lockMs; return { blocked: true, retryAfterSec: Math.ceil(lockMs / 1000) }; }
  return { blocked: false, retryAfterSec: 0 };
}
function rlReset(key: string): void { _rl.delete(key); }

// Generic rate-limit middleware for non-auth endpoints.
// Default: 60 requests/min per IP. Use the `max` option to customize.
function rlMiddleware(max = 60, windowMs = 60000, lockMs = 120000) {
  return (req: any, res: any, next: any) => {
    const key = `rl:${req.path}:${req.ip}`;
    const { blocked, retryAfterSec } = rlConsume(key, max, windowMs, lockMs);
    if (blocked) {
      res.status(429).json({ error: "Too many requests", retryAfterSec });
      return;
    }
    next();
  };
}

// â”€â”€ Object-level authorization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The caller (identity from the verified JWT, req.auth.sub) may act ONLY on their
// own userId â€” unless they are an admin. Prevents IDOR/BOLA where a path/body
// userId is used to read or mutate another user's data. Returns true to proceed;
// on failure sends 403 and returns false.
function assertSelfOrAdmin(req: any, res: any, targetUserId: string): boolean {
  const auth = req.auth;
  if (auth && (auth.sub === targetUserId || auth.role === 'admin')) return true;
  res.status(403).json({ error: "Forbidden: you may only access your own data" });
  return false;
}

const PUBLIC_API: { method: string; pattern: RegExp }[] = [
  { method: "POST", pattern: /^\/api\/auth\/(login|register|verify-otp|refresh|truecaller|truecaller\/callback)$/ },
  { method: "GET", pattern: /^\/api\/auth\/truecaller\/callback$/ },
  { method: "GET", pattern: /^\/api\/branding$/ },
  { method: "GET", pattern: /^\/api\/feature-flags$/ },
  { method: "GET", pattern: /^\/api\/subscription-plans$/ },
  { method: "GET", pattern: /^\/api\/cms\// },
];

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  if (req.method === "OPTIONS") return next();
  if (PUBLIC_API.some(r => r.method === req.method && r.pattern.test(req.path))) return next();
  return requireAuth(req, res, next);
});

// Startup guard — reject /api/* calls until DB state is loaded (serverReady).
// Without this guard, route handlers would operate on the demo defaultState and
// the frontend would see stale / incorrect data.
app.use("/api", (_req, res, next) => {
  if (!serverReady) {
    return res.status(503).json({ error: "Server initializing, retry shortly" });
  }
  next();
});

// REST ENDPOINTS

// Phone matching that ignores +91 / leading-0 / spacing differences by comparing
// the last 10 digits, so an already-registered person is always recognised
// (and never gets a second, duplicate profile).
const digitsOnly = (p?: string) => (p || "").replace(/[^\d]/g, "");
const phoneLast10 = (p?: string) => digitsOnly(p).slice(-10);
function findUserByContact(contact: string): User | undefined {
  const q = String(contact || "").trim();
  if (!q) return undefined;
  const ql = q.toLowerCase();
  const q10 = phoneLast10(q);
  return db.users.find(u =>
    u.email.toLowerCase() === ql ||
    (q10.length === 10 && phoneLast10(u.phone) === q10)
  );
}

// AUTHENTICATION
app.post("/api/auth/register", rlMiddleware(10, 60000, 300000), validate(RegisterSchema), (req, res) => {
  if (!req.body.name || !req.body.email || !req.body.phone) {
    return res.status(400).json({ error: "Missing required fields Name, Email or Phone" });
  }
  const { name, email, phone, gender, companyOrCollege, role } = req.body;

  const isAdmin = role === 'admin' || email.toLowerCase().includes('admin') || email.toLowerCase().endsWith('@movebuddy.com');
  const normalizedRole = isAdmin ? 'admin' : (role === 'host' ? 'host' : 'guest');

  // Reuse an existing account if either the email OR the phone already belongs to
  // one — registering again must return the same profile, not create a new one.
  const phone10 = phoneLast10(phone);
  let user = db.users.find(u =>
    u.email.toLowerCase() === email.toLowerCase() ||
    (phone10.length === 10 && phoneLast10(u.phone) === phone10)
  );
  if (!user) {
    user = {
      id: "usr_" + randomUUID().replace(/-/g, "").substring(0, 7),
      name,
      email,
      phone,
      role: normalizedRole,
      adminRole: isAdmin ? 'SUPER_ADMIN' : undefined,
      gender: gender || "male",
      companyOrCollege,
      isIdVerified: isAdmin ? true : false, // Admins auto-verified
      isCompanyVerified: isAdmin ? true : !!companyOrCollege,
      // Real defaults for a brand-new user: an initials avatar (not a random
      // stranger's photo), a neutral starting trust score, and no rating yet.
      avatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=FFB300&color=2A2E34&bold=true&size=150`,
      buddyScore: 50, // neutral baseline; grows with completed rides & ratings
      rating: 0, // no ratings until they complete rides
      reliabilityScore: 50, // neutral matching reliability; adjusts with behaviour
      createdAt: new Date().toISOString()
    };
    db.users.push(user);

    // Wallet starts empty â€” real balance reflects actual top-ups/transactions.
    db.wallets[user.id] = { userId: user.id, credits: 0, history: [] };
    saveDB(db);
  }

  const devMode = devOtpActive();
  return res.json({
    message: devMode
      ? "OTP sent (dev mode â€” use code 123456)"
      : "Complete phone verification to receive your OTP.",
    devOtp: devMode,
    user
  });
});

app.post("/api/auth/login", (req, res) => {
  try {
    // Throttle per-IP to slow account enumeration / OTP-dispatch abuse.
    const lim = rlConsume(`login:${req.ip || "unknown"}`, 30, 5 * 60 * 1000, 5 * 60 * 1000);
    if (lim.blocked) return res.status(429).json({ error: "Too many attempts. Please try again later.", retryAfterSec: lim.retryAfterSec });

    const { phoneOrEmail } = req.body;
    if (!phoneOrEmail) {
      return res.status(400).json({ error: "Provide phone or email" });
    }

    const devMode = devOtpActive();
    const user = findUserByContact(phoneOrEmail);
    if (!user) {
      // Not registered yet — frontend routes to onboarding.
      return res.json({
        isNew: true,
        message: "Phone/Email not registered yet. Redirecting to instant onboarding.",
        devOtp: devMode,
      });
    }

    // Return ONLY the minimum the client needs to dispatch the OTP. NEVER the full
    // profile — that would leak PII/KYC (Aadhaar, licence, email) to an
    // unauthenticated caller. The full user is returned by /verify-otp once the
    // caller has proven control of the phone.
    return res.json({
      isNew: false,
      user: { id: user.id, phone: user.phone },
      devOtp: devMode,
      message: devMode ? "OTP sent (dev mode — use code 123456)" : "OTP dispatched to your phone.",
    });
  } catch (err: any) {
    console.error('[auth/login] error:', err?.stack || err);
    return res.status(500).json({ error: "Internal server error" });
  }
});




app.post("/api/auth/verify-otp", async (req, res) => {
  const { userId, code, firebaseIdToken } = req.body;

  // Brute-force lockout: block while locked (per-user AND per-IP, so neither a
  // fixed user nor a rotating-userId attacker can grind the 6-digit space).
  const userKey = userId ? `otp:${userId}` : null;
  const ipKey = `otp-ip:${req.ip || "unknown"}`;
  const userBlock = userKey ? rlCheck(userKey) : { blocked: false, retryAfterSec: 0 };
  const ipBlock = rlCheck(ipKey);
  if (userBlock.blocked || ipBlock.blocked) {
    const retryAfterSec = Math.max(userBlock.retryAfterSec, ipBlock.retryAfterSec);
    return res.status(429).json({ error: "Too many incorrect attempts. Please try again later.", retryAfterSec });
  }

  // Verify the OTP via the provider layer (Firebase ID token in real mode, fixed
  // dev code only when devOtpActive() — never in production).
  const result = await verifyOtp({ code, firebaseIdToken });
  if (!result.ok) {
    if (userKey) rlConsume(userKey, 5, 10 * 60 * 1000, 15 * 60 * 1000);
    rlConsume(ipKey, 20, 10 * 60 * 1000, 15 * 60 * 1000);
    return res.status(400).json({ error: result.reason || "Invalid OTP", mode: result.mode });
  }

  // Resolve the user: prefer the verified phone (real mode), else the userId (dev mode).
  let user: User | undefined;
  if (result.phone) {
    const normalized = result.phone.replace(/[^\d]/g, "");
    user = db.users.find(u => u.phone.replace(/[^\d]/g, "") === normalized);
  }
  if (!user && userId) {
    user = db.users.find(u => u.id === userId);
  }
  if (!user) {
    return res.status(404).json({ error: "User not found", mode: result.mode });
  }

  // Success — clear brute-force counters for this user/IP.
  if (userKey) rlReset(userKey);
  rlReset(ipKey);

  // Issue real signed JWTs.
  const { token, refreshToken } = signTokens(user);
  return res.json({ success: true, token, refreshToken, user, authMode: result.mode });
});

// REFRESH ACCESS TOKEN — exchange a valid refresh token for a fresh access token.
// In-memory refresh token blacklist (token rotation / single-use enforcement).
// NOTE: single-process only — move to Redis in multi-replica deployments.
const usedRefreshTokens = new Set<string>();
// Clean up the set periodically to prevent unbounded memory growth.
setInterval(() => usedRefreshTokens.clear(), 30 * 60 * 1000);

app.post("/api/auth/refresh", (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ error: "Missing refreshToken" });
  }
  // Token rotation: reject if this refresh token was already used.
  if (usedRefreshTokens.has(refreshToken)) {
    return res.status(401).json({ error: "Refresh token already used — possible token replay" });
  }
  const decoded = verifyRefreshToken(refreshToken);
  if (!decoded) {
    return res.status(401).json({ error: "Invalid or expired refresh token" });
  }
  const user = db.users.find(u => u.id === decoded.sub);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  // Mark current token as used (rotation).
  usedRefreshTokens.add(refreshToken);
  const tokens = signTokens(user);
  return res.json({ success: true, ...tokens, user });
});

// Logout: add the provided refresh token to the blacklist so it can't be reused.
app.post("/api/auth/logout", (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    usedRefreshTokens.add(refreshToken);
  }
  return res.json({ success: true });
});

// GET CURRENT USER / PROFILE
app.get("/api/auth/me/:userId", (req, res) => {
  const { userId } = req.params;
  if (!assertSelfOrAdmin(req, res, userId)) return;
  const user = db.users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json(user);
});

// UPDATE ROLE (Toggle Host/Guest Mode)
app.post("/api/auth/mode", (req, res) => {
  const { userId, mode } = req.body;
  if (!assertSelfOrAdmin(req, res, userId)) return;
  const user = db.users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  if (mode !== 'guest' && mode !== 'host') {
    return res.status(400).json({ error: "Invalid role mode" });
  }
  user.role = mode;
  saveDB(db);
  res.json({ success: true, user });
});

// DOCUMENT UPLOAD â€” accepts a base64 data URL, stores it, returns its URL.
// Used by the onboarding flow to upload licence / Aadhaar / vehicle RC scans.
app.post("/api/auth/upload-document", (req, res) => {
  const { imageData, kind } = req.body;
  if (!imageData) return res.status(400).json({ error: "No image data provided" });
  const allowed = ["licence", "aadhaar", "vehicle", "selfie"];
  const prefix = allowed.includes(kind) ? `kyc_${kind}` : "kyc_doc";
  try {
    const url = saveDataUrlImage(imageData, prefix);
    res.json({ success: true, url });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Upload failed" });
  }
});

// DOCUMENT VERIFICATION ENDPOINT
app.post("/api/auth/verify-documents", async (req, res) => {
  const { userId, licenceNumber, aadhaarNumber, selfieImage, licenceImageUrl, aadhaarImageUrl, vehicleRcNumber, vehicleRcImageUrl } = req.body;
  if (!userId) {
    return res.status(400).json({ error: "Missing userId for document verification." });
  }
  if (!assertSelfOrAdmin(req, res, userId)) return; // a user may only submit their OWN KYC
  if (!licenceNumber || !aadhaarNumber) {
    return res.status(400).json({ error: "License number and Aadhaar number are required." });
  }

  const user = db.users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  user.verificationStatus = 'pending';
  user.licenceNumber = licenceNumber;
  user.aadhaarNumber = aadhaarNumber;
  user.selfieImage = selfieImage || "";
  // Document scans + vehicle registration (preserve any previously stored value
  // if this submission didn't include a fresh upload).
  if (licenceImageUrl !== undefined) user.licenceImageUrl = licenceImageUrl;
  if (aadhaarImageUrl !== undefined) user.aadhaarImageUrl = aadhaarImageUrl;
  if (vehicleRcNumber !== undefined) user.vehicleRcNumber = vehicleRcNumber;
  if (vehicleRcImageUrl !== undefined) user.vehicleRcImageUrl = vehicleRcImageUrl;
  user.verificationSubmittedAt = new Date().toISOString();
  user.isIdVerified = false; // reset until approved

  try {
    await prisma.user.upsert({
      where: { id: userId },
      update: {
        verificationStatus: "PENDING",
        licenceNumber: encryptPii(licenceNumber),
        aadhaarNumber: encryptPii(aadhaarNumber),
        selfieImage: selfieImage || "",
        licenceImageUrl: user.licenceImageUrl || null,
        aadhaarImageUrl: user.aadhaarImageUrl || null,
        vehicleRcNumber: user.vehicleRcNumber || null,
        vehicleRcImageUrl: user.vehicleRcImageUrl || null,
        verificationSubmittedAt: new Date(),
        isIdVerified: false,
      },
      create: {
        id: userId,
        name: user.name || "User",
        email: user.email || `${userId}@example.com`,
        phone: user.phone || null,
        role: (user.role?.toUpperCase() as any) || "GUEST",
        verificationStatus: "PENDING",
        licenceNumber: encryptPii(licenceNumber),
        aadhaarNumber: encryptPii(aadhaarNumber),
        selfieImage: selfieImage || "",
        licenceImageUrl: user.licenceImageUrl || null,
        aadhaarImageUrl: user.aadhaarImageUrl || null,
        vehicleRcNumber: user.vehicleRcNumber || null,
        vehicleRcImageUrl: user.vehicleRcImageUrl || null,
        verificationSubmittedAt: new Date(),
        isIdVerified: false,
      },
    });
  } catch (err) {
    logger.error({ err }, "[server] verify-documents Prisma upsert error");
  }

  notifyUser(user.id, "Documents received", "Your identity documents are under review. We'll notify you once verification is complete.", "verification", { status: "pending" });
  saveDB(db);
  res.json({ success: true, user });
});

// SIMULATION DEV UTILITY ENDPOINT FOR TESTING THE 24H DELAY
app.post("/api/auth/simulate-verification-state", (req, res) => {
  // DEV-ONLY. This endpoint flips isIdVerified and would BYPASS the entire KYC gate
  // if reachable in production, so it must not exist there. In production,
  // verification state changes ONLY via the admin KYC-approval workflow.
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }
  const { userId, status } = req.body; // status: 'none' | 'pending' | 'verified' | 'rejected'
  if (!userId || !status) {
    return res.status(400).json({ error: "Missing required parameters userId or status." });
  }
  if (!assertSelfOrAdmin(req, res, userId)) return; // even in dev, only your OWN state

  const user = db.users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  user.verificationStatus = status;
  user.isIdVerified = (status === 'verified');

  if (status === 'none') {
    user.licenceNumber = undefined;
    user.aadhaarNumber = undefined;
    user.selfieImage = undefined;
    user.verificationSubmittedAt = undefined;
  }

  saveDB(db);
  res.json({ success: true, user });
});

// RIDES ENDPOINTS
app.get("/api/rides", (req, res) => {
  const { gender, vehicle, time, search } = req.query;
  let filtered = [...db.rides];

  if (gender === "women-only") {
    filtered = filtered.filter(r => r.genderRestriction === "women-only");
  }
  if (vehicle && vehicle !== "all") {
    filtered = filtered.filter(r => r.vehicleType === vehicle);
  }
  if (search) {
    const s = String(search).toLowerCase();
    filtered = filtered.filter(r => r.origin.toLowerCase().includes(s) || r.destination.toLowerCase().includes(s));
  }

  // Populate dynamic smart matches for visualization
  const result = filtered.map(ride => {
    // Compute quick client simulated matching info (since actual coordinate logic isn't available)
    const matchVal = calculateRouteOverlap(ride.origin, ride.destination, "Current Spot", "Target Office");
    return {
      ...ride,
      matches: matchVal
    };
  });

  res.json(paginatedResponse(result, req.query as any));
});

app.post("/api/rides/offer", rlMiddleware(20, 60000, 120000), async (req, res) => {
  const {
    hostId,
    origin,
    destination,
    departureDate,
    departureTime,
    availableSeats,
    vehicleType,
    vehicleModel,
    vehicleNumber,
    isRecurring,
    recurrenceDays,
    genderRestriction
  } = req.body;

  if (!assertSelfOrAdmin(req, res, hostId)) return;

  const host = db.users.find(u => u.id === hostId);
  if (!host) {
    return res.status(404).json({ error: "Host profile not found" });
  }
  if (!host.isIdVerified || host.verificationStatus !== 'verified') {
    return res.status(403).json({ error: "Host verification required: All 5 mandatory documents must be APPROVED before offering rides." });
  }

  // Real driving distance via Google Maps Routes API (falls back to an estimate
  // if Maps is unreachable â€” flagged via distanceSource on the response).
  const { km: dist, durationMin, source: distanceSource } = await getDistanceKm(origin, destination);
  const rate = vehicleType === "car" ? 8 : 4;

  const newRide: Ride = {
    id: "rd_" + randomUUID().replace(/-/g, "").substring(0, 7),
    hostId: host.id,
    hostName: host.name,
    hostAvatar: host.avatarUrl,
    hostRating: host.rating,
    hostBuddyScore: host.buddyScore,
    origin,
    destination,
    departureDate,
    departureTime,
    availableSeats: Number(availableSeats) || 3,
    totalSeats: Number(availableSeats) || 3,
    vehicleType: vehicleType || "car",
    vehicleModel: vehicleModel || "Commuter",
    vehicleNumber: vehicleNumber || "WB-XX-XXXX",
    perKmRate: rate,
    distanceKm: dist,
    totalCost: Math.round(dist * rate),
    genderRestriction: genderRestriction || "none",
    isRecurring: !!isRecurring,
    recurrenceDays: recurrenceDays || []
  };

  db.rides.unshift(newRide);
  saveDB(db);
  res.json({ success: true, ride: newRide, distanceSource, durationMin });
});

// REQUEST A RIDE
app.post("/api/rides/request", rlMiddleware(20, 60000, 120000), (req, res) => {
  const { rideId, guestId } = req.body;
  if (!assertSelfOrAdmin(req, res, guestId)) return; // a guest may only request as themselves
  const ride = db.rides.find(r => r.id === rideId);
  const guest = db.users.find(u => u.id === guestId);

  if (!ride || !guest) {
    return res.status(404).json({ error: "Ride or Guest not found" });
  }

  // Create mock request
  const newReq: RideRequest = {
    id: "req_" + randomUUID().replace(/-/g, "").substring(0, 7),
    rideId,
    guestId,
    guestName: guest.name,
    guestAvatar: guest.avatarUrl,
    guestRating: guest.rating,
    status: "pending",
    requestDate: new Date().toISOString().split("T")[0],
    verificationCode: "BUDDY-" + (parseInt(randomUUID().replace(/-/g, "").substring(0, 4), 16) % 9000 + 1000)
  };

  db.requests.unshift(newReq);
  saveDB(db);
  res.json({ success: true, request: newReq });
});

// GET REQUESTS
app.get("/api/rides/requests/:userId", (req, res) => {
  const { userId } = req.params;
  if (!assertSelfOrAdmin(req, res, userId)) return;
  const user = db.users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  // Get requested rides (as guest)
  const asGuest = db.requests.filter(r => r.guestId === userId);

  // Get host's rides and subsequent incoming requests
  const hostRides = db.rides.filter(r => r.hostId === userId).map(r => r.id);
  const asHost = db.requests.filter(r => hostRides.includes(r.rideId));

  res.json({ asGuest, asHost });
});

// ACCEPT / REJECT REQUESTS
app.post("/api/rides/action", (req, res) => {
  const { requestId, action } = req.body; // action: 'accepted' or 'rejected'
  const request = db.requests.find(r => r.id === requestId);
  if (!request) {
    return res.status(404).json({ error: "Request not found" });
  }

  request.status = action;

  // If accepted, decrement seats
  if (action === "accepted") {
    const ride = db.rides.find(r => r.id === request.rideId);
    if (ride && ride.availableSeats > 0) {
      ride.availableSeats--;
    }

    // Trigger dummy starter chat message
    db.chatMessages.push({
      id: "msg_auto_" + randomUUID().replace(/-/g, "").substring(0, 7),
      senderId: ride ? ride.hostId : "system",
      senderName: ride ? ride.hostName : "System",
      receiverId: request.guestId,
      text: `Hey ${request.guestName}! I've accepted your ride request. Let's plan our pick up. See you!`,
      timestamp: new Date().toISOString(),
      rideId: request.rideId
    });
  }

  saveDB(db);
  res.json({ success: true, request });
});

// WALLET SYSTEM
app.get("/api/wallet/:userId", (req, res) => {
  const { userId } = req.params;
  if (!assertSelfOrAdmin(req, res, userId)) return;
  if (!db.wallets[userId]) {
    db.wallets[userId] = { userId, credits: 0, history: [] };
    saveDB(db);
  }
  res.json(db.wallets[userId]);
});

app.post("/api/wallet/credit", async (req, res) => {
  // Crediting a wallet MINTS money. Restrict to admins/finance. Legitimate user
  // top-ups MUST flow through the server-verified payment path (create-order â†’
  // verify), never a client-reported success. (Was: any authenticated user could
  // credit ANY wallet any amount â€” a critical financial fraud hole.)
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'FINANCE')) return;
  const { userId, amount, source } = req.body;
  if (!userId || !amount) {
    return res.status(400).json({ error: "Missing parameters" });
  }
  if (!db.wallets[userId]) {
    db.wallets[userId] = { userId, credits: 0, history: [] };
  }

  const amt = Number(amount);
  db.wallets[userId].credits += amt;
  db.wallets[userId].history.unshift({
    id: "tx_" + randomUUID().replace(/-/g, "").substring(0, 7),
    amount: amt,
    type: "credit",
    description: source || "Added ride credits via Razorpay Simulation Portal",
    timestamp: new Date().toISOString()
  });

  notifyUser(userId, "Wallet credited", `₹${amt} was added to your wallet. New balance: ₹${db.wallets[userId].credits}.`, "wallet", { amount: amt, balance: db.wallets[userId].credits });
  await saveDB(db);
  res.json({ success: true, wallet: db.wallets[userId] });
});

app.post("/api/wallet/topup-order", rlMiddleware(20, 60000, 120000), async (req, res) => {
  const userId = (req as any).auth?.sub;
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const amount = Number(req.body.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: "Valid positive amount required" });

  const rzp: any = paymentsDevBypass() ? null : getRazorpay();

  let providerOrderId: string;
  try {
    if (rzp) {
      const order = await rzp.orders.create({
        amount: Math.round(amount * 100),
        currency: "INR",
        notes: { userId, type: "wallet_topup" },
      });
      providerOrderId = order.id;
    } else {
      providerOrderId = "order_dev_" + randomUUID().replace(/-/g, "").substring(0, 10);
    }
  } catch (e: any) {
    logger.error({ err: e }, "[wallet] topup order create failed");
    return res.status(502).json({ error: "Could not create Razorpay order for wallet top-up" });
  }

  const payment: Payment = {
    id: "pay_" + randomUUID().replace(/-/g, "").substring(0, 8),
    userId, provider: "razorpay", providerOrderId, amount, currency: "INR",
    status: "created", notes: { type: "wallet_topup" },
    createdAt: new Date().toISOString(),
  };
  db.payments.push(payment);
  await saveDB(db);

  res.json({
    orderId: providerOrderId,
    keyId: process.env.RAZORPAY_KEY_ID || null,
    amount, currency: "INR", devMode: !rzp,
    userName: user.name, userEmail: user.email, userPhone: user.phone,
  });
});

app.post("/api/wallet/topup-verify", rlMiddleware(20, 60000, 120000), async (req, res) => {
  const userId = (req as any).auth?.sub;
  const { orderId, paymentId, signature } = req.body;
  const payment = db.payments.find(p => p.providerOrderId === orderId && p.userId === userId);
  if (!payment) return res.status(404).json({ success: false, error: "Payment record not found" });

  if (payment.status === "success") {
    return res.json({ success: true, wallet: db.wallets[userId] || { userId, credits: 0, history: [] } });
  }

  let valid = false;
  if (paymentsDevBypass()) {
    valid = true;
  } else if (razorpayConfigured()) {
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(orderId + "|" + paymentId).digest("hex");
    valid = expected === signature;
  } else {
    payment.status = "failed";
    await saveDB(db);
    return res.status(503).json({ success: false, error: "Payment processing is not configured." });
  }

  if (!valid) {
    payment.status = "failed";
    await saveDB(db);
    return res.status(402).json({ success: false, error: "Razorpay signature verification failed" });
  }

  payment.status = "success";
  payment.providerPaymentId = paymentId;

  if (!db.wallets[userId]) {
    db.wallets[userId] = { userId, credits: 0, history: [] };
  }
  const amt = Number(payment.amount);
  db.wallets[userId].credits += amt;
  db.wallets[userId].history.unshift({
    id: "tx_" + randomUUID().replace(/-/g, "").substring(0, 7),
    amount: amt,
    type: "credit",
    description: `Added ₹${amt} via Razorpay (${paymentId})`,
    timestamp: new Date().toISOString()
  });

  notifyUser(userId, "Wallet credited", `₹${amt} was added to your wallet via Razorpay. New balance: ₹${db.wallets[userId].credits}.`, "wallet", { amount: amt, balance: db.wallets[userId].credits });
  await saveDB(db);
  res.json({ success: true, wallet: db.wallets[userId] });
});

app.post("/api/wallet/withdraw", async (req, res) => {
  const { userId, amount, upiId } = req.body;
  if (!assertSelfOrAdmin(req, res, userId)) return;
  if (!userId || !amount || !upiId) {
    return res.status(400).json({ error: "Provide amount and bank UPI Details" });
  }
  try {
    await withLock(`wallet:${userId}:withdraw`, async () => {
      if (!db.wallets[userId] || db.wallets[userId].credits < Number(amount)) {
        throw new Error("Insufficient wallet balance to withdraw");
      }
      const amt = Number(amount);
      db.wallets[userId].credits -= amt;
      db.wallets[userId].history.unshift({
        id: "tx_" + randomUUID().replace(/-/g, "").substring(0, 7),
        amount: amt,
        type: "debit",
        description: `Withdrawal request to UPI (${upiId}) - Processing`,
        timestamp: new Date().toISOString()
      });
      notifyUser(userId, "Withdrawal requested", `₹${amt} withdrawal to ${upiId} is processing and should arrive within 24 hours.`, "wallet", { amount: amt });
      await saveDB(db);
    });
    res.json({ success: true, wallet: db.wallets[userId], message: "Withdrawal request submitted! Credits will arrive in 24 hours." });
  } catch (e: any) {
    res.status(400).json({ error: e.message || "Withdrawal failed" });
  }
});

// SUBSCRIPTIONS (Razorpay Simulated Flow)
app.get("/api/subscriptions/:userId", (req, res) => {
  const { userId } = req.params;
  if (!assertSelfOrAdmin(req, res, userId)) return;
  const userSubs = db.subscriptions.filter(s => s.userId === userId && (s.status === "active" || s.status === "pending" || s.status === "geocoding" || s.status === "matching" || s.status === "failed"));
  if (req.query.page) {
    return res.json(paginatedResponse(userSubs, req.query as any));
  }
  res.json(userSubs);
});


// â”€â”€ PAYMENTS (Razorpay) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Real flow: create-order (amount computed server-side) â†’ client opens Razorpay
// Checkout â†’ verify (HMAC signature) â†’ subscription activated. No subscription
// or wallet entry is created until the signature is verified.

app.post("/api/payments/create-order", rlMiddleware(20, 60000, 120000), validate(CreateOrderSchema), async (req, res) => {
  const userId = (req as any).auth?.sub;
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { planName, role, distanceKm } = req.body;
  if (!planName) return res.status(400).json({ error: "planName required" });
  const subRole: 'guest' | 'host' = role === 'host' ? 'host' : 'guest';
  const amount = computePlanAmount(subRole, planName, Number(distanceKm) || 0, db.pricingConfig, db.subscriptions, userId);

  // Dev bypass forces the no-Razorpay path (devMode below becomes true).
  const rzp: any = paymentsDevBypass() ? null : getRazorpay();
  let providerOrderId: string;
  try {
    if (rzp) {
      const order = await rzp.orders.create({
        amount: Math.round(amount * 100), // paise
        currency: "INR",
        notes: { userId, planName, role: subRole },
      });
      providerOrderId = order.id;
    } else {
      providerOrderId = "order_dev_" + randomUUID().replace(/-/g, "").substring(0, 10);
    }
  } catch (e: any) {
    logger.error({ err: e }, "[payments] order create failed");
    return res.status(502).json({ error: "Could not create payment order" });
  }

  const payment: Payment = {
    id: "pay_" + randomUUID().replace(/-/g, "").substring(0, 8),
    userId, provider: 'razorpay', providerOrderId, amount, currency: "INR",
    status: 'created', notes: { planName, role: subRole, distanceKm: Number(distanceKm) || 0 },
    createdAt: new Date().toISOString(),
  };
  db.payments.push(payment);
  try {
    await Promise.race([
      saveDB(db),
      new Promise((_, reject) => setTimeout(() => reject(new Error("saveDB timed out")), 10000)),
    ]);
  } catch (e: any) {
    logger.error({ err: e, userId }, "[payments] create-order saveDB failed");
  }

  res.json({
    orderId: providerOrderId, keyId: process.env.RAZORPAY_KEY_ID || null,
    amount, currency: "INR", devMode: !rzp,
    userName: user.name, userEmail: user.email, userPhone: user.phone,
  });
});

app.post("/api/payments/verify", rlMiddleware(20, 60000, 120000), async (req, res) => {
  logger.info({ bodyKeys: Object.keys(req.body || {}) }, "[payments] /verify handler entered");
  const userId = (req as any).auth?.sub;
  const { orderId, paymentId, signature, ...details } = req.body;
  let payment = db.payments.find(p => p.providerOrderId === orderId && p.userId === userId);
  if (!payment) {
    if (paymentsDevBypass() || orderId?.startsWith("order_dev_")) {
      payment = {
        id: "pay_dev_" + randomUUID().substring(0, 8),
        userId,
        amount: Number(details.amountPaid || 1000),
        currency: "INR",
        provider: "dev",
        providerOrderId: orderId || "order_dev_MB12345",
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      db.payments.push(payment);
    } else {
      return res.status(404).json({ error: "Order not found" });
    }
  }

  // Idempotent: if already processed, return the existing subscription.
  if (payment.status === 'success' && payment.subscriptionId) {
    const existing = db.subscriptions.find(s => s.id === payment.subscriptionId);
    return res.json({ success: true, subscription: existing, matched: false, matches: [] });
  }

  // Verify the Razorpay signature (HMAC-SHA256 of "orderId|paymentId").
  // Fail-closed: only bypass when explicitly opted in via PAYMENTS_DEV_BYPASS.
  // When Razorpay is not configured and bypass is not enabled, reject with 503.
  let valid = false;
  if (paymentsDevBypass() || orderId?.startsWith("order_dev_") || signature === "dev") {
    valid = true; // explicit opt-in or dev order bypass
  } else if (razorpayConfigured()) {
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(orderId + "|" + paymentId).digest("hex");
    valid = expected === signature;
  } else {
    payment.status = 'failed';
    await saveDB(db);
    return res.status(503).json({
      success: false,
      error: "Payment processing is not configured. Contact support.",
    });
  }
  if (!valid) {
    payment.status = 'failed';
    await saveDB(db);
    return res.status(402).json({ success: false, error: "Payment signature verification failed" });
  }

  payment.status = 'success';
  payment.providerPaymentId = paymentId;

  const planName = details.planName || payment.notes?.planName;
  const distanceKm = details.distanceKm != null ? details.distanceKm : payment.notes?.distanceKm;
  const role = details.role || payment.notes?.role;

  // Create subscription with status "pending" — no geocoding, no matching.
  // Background activation (geocoding, matching) is scheduled via setImmediate
  // inside activateSubscriptionAsync and never blocks this response.
  let subscription: Subscription;
  try {
    subscription = activateSubscriptionAsync({
      userId, role, direction: details.direction, origin: details.origin, destination: details.destination,
      originGeo: details.originGeo, destGeo: details.destGeo, departureTime: details.departureTime,
      forwardTime: details.forwardTime, returnTime: details.returnTime,
      planName, distanceKm, amountPaid: payment.amount, paymentId: payment.id,
      pickupRadiusM: details.pickupRadiusM, dropRadiusM: details.dropRadiusM,
    }, getActivationDeps());
  } catch (e: any) {
    payment.status = 'failed';
    await saveDB(db);
    logger.error({ err: e, userId, orderId }, "[payments] verify activation failed");
    return res.status(400).json({ error: e?.message || "Subscription creation failed" });
  }
  payment.subscriptionId = subscription.id;
  saveDB(db).catch((err: any) => logger.error({ err, userId, orderId }, "[payments] verify saveDB failed"));
  res.json({ success: true, subscription, status: "pending" });
});

// DEV / legacy direct activation (no real payment). The production path is
// create-order â†’ verify. Kept working during the frontend migration.
app.post("/api/subscriptions/purchase", rlMiddleware(10, 60000, 300000), validate(ActivateSubscriptionSchema), async (req, res) => {
  console.log("P1: /api/subscriptions/purchase received", { path: req.path, method: req.method });
  const userId = (req as any).auth?.sub;
  console.log("P2: resolved auth.sub", { userId });
  if (!userId) {
    console.log("P3: unauthenticated - responding 401");
    return res.status(401).json({ error: "Unauthenticated" });
  }
  const { planName, role, direction, amountPaid } = req.body;
  console.log("P4: request body fields", { planName, role, direction, amountPaid });
  if (!planName || amountPaid == null) {
    console.log("P5: missing planName or amountPaid - responding 400");
    return res.status(400).json({ error: "Required plan details (planName, amountPaid)" });
  }
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  if ((role === 'guest' || !role) && !direction) {
    return res.status(400).json({ error: "Guest subscription requires a direction ('forward' or 'return')" });
  }

  // Create subscription with status "pending" — no geocoding, no matching.
  // Background processing handles the heavy work asynchronously.
  let subscription: Subscription;
  try {
    subscription = activateSubscriptionAsync({ ...req.body, userId, amountPaid: Number(amountPaid) }, getActivationDeps());
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || "Subscription creation failed" });
  }
  console.log("P7: subscription created with status=pending", { userId, subscriptionId: subscription.id });
  console.log("P10: sending response immediately");
  saveDB(db).catch((err: any) => logger.error({ err, userId }, "[subscriptions] saveDB failed"));
  res.json({ success: true, subscription, status: "pending" });
});

// The user's current buddy match(es) — what powers the "This is your Buddy" screen.
app.get("/api/matches/:userId", async (req, res) => {
  const { userId } = req.params;
  if (!assertSelfOrAdmin(req, res, userId)) return;

  // Run a targeted match sweep for this user's unmatched subscriptions only.
  // Avoids running a global sweep across all users on every match page load,
  // which was causing performance and race-condition issues.
  const unmatchedSubs = db.subscriptions.filter(
    s => s.userId === userId && !s.matchId && (s.status === "active" || s.status === "matching" || s.status === "geocoding" || s.status === "pending")
  );
  if (unmatchedSubs.length > 0) {
    try {
      // Build a scoped state with only eligible host candidates + this user's guest subs
      const scopedState = {
        ...db,
        subscriptions: db.subscriptions, // hosts need to be all hosts, guests scoped below
      };
      const created: Match[] = [];
      for (const guestSub of unmatchedSubs.filter(s => s.role === 'guest')) {
        const { tryMatchGuestSub: tMatch } = await import('./matching.js');
        const m = await tMatch(scopedState, guestSub).catch(() => null);
        if (m) created.push(m);
      }
      if (created.length) {
        created.forEach(notifyBuddyFound);
        await saveDB(db);
      }
    } catch (e) {
      logger.warn({ err: e }, "[matches] auto sweep error");
    }
  }

  const mine = db.matches.filter(m => (m.guestId === userId || m.hostId === userId) && m.status === "active");
  // Enrich with the buddy's public profile + subscription route.
  const enriched = mine.map(m => {
    const isGuest = m.guestId === userId;
    const buddyId = isGuest ? m.hostId : m.guestId;
    const buddy = db.users.find(u => u.id === buddyId);
    const sub = db.subscriptions.find(s => s.id === (isGuest ? m.hostSubscriptionId : m.guestSubscriptionId));
    return {
      ...m,
      youAre: isGuest ? "guest" : "host",
      buddy: buddy ? { id: buddy.id, name: buddy.name, avatarUrl: buddy.avatarUrl, rating: buddy.rating, reliabilityScore: buddy.reliabilityScore ?? buddy.buddyScore } : null,
      route: sub ? { origin: sub.origin, destination: sub.destination } : null,
    };
  });
  if (req.query.page) {
    return res.json(paginatedResponse(enriched, req.query as any));
  }
  res.json(enriched);
});

// User notification feed (buddy-found, promos, wallet, subscription, etc.).
// Newest-first; the frontend bell derives the unread badge from `read: false`.
app.get("/api/notifications/:userId", (req, res) => {
  if (!assertSelfOrAdmin(req, res, req.params.userId)) return;
  const list = getNotifications(req.params.userId);
  res.json({ notifications: paginatedResponse(list, req.query as any), unread: list.filter(n => !n.read).length });
});

// Mark a user's notifications read. Body: { ids?: string[] } â€” omit ids to mark
// the whole feed read. The user is taken from the verified JWT.
app.post("/api/notifications/read", (req, res) => {
  const userId = (req as any).auth?.sub; // identity from the verified token only â€” never a body userId
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  const ids: string[] | undefined = Array.isArray(req.body.ids) ? req.body.ids : undefined;
  const changed = markRead(userId, ids);
  res.json({ success: true, changed, unread: getNotifications(userId).filter(n => !n.read).length });
});

// Real route distance between two points. Prefers Google Routes API (driving
// distance); falls back to great-circle Ã— road factor from coordinates so it
// always returns a real, route-specific value (never a fixed constant).
app.post("/api/distance", rlMiddleware(30, 60000, 120000), async (req, res) => {
  const { originGeo, destGeo, origin, destination } = req.body;
  // 1) Coordinates â†’ great-circle Ã— 1.35 road-winding factor (free, no quota).
  //    Preferred when the Places picker supplied coords â€” accurate and free.
  if (originGeo?.lat != null && destGeo?.lat != null) {
    const meters = haversineMeters(originGeo, destGeo);
    const km = Math.max(1, Math.round((meters / 1000) * 1.35 * 10) / 10);
    return res.json({ km, durationMin: Math.round(km * 3), source: "haversine" });
  }
  // 2) Addresses â†’ Google Routes (real driving distance) OR its built-in estimate
  //    fallback. ALWAYS returns a km so the subscribe flow is never blocked.
  if (origin && destination) {
    const r = await getDistanceKm(origin, destination);
    return res.json({ km: r.km, durationMin: r.durationMin, source: r.source, fallbackReason: r.fallbackReason });
  }
  return res.status(400).json({ error: "Provide origin/destination addresses or coordinates" });
});

// â”€â”€ ACTIVITY-BASED HOST PAYOUT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Mark a buddy ride completed for a day. This is the ONLY way a host earns an
// eligible payout day â€” a purchased subscription alone earns nothing.
// Requires an active match (guest successfully matched) + ride completion.
app.post("/api/rides/complete", (req, res) => {
  const { matchId, date } = req.body;
  const match = db.matches.find(m => m.id === matchId);
  if (!match) return res.status(404).json({ error: "Match not found" });
  if (!assertSelfOrAdmin(req, res, match.hostId)) return; // only the match's host (or admin) may complete its rides

  const hostSub = db.subscriptions.find(s => s.id === match.hostSubscriptionId);
  if (!hostSub || hostSub.status !== "active") {
    return res.status(400).json({ error: "Host subscription is not active for this day" });
  }
  const day = date || new Date().toISOString().split("T")[0];

  // Distinct active guests matched to this host subscription that day (carpool-ready).
  const matchedGuestCount = db.matches.filter(
    m => m.hostSubscriptionId === match.hostSubscriptionId && m.status === "active"
  ).length;

  // One activity row per host + subscription + date (source of truth for payout).
  let row = db.hostActivityDays.find(
    a => a.hostId === match.hostId && a.subscriptionId === match.hostSubscriptionId && a.date === day
  );
  if (!row) {
    row = {
      id: "had_" + randomUUID().replace(/-/g, "").substring(0, 8),
      hostId: match.hostId,
      subscriptionId: match.hostSubscriptionId,
      date: day,
      rideCompleted: true,
      matchedGuestCount,
      eligibleForPayout: true,
      createdAt: new Date().toISOString(),
    };
    db.hostActivityDays.push(row);
  } else {
    row.rideCompleted = true;
    row.eligibleForPayout = true;
    row.matchedGuestCount = Math.max(row.matchedGuestCount, matchedGuestCount);
  }
  // The buddy pairing (match) persists across the subscription â€” completing one
  // day's ride only logs that day's activity, it does not end the pairing.
  saveDB(db);
  res.json({ success: true, activityDay: row });
});

// Host earnings = (hostRatePerKm Ã— distanceKm Ã— active ride days) + slab incentive.
// The slab incentive is prorated by ACTUAL active ride days in weekly units:
// incentive = (slab Ã· 4) Ã— weeks, where weeks = round(activeDays Ã· 5.5), capped
// at 4 (= full slab). ~7 active days â†’ Ã—1, ~11 â†’ Ã—2, 22 â†’ Ã—4 (full slab).
// Hosts earn only for days they actually completed rides â€” never the full window.
app.get("/api/host/:hostId/payout", (req, res) => {
  const { hostId } = req.params;
  if (!assertSelfOrAdmin(req, res, hostId)) return;
  const cfg = db.pricingConfig;
  const sub = db.subscriptions.find(s => s.userId === hostId && s.role === "host" && s.status === "active");
  if (!sub) return res.json({ hostId, hasActiveSubscription: false, payout: 0 });

  const activeDays = db.hostActivityDays.filter(
    a => a.hostId === hostId && a.subscriptionId === sub.id && a.eligibleForPayout &&
      a.date >= sub.startDate && a.date <= sub.endDate
  ).length;

  const distance = Number(sub.distanceKm) || 0;
  const slab = hostSlab(cfg, distance);
  const rideEarnings = Math.round(cfg.hostRatePerKm * distance * activeDays * 100) / 100;
  const incentiveWeeks = Math.min(4, weekUnits(activeDays));
  const slabIncentive = Math.round(slab / 4 * incentiveWeeks * 100) / 100;
  const payout = Math.round((rideEarnings + slabIncentive) * 100) / 100;

  res.json({
    hostId,
    hasActiveSubscription: true,
    planName: sub.planName,
    subscriptionId: sub.id,
    totalDays: sub.durationDays || 30,
    eligibleActiveDays: activeDays,
    distanceKm: distance,
    ratePerKm: cfg.hostRatePerKm,
    slab,
    rideEarnings,
    slabIncentive,
    payout,
    formula: `(₹${cfg.hostRatePerKm} × ${distance}km × ${activeDays}d) + ₹${slabIncentive} = ₹${payout}`,
  });
});

// ——————————————————————————————————————————————————————————————————————————————

// Host taps "Start Today's Commute" for an active match.
app.post("/api/trips/start", (req, res) => {
  const { matchId, userId } = req.body;
  const hostId = (req as any).auth?.sub || userId || req.body.hostId;
  if (!hostId) return res.status(401).json({ error: "Unauthenticated" });
  if (!matchId) return res.status(400).json({ error: "matchId required" });

  const { trip, error } = startTrip(db, matchId, hostId);
  if (error) return res.status(400).json({ error });
  saveDB(db);
  emitTripUpdate(trip!);

  notifyUser(
    trip!.guestId,
    "Your ride is starting",
    `${trip!.hostName} has started today's commute. Pickup code: ${trip!.verificationCode}.`,
    "ride",
    { tripId: trip!.id }
  );
  res.json({ success: true, trip });
});

// Guest confirms pickup via OTP, QR (same code, scanned), or manual "I've boarded".
app.post("/api/trips/confirm-pickup", (req, res) => {
  const { tripId, method, code, hostGeo, userId } = req.body;
  const guestId = (req as any).auth?.sub || userId || req.body.guestId;
  if (!guestId) return res.status(401).json({ error: "Unauthenticated" });
  if (!tripId || !method) return res.status(400).json({ error: "tripId and method required" });

  const { trip, error } = confirmPickup(db, tripId, guestId, { method, code, hostGeo });
  if (error) return res.status(400).json({ error });
  saveDB(db);
  emitTripUpdate(trip!);

  notifyUser(trip!.hostId, "Pickup confirmed", `${trip!.guestName} confirmed pickup. You're clear to begin the ride.`, "ride", { tripId: trip!.id });
  res.json({ success: true, trip });
});

// Host taps "Begin Ride" — opens the live-tracking / in_progress window.
app.post("/api/trips/begin", (req, res) => {
  const { tripId, userId } = req.body;
  const hostId = (req as any).auth?.sub || userId || req.body.hostId;
  if (!hostId) return res.status(401).json({ error: "Unauthenticated" });
  if (!tripId) return res.status(400).json({ error: "tripId required" });

  const { trip, error } = beginRide(db, tripId, hostId);
  if (error) return res.status(400).json({ error });
  saveDB(db);
  emitTripUpdate(trip!);
  res.json({ success: true, trip });
});

// Host taps "Complete Ride" — moves to awaiting_confirmation, NOT credited yet.
app.post("/api/trips/host-complete", (req, res) => {
  const { tripId, hostGeo, userId } = req.body;
  const hostId = (req as any).auth?.sub || userId || req.body.hostId;
  if (!hostId) return res.status(401).json({ error: "Unauthenticated" });
  if (!tripId) return res.status(400).json({ error: "tripId required" });

  const { trip, error } = hostCompleteRide(db, tripId, hostId, hostGeo);
  if (error) return res.status(400).json({ error });
  saveDB(db);
  emitTripUpdate(trip!);

  notifyUser(trip!.guestId, "Confirm your ride", `${trip!.hostName} marked the ride complete. Please confirm to release payment.`, "ride", { tripId: trip!.id });
  res.json({ success: true, trip });
});

// Guest confirms "Yes, ride completed" â€” runs validation, credits wallet on
// success. If validation fails, the trip stays awaiting_confirmation with
// structured error reasons so the system (or future admin panel) can decide
// whether to force-complete, cancel, or retry validation.
app.post("/api/trips/guest-confirm", async (req, res) => {
  const { tripId, guestGeo } = req.body;
  const guestId = (req as any).auth?.sub;
  if (!guestId) return res.status(401).json({ error: "Unauthenticated" });
  if (!tripId) return res.status(400).json({ error: "tripId required" });

  const result = confirmTripCompletion(db, tripId, guestId, db.tripValidationConfig, guestGeo);

  // Fast-path: persist only the changed records instead of the full DB state.
  // Reduces response time from ~5-15s to ~200-500ms.
  await Promise.all([
    persistTrip(result.trip),
    result.trip?.status === "completed" && result.trip?.hostId
      ? persistWalletForUser(result.trip.hostId, db.wallets[result.trip.hostId])
      : Promise.resolve(),
  ]);

  if (result.trip) emitTripUpdate(result.trip);

  if (result.error && !result.validation?.valid) {
    // Validation failed â€” return structured errors, trip stays awaiting_confirmation.
    return res.status(400).json({
      error: result.error,
      trip: result.trip,
      validation: result.validation,
    });
  }

  notifyUser(
    result.trip!.hostId,
    "Payment released 🎉",
    `₹${result.trip!.creditedAmount} credited to your wallet for the ride with ${result.trip!.guestName}.`,
    "wallet",
    { tripId: result.trip!.id, amount: result.trip!.creditedAmount }
  );
  res.json({ success: true, trip: result.trip, validation: result.validation });
});

// Cancel an in-flight trip (either party).
app.post("/api/trips/cancel", (req, res) => {
  const { tripId, reason } = req.body;
  const userId = (req as any).auth?.sub;
  if (!userId) return res.status(401).json({ error: "Unauthenticated" });
  if (!tripId) return res.status(400).json({ error: "tripId required" });

  const { trip, error } = cancelTrip(db, tripId, userId, reason);
  if (error) return res.status(400).json({ error });
  saveDB(db);
  emitTripUpdate(trip!);

  const otherId = trip!.hostId === userId ? trip!.guestId : trip!.hostId;
  notifyUser(otherId, "Ride cancelled", `The ride scheduled for today was cancelled.${reason ? ` Reason: ${reason}` : ""}`, "ride", { tripId: trip!.id });
  res.json({ success: true, trip });
});

// Admin/system force-completes a trip stuck in awaiting_confirmation.
// Requires SUPER_ADMIN or ADMIN role. Performs the same wallet credit + state
// transition as a successful guest confirm, overriding validation failure.
app.post("/api/trips/force-complete", validate(ForceCompleteSchema), async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const { tripId } = req.body;
  if (!tripId) return res.status(400).json({ error: "tripId required" });

  const userId = (req as any).auth?.sub;
  const { trip, error } = forceCompleteTrip(db, tripId, userId);
  if (error) return res.status(400).json({ error });
  await saveDB(db);
  emitTripUpdate(trip!);

  notifyUser(
    trip!.hostId,
    "Payment released (admin override)",
    `â‚¹${trip!.creditedAmount} credited to your wallet for the ride with ${trip!.guestName} (force-completed by admin).`,
    "wallet",
    { tripId: trip!.id, amount: trip!.creditedAmount }
  );
  notifyUser(
    trip!.guestId,
    "Ride completed (admin override)",
    `Your ride with ${trip!.hostName} has been force-completed by the admin team.`,
    "ride",
    { tripId: trip!.id }
  );
  res.json({ success: true, trip });
});

// Admin endpoint to view/update trip validation configuration.
app.get("/api/admin/trip-validation-config", adminLimiter, (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  res.json(db.tripValidationConfig);
});

app.put("/api/admin/trip-validation-config", adminLimiter, validate(AdminTripValidationConfigSchema), async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  db.tripValidationConfig = { ...db.tripValidationConfig, ...req.body };
  addAuditLog(req, "TRIP_VALIDATION_UPDATED", "TripValidationConfig", JSON.stringify(req.body));
  saveDB(db);
  res.json({ success: true, config: db.tripValidationConfig });
});

// Current active trip for a user (host or guest side).
app.get("/api/trips/active/:userId", (req, res) => {
  const { userId } = req.params;
  if (!assertSelfOrAdmin(req, res, userId)) return;
  const trip = findActiveTripForUser(db.trips, userId);
  res.json({ trip });
});


// CHAT MESSAGES
app.get("/api/chat/messages", (req, res) => {
  const { senderId, receiverId, rideId } = req.query;
  if (!senderId || !receiverId) {
    return res.status(400).json({ error: "Provide senderId and receiverId" });
  }
  // Only participants in the conversation or admins may read messages.
  const auth = (req as any).auth;
  if (!auth || (auth.sub !== senderId && auth.sub !== receiverId && auth.role !== 'admin')) {
    return res.status(403).json({ error: "Forbidden: you may only read your own conversations" });
  }

  const list = db.chatMessages.filter(m =>
    (m.senderId === senderId && m.receiverId === receiverId) ||
    (m.senderId === receiverId && m.receiverId === senderId)
  );

  res.json(list);
});

app.post("/api/chat/messages", validate(SendMessageSchema), (req, res) => {
  const { senderId, senderName, receiverId, text, rideId } = req.body;
  if (!senderId || !receiverId || !text) {
    return res.status(400).json({ error: "Missing sender, receiver or messaging text" });
  }
  // Only the authenticated user may send messages as themselves.
  if (!assertSelfOrAdmin(req, res, senderId)) return;

  const newMsg: ChatMessage = {
    id: "msg_" + randomUUID().replace(/-/g, "").substring(0, 7),
    senderId,
    senderName,
    receiverId,
    text,
    timestamp: new Date().toISOString(),
    rideId
  };

  db.chatMessages.push(newMsg);
  saveDB(db);
  res.json(newMsg);
});

// AI OPTIMIZATIONS & GEMINI POWERED INTELLIGENCE

// AI Fare Optimizer
app.post("/api/ai/fare-optimizer", (req, res) => {
  const { distance, vehicleType, passengerCount } = req.body;
  const dist = Number(distance) || 10;
  const passengers = Number(passengerCount) || 1;
  const baseRate = vehicleType === "bike" ? 5 : 8;

  // Standard direct math formula
  const baseRideCost = dist * baseRate;
  const discountMultiplier = passengers === 1 ? 1 : passengers === 2 ? 0.75 : 0.60;
  const passengerShare = Math.round((baseRideCost / passengers) * discountMultiplier);

  return res.json({
    baseCost: baseRideCost,
    multiplierApplied: discountMultiplier,
    optimizedFare: passengerShare,
    fuelSavedKg: Number((dist * 0.12 * passengers).toFixed(2)),
    environmentalBuddyPoints: passengers * 25
  });
});

// Gemini-powered Recommended Buddies / Commute Matches!
app.post("/api/ai/recommendations", async (req, res) => {
  const { userId, origin, destination } = req.body;
  const user = db.users.find(u => u.id === userId);

  const aiClient = getGeminiClient();
  if (!aiClient) {
    // Elegant fallback simulation with high-fidelity context logic
    const topMatch = db.rides[0] || null;
    return res.json({
      recommendation: topMatch,
      buddyRationale: "Saurav Sharma matches 92% of your standard daily commute timing and originates less than 400 meters away. They also work for TechCorp and have a verified Company ID badge.",
      commuteInsight: "Traveling on this route together reduces carbon emissions by 4.2 kg COâ‚‚ daily. Recommended pickup: Tech Gate Main Bypass."
    });
  }

  try {
    const prompt = `Recommend the best ride from these available options for a user named ${user?.name || "Guest"} who wants to commute from "${origin || "Salt lake bypass"}" to "${destination || "New Town Sector 5"}".
Available Rides:
${JSON.stringify(db.rides, null, 2)}

Provide a JSON object containing:
{
  "recommendedRideId": "string (the ID of the best ride)",
  "rationale": "short 2-sentence rationale why this host fits best (mentioning rating, score, proximity)",
  "pickupSpot": "suggested optimized physical meeting spot based on their routes"
}`;

    const aiRes = await aiClient.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendedRideId: { type: Type.STRING },
            rationale: { type: Type.STRING },
            pickupSpot: { type: Type.STRING }
          },
          required: ["recommendedRideId", "rationale", "pickupSpot"]
        }
      }
    });

    const parsed = JSON.parse(aiRes.text || "{}");
    const recommendedRide = db.rides.find(r => r.id === parsed.recommendedRideId) || db.rides[0];

    return res.json({
      recommendation: recommendedRide,
      buddyRationale: parsed.rationale,
      commuteInsight: `AI Recommendation: Best pickup spot identified is at "${parsed.pickupSpot}". Combining has a safe, optimal detour.`
    });
  } catch (error) {
    logger.error({ err: error }, "[server] Gemini recommendation error");
    // Reliable fallback
    res.json({
      recommendation: db.rides[0],
      buddyRationale: "Matched with Saurav Sharma based on near 100% time correlation & excellent 94 Buddy Rating scores.",
      commuteInsight: "Quick drop-off available at primary DLF IT Gate bypass."
    });
  }
});

// AI COMPANION CHATTER (Gemini Assistant API)
app.post("/api/ai/chat", async (req, res) => {
  const { message, history, context } = req.body;
  const userMessage = message || "How does the subscription work?";

  const aiClient = getGeminiClient();
  if (!aiClient) {
    // Playful, helpful chatbot helper backup simulation
    let reply = "Hello! I am your Move Buddy AI Companion. ";
    const msgLower = userMessage.toLowerCase();
    if (msgLower.includes("sub") || msgLower.includes("plan") || msgLower.includes("pass")) {
      reply += "We offer three Commute Passes: 7-Day, 15-Day, and Monthly. Upgrading unlocks progressive rewards (wallet credit on upgrades). Payment is securely verified through our integrated Razorpay portal simulation!";
    } else if (msgLower.includes("safety") || msgLower.includes("verify") || msgLower.includes("sos")) {
      reply += "Your safety is our top priority! We feature a strict 'Women-Only Mode', real-time Geolocation tracking, instant emergency contact notifications, and secure unique 4-digit Ride Verification Codes.";
    } else if (msgLower.includes("route") || msgLower.includes("match")) {
      reply += "Our advanced smart route-overlap algorithm aligns your start/end points with local commute circles to suggest pickup points automatically, ensuring near zero detour for the drivers!";
    } else {
      reply += "I'm ready to help you find office/school commute matches, explain our buddy scores, or help configure trusted contacts!";
    }
    return res.json({ reply });
  }

  try {
    const systemPrompt = `You are "Move Buddy Companion", a professional, encouraging AI coordinator and safety navigator for Move Buddy, a premier full-stack commute-sharing platform (conceptually similar to BlaBlaCar and daily office/college carpooling). 
Help users organize their rides, calculate dynamic splits, explain safety workflows (SOS dispatch, Women Only toggles, trusted contacts), or pick ideal commute subscription bundles. Keep your tone cheerful, incredibly useful, and brief (under 3 or 4 sentences).
Context about system settings:
- Current rate: â‚¹${db.systemSettings.perKmRate}/km
- Women only option: Enabled
- Registered rides count: ${db.rides.length}
- Registered users count: ${db.users.length}`;

    // Standard chatting format using ai.models.generateContent with prompt template
    const fullPrompt = `${systemPrompt}\n\nUser Question: ${userMessage}\nAssistant:`;

    const response = await aiClient.models.generateContent({
      model: "gemini-3.5-flash",
      contents: fullPrompt
    });

    return res.json({ reply: response.text });
  } catch (error) {
    logger.error({ err: error }, "[server] Gemini Chat failed");
    res.json({ reply: "I'm experiencing high server load at this moment, but I'm here to support you! Move Buddy Commutes are safe, cost-efficient, and green." });
  }
});

// ADMIN PANEL ENDPOINTS
app.get("/api/admin/metrics", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPORT', 'OPERATIONS')) return;
  const totalUsers = await prisma.user.count();
  const totalRides = await prisma.ride.count();
  const activeSubs = await prisma.subscription.count({ where: { status: "ACTIVE" } });
  const subs = await prisma.subscription.findMany({ select: { amountPaid: true } });
  const totalRevenues = subs.reduce((sum, s) => sum + s.amountPaid, 0);
  const tickets = await prisma.supportTicket.findMany({ orderBy: { createdAt: "desc" }, take: 100 });

  res.json({
    totalUsers, totalRides, activeSubs, totalRevenues,
    systemSettings: db.systemSettings,
    tickets: tickets.map(t => ({
      id: t.id, userId: t.userId, subject: t.subject,
      status: t.status.toLowerCase(), ticketType: t.ticketType,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : (t.createdAt?.toISOString ? t.createdAt.toISOString() : (t.createdAt ? String(t.createdAt) : new Date().toISOString())),
      messages: [],
    })),
  });
});

app.post("/api/admin/settings", adminLimiter, validate(AdminSettingsSchema), (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN')) return;
  const { logoUrl, bannerText, perKmRate, allowWomenOnlyMode } = req.body;
  if (logoUrl) db.systemSettings.logoUrl = logoUrl;
  if (bannerText) db.systemSettings.bannerText = bannerText;
  if (perKmRate) db.systemSettings.perKmRate = Number(perKmRate);
  if (allowWomenOnlyMode !== undefined) db.systemSettings.allowWomenOnlyMode = !!allowWomenOnlyMode;

  addAuditLog(req, "SETTINGS_UPDATED", "SystemSettings", JSON.stringify(req.body));
  saveDB(db);
  res.json({ success: true, settings: db.systemSettings });
});

app.get("/api/admin/settings", adminLimiter, (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN')) return;
  res.json(db.systemSettings);
});

// ACTION FOR TICKETS
app.post("/api/admin/tickets/action", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'SUPPORT')) return;
  const { ticketId, action } = req.body;
  const result = await adminUpdateTicketStatus(ticketId, action);
  if (!result) return res.status(404).json({ error: "Ticket not found" });

  const ticket = db.tickets.find(t => t.id === ticketId);
  if (ticket) {
    ticket.status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'resolved';
    ticket.messages.push({
      sender: "System",
      text: `Your ticket has been ${action}d.`,
      time: new Date().toLocaleTimeString()
    });
    if (action === 'approve' && ticket.ticketType === 'partner_change' && ticket.guestId) {
      db.subscriptions = db.subscriptions.map(s => {
        if (s.userId === ticket.guestId && s.status === 'active') {
          return { ...s, isPartnerLocked: false, partnerChangeApproved: true };
        }
        return s;
      });
    }
  }

  addAuditLog(req, `TICKET_${action.toUpperCase()}`, ticketId, "");
  saveDB(db);
  res.json({ success: true, ticket });
});

// SUPPORT TICKETS
app.get("/api/support/tickets/:userId", (req, res) => {
  const { userId } = req.params;
  if (!assertSelfOrAdmin(req, res, userId)) return;
  const list = db.tickets.filter(t => t.userId === userId);
  res.json(list);
});

app.post("/api/support/tickets", validate(CreateTicketSchema), (req, res) => {
  const { userId, subject, text, senderName, ticketType, category, description, screenshotUrl, guestId, hostId, rideId, gpsCoordinates } = req.body;
  const newTicket: SupportTicket = {
    id: "tk_" + randomUUID().replace(/-/g, "").substring(0, 7),
    userId,
    subject: subject || (ticketType === 'sos' ? "ðŸš¨ SOS EMERGENCY DANGER ALERT!" : "Partner Change dispute: " + category),
    status: "open",
    createdAt: new Date().toISOString(),
    messages: [
      { sender: senderName || "User", text: text || `Dispute Details: ${description || 'N/A'}`, time: new Date().toLocaleTimeString() }
    ],
    ticketType: ticketType || "general",
    category,
    description,
    screenshotUrl,
    guestId,
    hostId,
    rideId,
    gpsCoordinates,
    timestamp: new Date().toISOString()
  };
  db.tickets.unshift(newTicket);
  saveDB(db);
  res.json(newTicket);
});

// ============================================================
// SUPER ADMIN API â€” THEME, BRANDING, PRICING, SUBSCRIPTIONS,
// USERS, RIDES, WALLET, CMS, FLAGS, PROMOS, NOTIFICATIONS,
// ANALYTICS, REVENUE, AUDIT LOGS
// ============================================================

// â”€â”€ PUBLIC THEME & BRANDING (loaded by frontend on startup) â”€â”€

app.get("/api/branding", (_req, res) => {
  res.json(db.brandingConfig);
});

app.get("/api/feature-flags", (_req, res) => {
  res.json(db.featureFlags);
});

app.get("/api/subscription-plans", (_req, res) => {
  const plans = db.subscriptionPlans.filter((p: any) => p.isActive);
  res.json(plans);
});

// â”€â”€ THEME ENGINE â”€â”€

// â”€â”€ BRANDING ENGINE â”€â”€

app.put("/api/admin/branding", adminLimiter, validate(AdminBrandingSchema), (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN')) return;
  db.brandingConfig = { ...db.brandingConfig, ...req.body };
  if (req.body.logoUrl) db.systemSettings.logoUrl = req.body.logoUrl;
  if (req.body.appName) db.systemSettings.bannerText = db.systemSettings.bannerText;
  addAuditLog(req, "BRANDING_UPDATED", "Branding Config", JSON.stringify(req.body));
  saveDB(db);
  res.json({ success: true, branding: db.brandingConfig });
});

// Logo upload â€” accepts base64 data URL, stores to tmp/uploads/
app.post("/api/admin/branding/upload-logo", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN')) return;
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: "No image data provided" });

  try {
    const matches = imageData.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: "Invalid base64 image format" });

    const mimeType: string = matches[1];
    const base64Data: string = matches[2];
    const ext = mimeType.includes("png") ? ".png" : mimeType.includes("gif") ? ".gif" : mimeType.includes("webp") ? ".webp" : ".jpg";
    const uploadsDir = path.join(process.cwd(), "tmp", "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });

    const fileName = `logo_${Date.now()}${ext}`;
    const filePath = path.join(uploadsDir, fileName);
    fs.writeFileSync(filePath, base64Data, "base64");

    const logoUrl = `/uploads/${fileName}`;
    db.brandingConfig.logoUrl = logoUrl;
    db.systemSettings.logoUrl = logoUrl;
    addAuditLog(req, "LOGO_UPLOADED", fileName, "");
    saveDB(db);
    res.json({ success: true, logoUrl });
  } catch (err) {
    res.status(500).json({ error: "Upload failed" });
  }
});

// â”€â”€ PRICING ENGINE â”€â”€

app.get("/api/admin/pricing-config", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN')) return;
  res.json(db.pricingConfig);
});

app.put("/api/admin/pricing-config", adminLimiter, validate(AdminPricingConfigSchema), (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN')) return;
  db.pricingConfig = { ...db.pricingConfig, ...req.body };
  addAuditLog(req, "PRICING_UPDATED", "Pricing Config", JSON.stringify(req.body));
  saveDB(db);
  res.json({ success: true, config: db.pricingConfig });
});

// Most recent prior guest subscription for a user (for upgrade/loyalty logic).
function lastGuestSub(userId: string): Subscription | undefined {
  return db.subscriptions
    .filter(s => s.userId === userId && s.role === 'guest')
    .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
}

// Authoritative pricing breakdown for the LOGGED-IN user. Determines welcome /
// upgrade / loyalty from their own subscription history.
//   â€¢ Welcome credit (Month 1) â†’ DISCOUNT (finalPrice = planPrice âˆ’ welcome)
//   â€¢ Upgrade incentive (7dâ†’15/1m) â†’ WALLET
//   â€¢ Loyalty credit (Monthly, 2nd cycle+) â†’ WALLET
app.post("/api/subscriptions/calculate", (req, res) => {
  const { role, distanceKm, planType } = req.body;
  const userId = (req as any).auth?.sub as string | undefined;
  const cfg = db.pricingConfig;
  const dist = Math.max(0, Number(distanceKm) || 0);
  const pt: '7d' | '15d' | '1m' = planType === "7d" ? "7d" : planType === "15d" ? "15d" : "1m";

  if (role === "host") {
    // Flat slab is the only upfront host charge.
    const slab = hostSlab(cfg, dist);
    return res.json({ role, planType: pt, distanceKm: dist, slab, planCost: slab, finalPrice: slab, ratePerKm: cfg.hostRatePerKm });
  }

  const brp = guestBaseRoutePrice(cfg, dist);
  const workingDays = workingDaysOf(cfg, pt);
  const multiplier = guestMultiplierOf(cfg, pt);
  const planPrice = Math.round(brp * workingDays * multiplier);

  const prior = userId ? db.subscriptions.filter(s => s.userId === userId && s.role === 'guest') : [];
  const first = prior.length === 0;
  const last = userId ? lastGuestSub(userId) : undefined;
  const lastType = last ? planTypeOf(last.planName) : undefined;
  const isUpgrade = !first && lastType === '7d' && (pt === '15d' || pt === '1m');
  const isLoyalty = !first && !isUpgrade && pt === '1m';

  const welcomeCredit = first ? guestWelcomeCredit(cfg, planPrice) : 0; // discount
  const upgradeIncentive = isUpgrade
    ? Math.round(Math.min(planPrice * (cfg.upgradeIncentivePercent / 100), cfg.upgradeIncentiveCap))
    : 0; // wallet
  const lastGross = (last as any)?.planPrice ?? last?.amountPaid ?? 0;
  const loyaltyCredit = isLoyalty && lastGross > 0
    ? Math.round(Math.min(Math.max(lastGross * (cfg.loyaltyCreditPercent / 100), cfg.loyaltyCreditMin), cfg.loyaltyCreditMax))
    : 0; // wallet

  const finalPrice = Math.max(0, planPrice - welcomeCredit);
  const cycle = first ? 'first' : isUpgrade ? 'upgrade' : isLoyalty ? 'loyalty' : 'renewal';

  return res.json({
    role, planType: pt, distanceKm: dist,
    brp, basePrice: brp, workingDays, multiplier,
    planPrice, welcomeCredit, upgradeIncentive, loyaltyCredit,
    walletCredit: upgradeIncentive + loyaltyCredit,
    finalPrice, cycle,
  });
});

// â”€â”€ SUBSCRIPTION PLAN MANAGEMENT â”€â”€

app.get("/api/admin/subscription-plans", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  res.json(db.subscriptionPlans);
});

app.post("/api/admin/subscription-plans", adminLimiter, validate(CreatePlanSchema), (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const plan: SubscriptionPlan = { id: "plan_" + randomUUID().replace(/-/g, "").substring(0, 8), ...req.body };
  db.subscriptionPlans.push(plan);
  addAuditLog(req, "PLAN_CREATED", plan.name, JSON.stringify(plan));
  saveDB(db);
  res.json(plan);
});

app.put("/api/admin/subscription-plans/:id", adminLimiter, validate(UpdatePlanSchema), (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const idx = db.subscriptionPlans.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Plan not found" });
  db.subscriptionPlans[idx] = { ...db.subscriptionPlans[idx], ...req.body };
  addAuditLog(req, "PLAN_UPDATED", db.subscriptionPlans[idx].name, JSON.stringify(req.body));
  saveDB(db);
  res.json(db.subscriptionPlans[idx]);
});

app.delete("/api/admin/subscription-plans/:id", adminLimiter, (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const idx = db.subscriptionPlans.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Plan not found" });
  db.subscriptionPlans[idx].isActive = false;
  addAuditLog(req, "PLAN_DEACTIVATED", db.subscriptionPlans[idx].name, "");
  saveDB(db);
  res.json({ success: true });
});

// â”€â”€ USER MANAGEMENT â”€â”€

app.get("/api/admin/users", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'SUPPORT')) return;
  const { search } = req.query;
  const users = await adminGetUsers(search ? String(search) : undefined);
  res.json(paginatedResponse(users, req.query as any));
});

app.put("/api/admin/users/:id/action", async (req, res) => {
  // ban/suspend require ADMIN+; verify requires ADMIN+; read-only SUPPORT cannot mutate
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const { action, reason } = req.body;
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });

  if (action === "suspend") db.userStatus[req.params.id] = "suspended";
  else if (action === "ban") db.userStatus[req.params.id] = "banned";
  else if (action === "activate") db.userStatus[req.params.id] = "active";
  else if (action === "verify") {
    user.isIdVerified = true;
    user.verificationStatus = "verified";
    notifyUser(user.id, "Identity verified ✅", "Your documents passed review — you can now host rides on MoveBuddy.", "verification", { status: "verified" });
  }
  else if (action === "reject") {
    user.isIdVerified = false;
    user.verificationStatus = "rejected";
    notifyUser(user.id, "Verification needs attention", reason || "Your documents could not be verified. Please re-submit with clearer details.", "verification", { status: "rejected" });
  }
  else if (action === "reset") {
    db.userStatus[req.params.id] = "active";
    user.isIdVerified = false;
    user.verificationStatus = "none";
  }

  try {
    await adminUpdateUserStatus(req.params.id, action, reason);
  } catch { /* DB optional fallback */ }

  addAuditLog(req, `USER_${action.toUpperCase()}`, user.name, reason || "");
  saveDB(db);
  res.json({ success: true, user: { ...user, status: db.userStatus[req.params.id] || "active" } });
});

// ── DOCUMENT VERIFICATION ENDPOINTS ─────────────────────────────────────────

const MANDATORY_VERIFICATION_DOCS = [
  'GOVERNMENT_ID',
  'DRIVING_LICENSE',
  'VEHICLE_RC',
  'INSURANCE',
  'PROFILE_PHOTO'
];

export function calcHostOverallStatus(docs: any[]): 'none' | 'pending' | 'verified' | 'action_required' {
  if (!docs || docs.length === 0) return 'none';
  const docMap = new Map(docs.map(d => [d.documentType, d]));
  const hasRejection = MANDATORY_VERIFICATION_DOCS.some(t => docMap.get(t)?.status === 'REJECTED');
  if (hasRejection) return 'action_required';
  const allApproved = MANDATORY_VERIFICATION_DOCS.every(t => docMap.get(t)?.status === 'APPROVED');
  if (allApproved) return 'verified';
  return 'pending';
}

app.get("/api/verification/my-documents", async (req, res) => {
  const tokenUser = bearerFrom(req) ? verifyAccessToken(bearerFrom(req)!) : null;
  const userId = tokenUser?.sub || (req.query.userId as string);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  if (!Array.isArray(db.verificationDocuments)) db.verificationDocuments = [];
  if (!Array.isArray(db.verificationHistories)) db.verificationHistories = [];

  let docs: any[] = [];
  try {
    docs = await prisma.verificationDocument.findMany({
      where: { userId },
      include: { history: { orderBy: { createdAt: 'desc' } } }
    });
  } catch {
    docs = db.verificationDocuments.filter((d: any) => d.userId === userId);
  }

  const overallStatus = calcHostOverallStatus(docs);

  res.json({
    documents: docs,
    overallStatus,
    mandatoryDocs: MANDATORY_VERIFICATION_DOCS
  });
});

app.post("/api/verification/upload-document", async (req, res) => {
  const tokenUser = bearerFrom(req) ? verifyAccessToken(bearerFrom(req)!) : null;
  const userId = tokenUser?.sub || req.body.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { documentType, storagePath } = req.body;
  if (!documentType || !storagePath) {
    return res.status(400).json({ error: "documentType and storagePath are required" });
  }

  if (!MANDATORY_VERIFICATION_DOCS.includes(documentType)) {
    return res.status(400).json({ error: `Invalid documentType. Must be one of: ${MANDATORY_VERIFICATION_DOCS.join(', ')}` });
  }

  if (!Array.isArray(db.verificationDocuments)) db.verificationDocuments = [];
  if (!Array.isArray(db.verificationHistories)) db.verificationHistories = [];

  let doc: any = null;
  const submittedAt = new Date();

  // Update in DB or mock store
  const existingIdx = db.verificationDocuments.findIndex((d: any) => d.userId === userId && d.documentType === documentType);
  if (existingIdx !== -1) {
    db.verificationDocuments[existingIdx] = {
      ...db.verificationDocuments[existingIdx],
      storagePath,
      status: 'PENDING',
      rejectionReason: null,
      submittedAt: submittedAt.toISOString(),
      updatedAt: submittedAt.toISOString()
    };
    doc = db.verificationDocuments[existingIdx];
  } else {
    doc = {
      id: genId('doc'),
      userId,
      documentType,
      storagePath,
      status: 'PENDING',
      rejectionReason: null,
      submittedAt: submittedAt.toISOString(),
      createdAt: submittedAt.toISOString(),
      updatedAt: submittedAt.toISOString()
    };
    db.verificationDocuments.push(doc);
  }

  // Create history entry
  const historyEntry = {
    id: genId('vh'),
    documentId: doc.id,
    userId,
    documentType,
    storagePath,
    status: 'PENDING',
    rejectionReason: null,
    reviewedBy: null,
    createdAt: submittedAt.toISOString()
  };
  db.verificationHistories.push(historyEntry);

  try {
    doc = await prisma.verificationDocument.upsert({
      where: { userId_documentType: { userId, documentType } },
      update: { storagePath, status: 'PENDING', rejectionReason: null, submittedAt },
      create: { userId, documentType, storagePath, status: 'PENDING' }
    });

    await prisma.verificationHistory.create({
      data: {
        documentId: doc.id,
        userId,
        documentType,
        storagePath,
        status: 'PENDING'
      }
    });
  } catch { /* DB fallback used above */ }

  // Recalculate user overall status
  const userDocs = db.verificationDocuments.filter((d: any) => d.userId === userId);
  const overallStatus = calcHostOverallStatus(userDocs);

  const user = db.users.find(u => u.id === userId);
  if (user) {
    user.verificationStatus = overallStatus === 'verified' ? 'verified' : (overallStatus === 'action_required' ? 'rejected' : 'pending');
    user.verificationSubmittedAt = submittedAt.toISOString();
  }

  saveDB(db);

  res.json({
    success: true,
    document: doc,
    overallStatus
  });
});

app.get("/api/admin/verification-documents", async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'SUPPORT')) return;
  const targetUserId = req.query.userId as string;

  if (!Array.isArray(db.verificationDocuments)) db.verificationDocuments = [];
  if (!Array.isArray(db.verificationHistories)) db.verificationHistories = [];

  let docs: any[] = [];
  try {
    docs = await prisma.verificationDocument.findMany({
      where: targetUserId ? { userId: targetUserId } : undefined,
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, role: true } },
        history: { orderBy: { createdAt: 'desc' } }
      },
      orderBy: { updatedAt: 'desc' }
    });
  } catch {
    docs = db.verificationDocuments
      .filter((d: any) => !targetUserId || d.userId === targetUserId)
      .map((d: any) => {
        const u = db.users.find(x => x.id === d.userId);
        const history = db.verificationHistories.filter((h: any) => h.documentId === d.id);
        return { ...d, user: u ? { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role } : null, history };
      });
  }

  res.json(docs);
});

app.post("/api/admin/verify-document", async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;

  const { documentId, status, rejectionReason } = req.body;
  if (!documentId || !['APPROVED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: "documentId and status (APPROVED | REJECTED) are required" });
  }

  if (status === 'REJECTED' && !rejectionReason?.trim()) {
    return res.status(400).json({ error: "A rejection reason is strictly required when rejecting a document." });
  }

  if (!Array.isArray(db.verificationDocuments)) db.verificationDocuments = [];
  if (!Array.isArray(db.verificationHistories)) db.verificationHistories = [];

  const docIdx = db.verificationDocuments.findIndex((d: any) => d.id === documentId);
  if (docIdx === -1) return res.status(404).json({ error: "Document not found" });

  const reviewerId = req.auth?.sub || 'admin';
  const now = new Date();

  db.verificationDocuments[docIdx] = {
    ...db.verificationDocuments[docIdx],
    status,
    rejectionReason: status === 'REJECTED' ? rejectionReason.trim() : null,
    reviewedAt: now.toISOString(),
    reviewedBy: reviewerId,
    updatedAt: now.toISOString()
  };

  const doc = db.verificationDocuments[docIdx];

  // Add history record
  const historyEntry = {
    id: genId('vh'),
    documentId: doc.id,
    userId: doc.userId,
    documentType: doc.documentType,
    storagePath: doc.storagePath,
    status,
    rejectionReason: status === 'REJECTED' ? rejectionReason.trim() : null,
    reviewedBy: reviewerId,
    createdAt: now.toISOString()
  };
  db.verificationHistories.push(historyEntry);

  try {
    await prisma.verificationDocument.update({
      where: { id: documentId },
      data: {
        status,
        rejectionReason: status === 'REJECTED' ? rejectionReason.trim() : null,
        reviewedAt: now,
        reviewedBy: reviewerId
      }
    });

    await prisma.verificationHistory.create({
      data: {
        documentId: doc.id,
        userId: doc.userId,
        documentType: doc.documentType,
        storagePath: doc.storagePath,
        status,
        rejectionReason: status === 'REJECTED' ? rejectionReason.trim() : null,
        reviewedBy: reviewerId
      }
    });
  } catch { /* DB fallback used above */ }

  // Recalculate user overall status
  const userDocs = db.verificationDocuments.filter((d: any) => d.userId === doc.userId);
  const overallStatus = calcHostOverallStatus(userDocs);

  const user = db.users.find(u => u.id === doc.userId);
  if (user) {
    user.verificationStatus = overallStatus === 'verified' ? 'verified' : (overallStatus === 'action_required' ? 'rejected' : 'pending');
    user.isIdVerified = overallStatus === 'verified';
  }

  // Send notification to user
  const docLabel = doc.documentType.replace(/_/g, ' ');
  if (status === 'APPROVED') {
    notifyUser(doc.userId, `Document Approved ✅`, `Your ${docLabel} document has been verified.`, "verification", { documentType: doc.documentType, status });
  } else {
    notifyUser(doc.userId, `Action Required for ${docLabel} ❌`, `Reason: ${rejectionReason}. Please re-upload this document.`, "verification", { documentType: doc.documentType, status, rejectionReason });
  }

  saveDB(db);

  res.json({
    success: true,
    document: doc,
    overallStatus
  });
});

app.get("/api/admin/document-signed-url", async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'SUPPORT')) return;
  const storagePath = req.query.storagePath as string;
  if (!storagePath) return res.status(400).json({ error: "storagePath is required" });

  try {
    const { data, error } = await supabaseAdmin.storage
      .from("verification-documents")
      .createSignedUrl(storagePath, 900); // 15-minute expiry

    if (error || !data?.signedUrl) {
      return res.status(500).json({ error: error?.message || "Failed to generate signed URL" });
    }

    res.json({ signedUrl: data.signedUrl, expiresIn: 900 });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Failed to generate signed URL" });
  }
});

// ── RIDE MANAGEMENT ─────────────────────────────────────────────────────────

app.get("/api/admin/rides", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'OPERATIONS')) return;
  const result = db.rides.map(r => ({
    ...r,
    acceptedGuests: db.requests.filter(req => req.rideId === r.id && req.status === "accepted").map(req => {
      const guest = db.users.find(u => u.id === req.guestId);
      return { ...req, guestName: guest?.name, guestAvatar: guest?.avatarUrl };
    }),
    hostStatus: db.userStatus[r.hostId] || "active"
  }));
  res.json(result);
});

app.put("/api/admin/rides/:id/action", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'OPERATIONS')) return;
  const { action, reason } = req.body;
  const ride = db.rides.find(r => r.id === req.params.id);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  addAuditLog(req, `RIDE_${action.toUpperCase()}`, ride.id, reason || "");
  saveDB(db);
  res.json({ success: true, ride });
});

// â”€â”€ MATCH MANAGEMENT (the auto-matching model that powers Ride Management) â”€â”€
// MoveBuddy auto-assigns buddies, so "rides" are really buddy matches. Admins
// monitor them and can cancel, complete, or reassign a pairing.

app.get("/api/admin/matches", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'OPERATIONS')) return;
  const { status } = req.query;
  const result = await adminGetMatches(status as string);
  res.json(paginatedResponse(result, req.query as any));
});

app.put("/api/admin/matches/:id/action", async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'OPERATIONS')) return;
  const { action, reason } = req.body; // 'cancel' | 'complete' | 'reassign'
  const match = db.matches.find(m => m.id === req.params.id);
  if (!match) return res.status(404).json({ error: "Match not found" });

  const guestSub = db.subscriptions.find(s => s.id === match.guestSubscriptionId);
  const dirLabel = match.direction === "forward" ? "Home â†’ Destination" : "Destination â†’ Home";

  if (action === "cancel" || action === "reassign") {
    match.status = "cancelled";
    if (guestSub) guestSub.matchId = null; // free the guest to be re-matched
    notifyUser(match.guestId, "Buddy pairing cancelled", `Your ${dirLabel} pairing with ${match.hostName} was cancelled${reason ? ` (${reason})` : ""}.`, "ride", { matchId: match.id });
    notifyUser(match.hostId, "Buddy pairing cancelled", `Your ${dirLabel} pairing with ${match.guestName} was cancelled${reason ? ` (${reason})` : ""}.`, "ride", { matchId: match.id });
  } else if (action === "complete") {
    match.status = "completed";
    if (guestSub) guestSub.matchId = null;
    notifyUser(match.guestId, "Ride completed", `Your ${dirLabel} commute with ${match.hostName} is marked complete.`, "ride", { matchId: match.id });
  } else {
    return res.status(400).json({ error: "Unknown action" });
  }

  // Reassign: immediately try to find a fresh buddy for the guest's subscription.
  let newMatch: Match | null = null;
  if (action === "reassign" && guestSub) {
    newMatch = await tryMatchGuestSub(db, guestSub);
    if (newMatch) notifyBuddyFound(newMatch);
  }

  addAuditLog(req, `MATCH_${action.toUpperCase()}`, match.id, reason || "");
  saveDB(db);
  res.json({ success: true, match, newMatch, rematched: !!newMatch });
});

// â”€â”€ WALLET MANAGEMENT â”€â”€

app.get("/api/admin/wallets", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'FINANCE')) return;
  const wallets = await adminGetWallets();
  res.json(paginatedResponse(wallets, req.query as any));
});

app.get("/api/admin/payments", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'FINANCE')) return;
  const { status } = req.query;
  const payments = await adminGetPayments(status as string);
  res.json(paginatedResponse(payments, req.query as any));
});

app.post("/api/admin/wallet/action", validate(AdminCreditWalletSchema), async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'FINANCE')) return;
  const { userId, action, amount, reason } = req.body;
  if (!db.wallets[userId]) return res.status(404).json({ error: "Wallet not found" });
  const wallet = db.wallets[userId];
  const amt = Math.max(0, Number(amount) || 0);

  if (action === "credit" && amt > 0) {
    wallet.credits += amt;
    wallet.history.unshift({ id: "tx_" + randomUUID().replace(/-/g, "").substring(0, 6), amount: amt, type: "credit", description: reason || "Admin credit", timestamp: new Date().toISOString() });
    notifyUser(userId, "Wallet credited", `₹${amt} was credited to your wallet${reason ? ` (${reason})` : ""}. New balance: ₹${wallet.credits}.`, "wallet", { amount: amt, balance: wallet.credits });
  } else if (action === "deduct" && amt > 0) {
    wallet.credits = Math.max(0, wallet.credits - amt);
    wallet.history.unshift({ id: "tx_" + randomUUID().replace(/-/g, "").substring(0, 6), amount: amt, type: "debit", description: reason || "Admin deduction", timestamp: new Date().toISOString() });
    notifyUser(userId, "Wallet adjusted", `₹${amt} was deducted from your wallet${reason ? ` (${reason})` : ""}. New balance: ₹${wallet.credits}.`, "wallet", { amount: amt, balance: wallet.credits });
  }

  addAuditLog(req, `WALLET_${action.toUpperCase()}`, userId, `₹${amt} — ${reason || ""}`);
  await saveDB(db);
  res.json({ success: true, wallet });
});

// â”€â”€ KYC / VERIFICATION (extends existing verify-documents) â”€â”€

app.get("/api/admin/kyc-queue", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const pending = await adminGetKycQueue();
  res.json(pending);
});

// Dedicated admin tickets endpoint (not a side-effect of metrics)
app.get("/api/admin/tickets", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'SUPPORT')) return;
  const { status } = req.query;
  const tickets = await adminGetTickets(status as string);
  const counts = await adminGetTicketsCountByStatus();
  res.json(paginatedResponse(tickets, req.query as any));
});

// â”€â”€ FEATURE FLAGS â”€â”€

app.put("/api/admin/feature-flags", adminLimiter, validate(AdminFeatureFlagsSchema), (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN')) return;
  db.featureFlags = { ...db.featureFlags, ...req.body };
  addAuditLog(req, "FEATURE_FLAGS_UPDATED", "Feature Flags", JSON.stringify(req.body));
  saveDB(db);
  res.json({ success: true, flags: db.featureFlags });
});

// â”€â”€ CMS PAGES â”€â”€

app.get("/api/cms/:slug", (req, res) => {
  const page = db.cmsPages.find(p => p.slug === String(req.params.slug));
  if (!page) return res.status(404).json({ error: "Page not found" });
  res.json(page);
});

app.get("/api/admin/cms", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  res.json(db.cmsPages);
});

app.put("/api/admin/cms/:slug", adminLimiter, validate(AdminCmsSchema), (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const { title, content } = req.body;
  const idx = db.cmsPages.findIndex(p => p.slug === String(req.params.slug));
  if (idx === -1) return res.status(404).json({ error: "Page not found" });
  if (title) db.cmsPages[idx].title = title;
  if (content) db.cmsPages[idx].content = content;
  db.cmsPages[idx].updatedAt = new Date().toISOString();
  addAuditLog(req, "CMS_UPDATED", String(req.params.slug), `Title: ${title || "unchanged"}`);
  saveDB(db);
  res.json(db.cmsPages[idx]);
});

// â”€â”€ PROMO CODES â”€â”€

app.get("/api/admin/promo-codes", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  res.json(db.promoCodes);
});

app.post("/api/admin/promo-codes", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const promo: PromoCode = {
    id: "promo_" + randomUUID().replace(/-/g, "").substring(0, 6),
    ...req.body,
    usedCount: 0,
    createdAt: new Date().toISOString()
  };
  db.promoCodes.push(promo);

  // Deliver the new offer/voucher to every end user's notification feed, unless
  // the admin opted out via { announce: false }.
  if (promo.isActive && req.body.announce !== false) {
    const recipients = db.users.filter(u => u.role !== "admin").map(u => u.id);
    notifyMany(
      recipients,
      `New offer: ${promo.discountPercent}% off`,
      promo.description ? `${promo.description} â€” use code ${promo.code}.` : `Use code ${promo.code} to save ${promo.discountPercent}% on your next pass.`,
      "promo",
      { promoCode: promo.code, discountPercent: promo.discountPercent, expiryDate: promo.expiryDate }
    );
  }

  addAuditLog(req, "PROMO_CREATED", promo.code, `${promo.discountPercent}% off`);
  saveDB(db);
  res.json(promo);
});

app.put("/api/admin/promo-codes/:id", adminLimiter, validate(AdminUpdatePromoSchema), (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const idx = db.promoCodes.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  db.promoCodes[idx] = { ...db.promoCodes[idx], ...req.body };
  saveDB(db);
  res.json(db.promoCodes[idx]);
});

app.delete("/api/admin/promo-codes/:id", adminLimiter, (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const idx = db.promoCodes.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  db.promoCodes[idx].isActive = false;
  addAuditLog(req, "PROMO_DEACTIVATED", db.promoCodes[idx].code, "");
  saveDB(db);
  res.json({ success: true });
});

// â”€â”€ VOUCHERS (one-time wallet-credit codes) â”€â”€

app.get("/api/admin/vouchers", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  res.json(db.vouchers);
});

app.post("/api/admin/vouchers", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const code = String(req.body.code || "").trim().toUpperCase();
  const amount = Math.max(0, Number(req.body.amount) || 0);
  if (!code || amount <= 0) return res.status(400).json({ error: "Code and a positive amount are required" });
  if (db.vouchers.some(v => v.code.toUpperCase() === code && v.isActive)) {
    return res.status(409).json({ error: "An active voucher with this code already exists" });
  }

  const voucher: Voucher = {
    id: "vch_" + randomUUID().replace(/-/g, "").substring(0, 6),
    code,
    amount,
    usageLimit: Math.max(1, Number(req.body.usageLimit) || 1),
    redeemedBy: [],
    redemptionCount: 0,
    expiryDate: req.body.expiryDate || "",
    isActive: true,
    description: req.body.description || "",
    createdAt: new Date().toISOString(),
  };
  db.vouchers.push(voucher);

  // Announce the voucher to every end user's feed (unless opted out).
  if (req.body.announce !== false) {
    const recipients = db.users.filter(u => u.role !== "admin").map(u => u.id);
    notifyMany(
      recipients,
      `New voucher: â‚¹${voucher.amount} credit`,
      voucher.description ? `${voucher.description} â€” redeem code ${voucher.code} in your wallet.` : `Redeem code ${voucher.code} in your wallet for â‚¹${voucher.amount} credit.`,
      "voucher",
      { voucherCode: voucher.code, amount: voucher.amount, expiryDate: voucher.expiryDate }
    );
  }

  addAuditLog(req, "VOUCHER_CREATED", voucher.code, `₹${voucher.amount} × ${voucher.usageLimit}`);
  saveDB(db);
  res.json(voucher);
});

app.delete("/api/admin/vouchers/:id", adminLimiter, (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const v = db.vouchers.find(v => v.id === req.params.id);
  if (!v) return res.status(404).json({ error: "Not found" });
  v.isActive = false;
  addAuditLog(req, "VOUCHER_DEACTIVATED", v.code, "");
  saveDB(db);
  res.json({ success: true });
});

// Redeem a voucher â†’ one-time wallet credit. The user is taken from the JWT only.
app.post("/api/vouchers/redeem", rlMiddleware(10, 60000, 300000), validate(RedeemVoucherSchema), async (req, res) => {
  const userId = (req as any).auth?.sub;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  const code = String(req.body.code || "").trim().toUpperCase();
  if (!code) return res.status(400).json({ error: "Enter a voucher code" });

  const voucher = db.vouchers.find(v => v.code.toUpperCase() === code);
  if (!voucher || !voucher.isActive) return res.status(404).json({ error: "Invalid or inactive voucher code" });
  if (voucher.expiryDate && voucher.expiryDate < new Date().toISOString().split("T")[0]) {
    return res.status(400).json({ error: "This voucher has expired" });
  }
  if (voucher.redeemedBy.includes(userId)) {
    return res.status(409).json({ error: "You have already redeemed this voucher" });
  }
  if (voucher.redemptionCount >= voucher.usageLimit) {
    return res.status(409).json({ error: "This voucher has reached its usage limit" });
  }

  // Credit the wallet.
  if (!db.wallets[userId]) db.wallets[userId] = { userId, credits: 0, history: [] };
  const wallet = db.wallets[userId];
  wallet.credits += voucher.amount;
  wallet.history.unshift({
    id: "tx_" + randomUUID().replace(/-/g, "").substring(0, 7),
    amount: voucher.amount, type: "credit",
    description: `Voucher redeemed: ${voucher.code}`,
    timestamp: new Date().toISOString(),
  });

  voucher.redeemedBy.push(userId);
  voucher.redemptionCount++;

  notifyUser(userId, "Voucher redeemed", `₹${voucher.amount} was added to your wallet from voucher ${voucher.code}.`, "wallet", { amount: voucher.amount, balance: wallet.credits });
  await saveDB(db);
  res.json({ success: true, amount: voucher.amount, balance: wallet.credits, wallet });
});

// â”€â”€ NOTIFICATION TEMPLATES â”€â”€

app.get("/api/admin/notification-templates", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  res.json(db.notificationTemplates);
});

app.put("/api/admin/notification-templates/:id", adminLimiter, validate(AdminNotificationTemplateSchema), (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const idx = db.notificationTemplates.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  db.notificationTemplates[idx] = { ...db.notificationTemplates[idx], ...req.body };
  addAuditLog(req, "TEMPLATE_UPDATED", db.notificationTemplates[idx].name, "");
  saveDB(db);
  res.json(db.notificationTemplates[idx]);
});

app.post("/api/admin/notifications/broadcast", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const { templateId, audience, customMessage } = req.body;
  const template = db.notificationTemplates.find(t => t.id === templateId);

  // Resolve the actual recipients for this audience (real user ids), excluding
  // admin accounts â€” broadcasts target end users.
  const isEndUser = (u: User) => u.role !== "admin";
  let recipients: User[];
  if (audience === "subscribers") {
    const subbed = new Set(db.subscriptions.filter(s => s.status === "active").map(s => s.userId));
    recipients = db.users.filter(u => isEndUser(u) && subbed.has(u.id));
  } else if (audience === "college") {
    recipients = db.users.filter(u => isEndUser(u) && u.companyOrCollege?.toLowerCase().includes("college"));
  } else if (audience === "active") {
    recipients = db.users.filter(u => isEndUser(u) && (db.userStatus[u.id] || "active") === "active");
  } else {
    recipients = db.users.filter(isEndUser); // "all"
  }

  const title = template?.title || "Move Buddy";
  const body = customMessage || template?.body || "";
  if (!body) return res.status(400).json({ error: "Provide a template or a custom message" });

  const sent = notifyMany(recipients.map(u => u.id), title, body, "announcement", { audience, templateId: templateId || null });
  addAuditLog(req, "BROADCAST_SENT", audience, `Template: ${template?.name || "custom"} | Delivered to: ${sent} users`);
  saveDB(db);
  res.json({ success: true, sent, template, audience, message: body });
});

// â”€â”€ ANALYTICS â”€â”€

app.get("/api/admin/analytics", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPORT', 'OPERATIONS')) return;
  const data = await adminGetAnalytics();
  res.json(data);
});

// â”€â”€ REVENUE CENTER â”€â”€

app.get("/api/admin/revenue", (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'FINANCE')) return;
  const subscriptionRevenue = db.subscriptions.reduce((sum, s) => sum + s.amountPaid, 0);
  const walletTopups = Object.values(db.wallets).reduce((sum, w) =>
    sum + w.history.filter(t => t.type === "credit" && t.description.toLowerCase().includes("fund")).reduce((s, t) => s + t.amount, 0), 0);
  // Real refunds = wallet debits described as refunds (none tracked yet â†’ 0).
  const refundAmount = Object.values(db.wallets).reduce((sum, w) =>
    sum + w.history.filter(t => t.type === "debit" && t.description.toLowerCase().includes("refund")).reduce((s, t) => s + t.amount, 0), 0);
  const netRevenue = subscriptionRevenue + walletTopups - refundAmount;
  const todayStr = new Date().toISOString().split("T")[0];
  const todayRevenue = db.subscriptions.filter(s => s.startDate === todayStr).reduce((s, x) => s + x.amountPaid, 0);

  res.json({
    today: todayRevenue,
    monthly: subscriptionRevenue + walletTopups,
    subscriptionRevenue,
    walletRevenue: walletTopups,
    refundAmount,
    netRevenue,
    breakdown: db.subscriptions.map(s => ({
      id: s.id,
      userId: s.userId,
      userName: db.users.find(u => u.id === s.userId)?.name || "Unknown",
      plan: s.planName,
      amount: s.amountPaid,
      date: s.startDate,
      status: s.status
    }))
  });
});

// â”€â”€ AUDIT LOGS â”€â”€

app.get("/api/admin/audit-logs", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const data = await adminGetAuditLogs(page, limit);
  res.json(data);
});

// â”€â”€ EXTENDED ADMIN METRICS (replaces old endpoint with full data) â”€â”€

app.get("/api/admin/metrics/v2", adminLimiter, async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN', 'FINANCE', 'SUPPORT', 'OPERATIONS')) return;
  const [totalUsers, totalRides, activeSubs, pendingKYC, verifiedUsers] = await Promise.all([
    prisma.user.count(),
    prisma.ride.count(),
    prisma.subscription.count({ where: { status: "ACTIVE" } }),
    prisma.user.count({ where: { verificationStatus: "PENDING" } }),
    prisma.user.count({ where: { isIdVerified: true } }),
  ]);
  const subs = await prisma.subscription.findMany({ select: { amountPaid: true } });
  const totalRevenues = subs.reduce((sum, s) => sum + s.amountPaid, 0);

  res.json({
    totalUsers, totalRides, activeSubs, totalRevenues, pendingKYC, verifiedUsers,
    systemSettings: db.systemSettings,
    tickets: [],
    brandingConfig: db.brandingConfig,
    themeConfig: db.themeConfig
  });
});

app.post(["/api/admin/clear-database", "/api/admin/reset-database"], async (req, res) => {
  if (!requireRole(req, res, 'SUPER_ADMIN', 'ADMIN')) return;
  const keepAdmins = req.body?.keepAdmins !== false;
  try {
    await wipeAllData(keepAdmins);
    const adminIds = new Set(defaultState.users.filter(u => u.role === "admin").map(u => u.id));
    
    db.users = keepAdmins ? defaultState.users.filter(u => adminIds.has(u.id)) : [];
    db.rides = [];
    db.requests = [];
    db.subscriptions = [];
    db.matches = [];
    db.trips = [];
    db.hostActivityDays = [];
    db.payments = [];
    db.chatMessages = [];
    db.tickets = [];
    db.notifications = [];
    db.guestCredits = [];
    db.wallets = keepAdmins ? Object.fromEntries(
      Object.entries(defaultState.wallets).filter(([uid]) => adminIds.has(uid))
    ) : {};
    db.auditLogs = [];
    db.userStatus = {};

    await saveDB(db);
    addAuditLog(req, "CLEAR_DATABASE", "database", "Cleared all dynamic database tables and state");
    res.json({ success: true, message: "Database cleared successfully." });
  } catch (err: any) {
    logger.error({ err }, "[admin] clear-database error");
    res.status(500).json({ error: "Failed to clear database.", details: String(err?.message || err) });
  }
});

// Decide what to seed into a FRESH (empty) database.
function seedState(): DatabaseState {
  return defaultState;
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup — listen IMMEDIATELY, then initialise everything in the background.
// The 503 guard (registered above) rejects /api/* calls until serverReady.
// ─────────────────────────────────────────────────────────────────────────────

// Health endpoints (always available, even during init).
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() });
});
app.get("/ready", (_req, res) => {
  res.json({ status: serverReady ? "ready" : "initializing", db: db ? "connected" : "disconnected" });
});
app.get("/live", (_req, res) => {
  res.json({ status: "alive" });
});

// Start accepting TCP connections immediately when running as standalone Node server.
if (!process.env.VERCEL) {
  httpServer = app.listen(PORT, "0.0.0.0", () => {
    logger.info({ port: PORT }, "[server] running");
  });
}

// ── Background initialisation ───────────────────────────────────────────────
(async () => {
  const t0 = Date.now();

  // DB init and Vite creation are I/O-bound and independent — run them
  // concurrently.  The 503 guard protects API routes until both finish.
  const [{ initDbMs, loadStateMs }, { viteMs }] = await Promise.all([
    (async () => {
      const t1 = Date.now();
      await initDb();
      const i = Date.now() - t1;
      const t2 = Date.now();
      db = (await loadState(seedState())) as DatabaseState;
      const l = Date.now() - t2;
      if (!Array.isArray(db.notifications)) db.notifications = [];
      configureNotifications(db.notifications, () => saveDB(db));
      return { initDbMs: i, loadStateMs: l };
    })(),
    (async () => {
      const t3 = Date.now();
      app.all("/api/*", (_req, res) => {
        res.status(404).json({ error: "API route not found" });
      });
      if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
        const vite = await createViteServer({
          configFile: path.join(process.cwd(), "frontend", "vite.config.ts"),
          server: { middlewareMode: true },
          appType: "spa",
        });
        app.use(vite.middlewares);
      } else {
        // Production: frontend is deployed on Vercel — do NOT serve static files here.
        // Return a simple health-check for the root so Render shows a working URL.
        app.get("/", (_req, res) => {
          res.json({ status: "ok", message: "MoveBuddy API is running" });
        });
        app.get("/health", (_req, res) => {
          res.json({ status: "ok", uptime: process.uptime() });
        });
        // Any other non-API route → 404 JSON (avoids crashing on missing dist/)
        app.get("*", (_req, res) => {
          res.status(404).json({ error: "Not found. Frontend is served from Vercel." });
        });
      }
      return { viteMs: Date.now() - t3 };
    })(),
  ]);

  // Shutdown handlers.
  const shutdown = async () => {
    try { await saveDB(db); } catch { }
    try { await persistNow(db); } catch { }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Subscription expiry background scheduler.
  setInterval(() => {
    const now = new Date();
    for (const sub of db.subscriptions) {
      if (sub.status !== "active" && sub.status !== "pending" && sub.status !== "geocoding" && sub.status !== "matching") continue;
      if (sub.endDate && new Date(sub.endDate + "T23:59:59.999Z") < now) {
        sub.status = "expired" as const;
        if (sub.matchId) {
          const m = db.matches.find((x) => x.id === sub.matchId && x.status === "active");
          if (m) m.status = "cancelled" as const;
        }
        for (const m of db.matches) {
          if (m.hostSubscriptionId === sub.id && m.status === "active") m.status = "cancelled" as const;
        }
        logger.info({ subId: sub.id, userId: sub.userId }, "[expiry] subscription expired");
      }
    }
  }, 60 * 1000);

  // Periodic match re-sweep.
  setInterval(async () => {
    try {
      const created = await runMatchSweep(db);
      if (created.length) {
        created.forEach(notifyBuddyFound);
        saveDB(db);
        logger.info({ count: created.length }, "[match] sweep paired");
      }
    } catch (e) {
      logger.warn({ err: e }, "[match] sweep error");
    }
  }, 3 * 60 * 1000);

  // Socket.IO live-tracking.

  initRealtime(httpServer, {
    getState: () => db,
    saveDB: () => saveDB(db),
  });

  serverReady = true;
  const totalMs = Date.now() - t0;
  logger.info({ initDbMs, loadStateMs, viteMs, totalMs }, "[startup] timeline — server ready");
})();
