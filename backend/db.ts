import fs from "fs";
import prisma, { setFallbackDb, setFallbackMode, isFallbackMode } from "./prisma";
import { logger } from "./logger";
import { encryptPii, decryptPii } from "./crypto";

const FALLBACK_DB_PATH = "./db.json";

export function dbEnabled(): boolean {
  return true;
}

export async function initDb(): Promise<void> {
  try {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    await prisma.$connect();
    logger.info("[db] Connected to PostgreSQL via Prisma.");
  } catch (e) {
    logger.warn({ err: e }, "[db] Prisma DB connection failed. Activating local file-based database fallback.");
    setFallbackMode(true);
  }
}

export async function loadState(defaults: any): Promise<any> {
  if (isFallbackMode()) {
    logger.info("[db] Fallback mode active — loading state from local file.");
    if (fs.existsSync(FALLBACK_DB_PATH)) {
      try {
        const fileData = fs.readFileSync(FALLBACK_DB_PATH, "utf8");
        const parsed = JSON.parse(fileData);
        const state = { ...defaults, ...parsed };
        setFallbackDb(state);
        logger.info("[db] Loaded state from local file db.json successfully.");
        return state;
      } catch (err) {
        logger.error({ err }, "[db] Failed to parse local db.json, using seeded defaults.");
      }
    }
    logger.info("[db] Seeding default state and writing to db.json.");
    setFallbackDb(defaults);
    try {
      fs.writeFileSync(FALLBACK_DB_PATH, JSON.stringify(defaults, null, 2), "utf8");
    } catch (err) {
      logger.error({ err }, "[db] Failed to write initial db.json.");
    }
    return defaults;
  }

  const userCount = await prisma.user.count();
  const configCount = await prisma.appConfig.count();
  if (userCount === 0 && configCount === 0) {
    logger.info("[db] Empty database — seeding default state.");
    await seedDatabase(defaults);
  }

  const state: any = { ...defaults };

  const [
    users,
    rides,
    requests,
    subscriptions,
    matches,
    trips,
    hostActivityDays,
    payments,
    chatMessages,
    tickets,
    notifications,
    guestCredits,
    wallets,
    auditLogs,
    userStatus,
    promoCodes,
    vouchers,
    cmsPages,
    subscriptionPlans,
    notificationTemplates,
    cfg,
  ] = await Promise.all([
    loadUsers(),
    prisma.ride.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.rideRequest.findMany({ orderBy: { createdAt: "desc" } }),
    loadSubscriptions(),
    prisma.match.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.trip.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.hostActivityDay.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.payment.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.chatMessage.findMany({ orderBy: { timestamp: "asc" } }),
    loadTickets(),
    loadNotifications(),
    prisma.guestCredit.findMany({ orderBy: { createdAt: "desc" } }),
    loadWallets(),
    prisma.auditLog.findMany({ orderBy: { timestamp: "desc" } }),
    loadUserStatus(),
    prisma.promoCode.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.voucher.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.cmsPage.findMany(),
    prisma.subscriptionPlan.findMany(),
    prisma.notificationTemplate.findMany(),
    loadConfig(),
  ]);

  state.users = users;
  state.rides = rides.map(fromDbRide);
  state.requests = requests.map(fromDbRideRequest);
  state.subscriptions = subscriptions;
  state.matches = matches.map(fromDbMatch);
  state.trips = trips.map(fromDbTrip);
  state.hostActivityDays = hostActivityDays;
  state.payments = payments.map(fromDbPayment);
  state.chatMessages = chatMessages;
  state.tickets = tickets;
  state.notifications = notifications;
  state.guestCredits = guestCredits;
  state.wallets = wallets;
  state.auditLogs = (auditLogs || []).map(fromDbAuditLog);
  state.userStatus = userStatus;
  state.promoCodes = promoCodes;
  state.vouchers = vouchers;
  state.cmsPages = cmsPages;
  if (subscriptionPlans.length > 0) state.subscriptionPlans = subscriptionPlans;
  state.notificationTemplates = notificationTemplates;

  if (cfg.systemSettings) state.systemSettings = { ...state.systemSettings, ...cfg.systemSettings };
  if (cfg.pricingConfig) state.pricingConfig = { ...state.pricingConfig, ...cfg.pricingConfig };
  if (cfg.themeConfig) state.themeConfig = { ...state.themeConfig, ...cfg.themeConfig };
  if (cfg.brandingConfig) state.brandingConfig = { ...state.brandingConfig, ...cfg.brandingConfig };
  if (cfg.featureFlags) state.featureFlags = { ...state.featureFlags, ...cfg.featureFlags };

  logger.info({ users: state.users.length, rides: state.rides.length }, "[db] Loaded state from PostgreSQL");
  return state;
}

function toIso(val: any): string | undefined {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string") return val;
  if (val.toISOString && typeof val.toISOString === "function") {
    try { return val.toISOString(); } catch { return String(val); }
  }
  return String(val);
}

function fromDbUser(u: any): any {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role.toLowerCase(),
    gender: u.gender.toLowerCase(),
    adminRole: u.adminRole,
    companyOrCollege: u.companyOrCollege,
    isIdVerified: u.isIdVerified,
    isCompanyVerified: u.isCompanyVerified,
    avatarUrl: u.avatarUrl,
    buddyScore: u.buddyScore,
    rating: u.rating,
    reliabilityScore: u.reliabilityScore,
    verificationStatus: u.verificationStatus?.toLowerCase() || "none",
    // PII fields are decrypted from encrypted-at-rest storage
    licenceNumber: decryptPii(u.licenceNumber),
    aadhaarNumber: decryptPii(u.aadhaarNumber),
    selfieImage: u.selfieImage,
    licenceImageUrl: u.licenceImageUrl,
    aadhaarImageUrl: u.aadhaarImageUrl,
    vehicleRcNumber: u.vehicleRcNumber,
    vehicleRcImageUrl: u.vehicleRcImageUrl,
    verificationSubmittedAt: toIso(u.verificationSubmittedAt),
    bio: u.bio,
    createdAt: toIso(u.createdAt),
  };
}

function toDbUser(u: any): any {
  if (!u) return u;
  let roleStr = String(u.role || "guest").toUpperCase();
  if (roleStr !== "GUEST" && roleStr !== "HOST" && roleStr !== "ADMIN") roleStr = "GUEST";

  let genderStr = String(u.gender || "other").toUpperCase();
  if (genderStr !== "MALE" && genderStr !== "FEMALE" && genderStr !== "OTHER") genderStr = "OTHER";

  let vStatus = String(u.verificationStatus || "none").toUpperCase();
  if (vStatus === "UNVERIFIED") vStatus = "NONE";
  if (vStatus === "APPROVED") vStatus = "VERIFIED";
  if (vStatus !== "NONE" && vStatus !== "PENDING" && vStatus !== "VERIFIED" && vStatus !== "REJECTED") vStatus = "NONE";

  let adminRoleStr = u.adminRole ? String(u.adminRole).toUpperCase() : null;
  if (adminRoleStr && !["SUPER_ADMIN", "ADMIN", "FINANCE", "SUPPORT", "OPERATIONS"].includes(adminRoleStr)) adminRoleStr = null;

  return {
    id: u.id,
    name: u.name || "User",
    email: u.email,
    phone: u.phone || null,
    role: roleStr,
    gender: genderStr,
    adminRole: adminRoleStr,
    companyOrCollege: u.companyOrCollege || null,
    isIdVerified: Boolean(u.isIdVerified),
    isCompanyVerified: Boolean(u.isCompanyVerified),
    avatarUrl: u.avatarUrl || "",
    buddyScore: Number(u.buddyScore) || 50,
    rating: Number(u.rating) || 0,
    reliabilityScore: Number(u.reliabilityScore) || 50,
    verificationStatus: vStatus,
    // PII fields are encrypted at rest
    licenceNumber: encryptPii(u.licenceNumber),
    aadhaarNumber: encryptPii(u.aadhaarNumber),
    selfieImage: u.selfieImage || null,
    licenceImageUrl: u.licenceImageUrl || null,
    aadhaarImageUrl: u.aadhaarImageUrl || null,
    vehicleRcNumber: u.vehicleRcNumber || null,
    vehicleRcImageUrl: u.vehicleRcImageUrl || null,
    verificationSubmittedAt: u.verificationSubmittedAt ? new Date(u.verificationSubmittedAt) : null,
    bio: u.bio || null,
  };
}

async function loadUsers(): Promise<any[]> {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" } });
  return users.map(fromDbUser);
}

function fromDbSub(s: any): any {
  return {
    id: s.id,
    userId: s.userId,
    planName: s.planName,
    durationDays: s.durationDays,
    startDate: s.startDate,
    endDate: s.endDate,
    amountPaid: s.amountPaid,
    planPrice: s.planPrice,
    status: s.status.toLowerCase(),
    role: s.role,
    direction: s.direction?.toLowerCase(),
    origin: s.origin,
    destination: s.destination,
    departureTime: s.departureTime,
    forwardTime: s.forwardTime,
    returnTime: s.returnTime,
    distanceKm: s.distanceKm,
    matchId: s.matchId,
    createdAt: toIso(s.createdAt),
  };
}

function toDbSub(s: any): any {
  let statusStr = String(s.status || "active").toUpperCase();
  if (statusStr !== "ACTIVE" && statusStr !== "EXPIRED" && statusStr !== "CANCELLED") {
    statusStr = "ACTIVE";
  }
  let dirStr = s.direction ? String(s.direction).toUpperCase() : null;
  if (dirStr === "EVENING") dirStr = "RETURN";
  if (dirStr === "MORNING") dirStr = "FORWARD";
  if (dirStr !== "FORWARD" && dirStr !== "RETURN") {
    dirStr = null;
  }
  return {
    id: s.id,
    userId: s.userId,
    planName: s.planName,
    durationDays: Number(s.durationDays) || 0,
    startDate: s.startDate || new Date().toISOString().split("T")[0],
    endDate: s.endDate || "",
    amountPaid: Number(s.amountPaid) || 0,
    planPrice: s.planPrice != null ? Number(s.planPrice) : null,
    status: statusStr,
    role: s.role || "guest",
    direction: dirStr,
    origin: s.origin || null,
    destination: s.destination || null,
    departureTime: s.departureTime || null,
    forwardTime: s.forwardTime || null,
    returnTime: s.returnTime || null,
    distanceKm: s.distanceKm != null ? Number(s.distanceKm) : null,
    matchId: s.matchId || null,
  };
}

function fromDbRide(r: any): any {
  if (!r) return r;
  return {
    ...r,
    vehicleType: r.vehicleType ? r.vehicleType.toLowerCase() : "bike",
    status: r.status ? r.status.toLowerCase() : undefined,
    createdAt: toIso(r.createdAt),
    updatedAt: toIso(r.updatedAt),
  };
}

function toDbRide(r: any): any {
  if (!r) return r;
  let vType = String(r.vehicleType || "bike").toUpperCase();
  if (!["CAR", "BIKE", "SCOOTER", "AUTO"].includes(vType)) vType = "BIKE";
  return {
    id: r.id,
    hostId: r.hostId,
    hostName: r.hostName || "",
    hostAvatar: r.hostAvatar || "",
    hostRating: Number(r.hostRating) || 0,
    hostBuddyScore: Number(r.hostBuddyScore) || 0,
    origin: r.origin || "",
    destination: r.destination || "",
    departureDate: r.departureDate || "",
    departureTime: r.departureTime || "",
    availableSeats: Number(r.availableSeats) || 1,
    totalSeats: Number(r.totalSeats) || 1,
    vehicleType: vType,
    vehicleModel: r.vehicleModel || "",
    vehicleNumber: r.vehicleNumber || "",
    perKmRate: Number(r.perKmRate) || 0,
    distanceKm: Number(r.distanceKm) || 0,
    totalCost: Number(r.totalCost) || 0,
    genderRestriction: r.genderRestriction || "none",
    isRecurring: Boolean(r.isRecurring),
    status: r.status ? String(r.status).toLowerCase() : "active",
    createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
    updatedAt: r.updatedAt ? new Date(r.updatedAt) : new Date(),
  };
}

function fromDbRideRequest(req: any): any {
  if (!req) return req;
  return {
    ...req,
    status: req.status ? req.status.toLowerCase() : "pending",
    createdAt: toIso(req.createdAt),
    updatedAt: toIso(req.updatedAt),
  };
}

function toDbRideRequest(req: any): any {
  if (!req) return req;
  let statusStr = String(req.status || "pending").toUpperCase();
  if (!["PENDING", "ACCEPTED", "REJECTED", "COMPLETED"].includes(statusStr)) statusStr = "PENDING";
  return {
    id: req.id,
    rideId: req.rideId,
    guestId: req.guestId,
    guestName: req.guestName || "",
    guestAvatar: req.guestAvatar || "",
    pickupLocation: req.pickupLocation || "",
    dropoffLocation: req.dropoffLocation || "",
    seatsRequested: Number(req.seatsRequested) || 1,
    status: statusStr,
    createdAt: req.createdAt ? new Date(req.createdAt) : new Date(),
    updatedAt: req.updatedAt ? new Date(req.updatedAt) : new Date(),
  };
}

function fromDbMatch(m: any): any {
  if (!m) return m;
  return {
    ...m,
    guestSubId: m.guestSubscriptionId || m.guestSubId,
    hostSubId: m.hostSubscriptionId || m.hostSubId,
    guestSubscriptionId: m.guestSubscriptionId || m.guestSubId,
    hostSubscriptionId: m.hostSubscriptionId || m.hostSubId,
    status: m.status ? m.status.toLowerCase() : "active",
    direction: m.direction ? m.direction.toLowerCase() : undefined,
    createdAt: toIso(m.createdAt),
  };
}

function toDbMatch(m: any): any {
  if (!m) return m;
  let statusStr = String(m.status || "active").toUpperCase();
  if (!["ACTIVE", "CANCELLED", "COMPLETED"].includes(statusStr)) statusStr = "ACTIVE";

  let dirStr = m.direction ? String(m.direction).toUpperCase() : "FORWARD";
  if (dirStr === "EVENING") dirStr = "RETURN";
  if (dirStr === "MORNING") dirStr = "FORWARD";
  if (dirStr !== "FORWARD" && dirStr !== "RETURN") dirStr = "FORWARD";

  return {
    id: m.id,
    guestId: m.guestId,
    guestName: m.guestName || "Guest",
    hostId: m.hostId,
    hostName: m.hostName || "Host",
    guestSubscriptionId: m.guestSubscriptionId || m.guestSubId || "",
    hostSubscriptionId: m.hostSubscriptionId || m.hostSubId || "",
    score: Number(m.score) || 0,
    direction: dirStr,
    proximityTierM: Number(m.proximityTierM) || 0,
    status: statusStr,
    createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
  };
}

function fromDbTrip(t: any): any {
  if (!t) return t;
  return {
    ...t,
    status: t.status ? t.status.toLowerCase() : "scheduled",
    direction: t.direction ? t.direction.toLowerCase() : undefined,
    createdAt: toIso(t.createdAt),
    updatedAt: toIso(t.updatedAt),
  };
}

function toDbTrip(t: any): any {
  if (!t) return t;
  let statusStr = String(t.status || "scheduled").toUpperCase();
  if (!["SCHEDULED", "PICKUP_CONFIRMED", "IN_PROGRESS", "AWAITING_CONFIRMATION", "COMPLETED", "CANCELLED"].includes(statusStr)) {
    statusStr = "SCHEDULED";
  }

  let dirStr = t.direction ? String(t.direction).toUpperCase() : "FORWARD";
  if (dirStr === "EVENING") dirStr = "RETURN";
  if (dirStr === "MORNING") dirStr = "FORWARD";
  if (dirStr !== "FORWARD" && dirStr !== "RETURN") dirStr = "FORWARD";

  return {
    id: t.id,
    matchId: t.matchId || "",
    guestId: t.guestId || "",
    hostId: t.hostId || "",
    guestName: t.guestName || "Guest",
    hostName: t.hostName || "Host",
    verificationCode: t.verificationCode || "0000",
    date: t.date || new Date().toISOString().split("T")[0],
    direction: dirStr,
    status: statusStr,
    startedAt: t.startedAt ? new Date(t.startedAt) : null,
    pickupConfirmedAt: t.pickupConfirmedAt ? new Date(t.pickupConfirmedAt) : null,
    completedAt: t.completedAt ? new Date(t.completedAt) : null,
    cancelledAt: t.cancelledAt ? new Date(t.cancelledAt) : null,
    createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
    updatedAt: t.updatedAt ? new Date(t.updatedAt) : new Date(),
  };
}

function toDbSupportTicket(t: any): any {
  if (!t) return t;
  let statusStr = String(t.status || "open").toUpperCase();
  if (!["OPEN", "RESOLVED", "APPROVED", "REJECTED"].includes(statusStr)) statusStr = "OPEN";
  return {
    id: t.id,
    userId: t.userId,
    subject: t.subject || "",
    status: statusStr,
    ticketType: t.ticketType || null,
    category: t.category || null,
    description: t.description || null,
    screenshotUrl: t.screenshotUrl || null,
    guestId: t.guestId || null,
    hostId: t.hostId || null,
    rideId: t.rideId || null,
    createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
    updatedAt: t.updatedAt ? new Date(t.updatedAt) : new Date(),
  };
}

function toDbAuditLog(a: any): any {
  if (!a) return a;
  return {
    id: a.id,
    actorId: a.actorId || a.adminId || null,
    action: String(a.action || "AUDIT"),
    targetId: a.targetId || a.target || null,
    details: a.details !== undefined && a.details !== null
      ? (typeof a.details === 'object' ? a.details : { details: String(a.details), adminName: a.adminName })
      : (a.adminName ? { adminName: a.adminName } : null),
    timestamp: a.timestamp ? new Date(a.timestamp) : new Date(),
  };
}

function fromDbAuditLog(a: any): any {
  if (!a) return a;
  const detailsObj = typeof a.details === "object" && a.details ? a.details : {};
  return {
    id: a.id,
    adminId: a.actorId || detailsObj.adminId || "admin",
    adminName: detailsObj.adminName || "Admin",
    action: a.action,
    target: a.targetId || detailsObj.target || "",
    details: detailsObj.details || (typeof a.details === "string" ? a.details : ""),
    timestamp: toIso(a.timestamp),
  };
}

function toDbChatMessage(m: any): any {
  if (!m) return m;
  return {
    id: m.id,
    senderId: m.senderId,
    senderName: m.senderName || "",
    receiverId: m.receiverId,
    text: m.text || "",
    timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
    rideId: m.rideId || null,
  };
}

function toDbHostActivityDay(h: any): any {
  if (!h) return h;
  return {
    id: h.id,
    hostId: h.hostId,
    date: String(h.date || ""),
    morningActive: h.morningActive ?? true,
    eveningActive: h.eveningActive ?? true,
    createdAt: h.createdAt ? new Date(h.createdAt) : undefined,
    updatedAt: h.updatedAt ? new Date(h.updatedAt) : undefined,
  };
}

function toDbGuestCredit(c: any): any {
  if (!c) return c;
  return {
    id: c.id,
    userId: c.userId,
    creditType: c.creditType || "system",
    amount: Number(c.amount) || 0,
    sourceSubscriptionId: c.sourceSubscriptionId || "",
    appliedToSubscriptionId: c.appliedToSubscriptionId || null,
    createdAt: c.createdAt ? new Date(c.createdAt) : undefined,
  };
}

function toDbPromoCode(p: any): any {
  if (!p) return p;
  return {
    id: p.id,
    code: p.code,
    discountPercent: Number(p.discountPercent) || 0,
    usageLimit: Number(p.usageLimit) || 0,
    usedCount: Number(p.usedCount) || 0,
    expiryDate: String(p.expiryDate || ""),
    isActive: p.isActive ?? true,
    description: String(p.description || ""),
    createdAt: p.createdAt ? new Date(p.createdAt) : undefined,
    updatedAt: p.updatedAt ? new Date(p.updatedAt) : undefined,
  };
}

function toDbVoucher(v: any): any {
  if (!v) return v;
  return {
    id: v.id,
    code: v.code,
    amount: Number(v.amount) || 0,
    usageLimit: Number(v.usageLimit) || 1,
    redemptionCount: Number(v.redemptionCount) || 0,
    redeemedBy: Array.isArray(v.redeemedBy) ? v.redeemedBy : [],
    expiryDate: String(v.expiryDate || ""),
    isActive: v.isActive ?? true,
    description: String(v.description || ""),
    createdAt: v.createdAt ? new Date(v.createdAt) : undefined,
    updatedAt: v.updatedAt ? new Date(v.updatedAt) : undefined,
  };
}

function toDbCmsPage(c: any): any {
  if (!c) return c;
  return {
    id: c.id,
    slug: c.slug,
    title: c.title || "",
    content: c.content || "",
    createdAt: c.createdAt ? new Date(c.createdAt) : undefined,
    updatedAt: c.updatedAt ? new Date(c.updatedAt) : undefined,
  };
}

function toDbSubscriptionPlan(p: any): any {
  if (!p) return p;
  let rawPt = String(p.planType || "").toLowerCase();
  let pt = "PLAN_1M";
  if (rawPt.includes("7") || rawPt.includes("week")) pt = "PLAN_7D";
  else if (rawPt.includes("15")) pt = "PLAN_15D";
  else if (rawPt.includes("1m") || rawPt.includes("month") || rawPt.includes("30")) pt = "PLAN_1M";

  return {
    id: p.id,
    role: p.role || "guest",
    planType: pt,
    name: p.name || "Plan",
    durationDays: Number(p.durationDays) || 30,
    multiplier: p.multiplier !== undefined && p.multiplier !== null ? Number(p.multiplier) : null,
    basePrice: p.basePrice !== undefined && p.basePrice !== null ? Number(p.basePrice) : null,
    isActive: p.isActive ?? true,
    badge: String(p.badge || ""),
    features: Array.isArray(p.features) ? p.features : [],
    createdAt: p.createdAt ? new Date(p.createdAt) : undefined,
    updatedAt: p.updatedAt ? new Date(p.updatedAt) : undefined,
  };
}

function toDbNotificationTemplate(t: any): any {
  if (!t) return t;
  let ch = String(t.channel || "PUSH").toUpperCase();
  if (!["PUSH", "EMAIL", "SMS", "IN_APP", "WHATSAPP"].includes(ch)) ch = "PUSH";
  return {
    id: t.id,
    name: t.name || "",
    title: t.title || "",
    body: t.body || "",
    channel: ch,
    isActive: t.isActive ?? true,
    createdAt: t.createdAt ? new Date(t.createdAt) : undefined,
    updatedAt: t.updatedAt ? new Date(t.updatedAt) : undefined,
  };
}

async function loadSubscriptions(): Promise<any[]> {
  const subs = await prisma.subscription.findMany({ orderBy: { createdAt: "desc" } });
  return subs.map(fromDbSub);
}

async function loadTickets(): Promise<any[]> {
  const tickets = await prisma.supportTicket.findMany({ orderBy: { createdAt: "desc" } });
  return tickets.map((t: any) => ({
    id: t.id,
    userId: t.userId,
    subject: t.subject,
    status: t.status.toLowerCase(),
    ticketType: t.ticketType,
    category: t.category,
    description: t.description,
    screenshotUrl: t.screenshotUrl,
    guestId: t.guestId,
    hostId: t.hostId,
    rideId: t.rideId,
    createdAt: toIso(t.createdAt),
    messages: [],
  }));
}

async function loadNotifications(): Promise<any[]> {
  const notifications = await prisma.notification.findMany({ orderBy: { createdAt: "desc" } });
  return notifications.map((n: any) => ({
    id: n.id,
    userId: n.userId,
    title: n.title,
    body: n.body,
    type: n.type,
    read: n.read,
    meta: n.meta,
    createdAt: toIso(n.createdAt),
  }));
}

async function loadWallets(): Promise<Record<string, any>> {
  const [wallets, txns] = await Promise.all([
    prisma.wallet.findMany(),
    prisma.walletTransaction.findMany({ orderBy: { timestamp: "desc" } }),
  ]);
  const txnsByWallet = new Map<string, any[]>();
  for (const t of txns) {
    if (!txnsByWallet.has(t.walletId)) txnsByWallet.set(t.walletId, []);
    txnsByWallet.get(t.walletId)!.push(t);
  }
  const result: Record<string, any> = {};
  for (const w of wallets) {
    const history = (txnsByWallet.get(w.userId) || []).map((t: any) => ({
      id: t.id,
      amount: t.amount,
      type: t.type,
      description: t.description,
      timestamp: toIso(t.timestamp),
    }));
    result[w.userId] = {
      userId: w.userId,
      credits: w.credits,
      history,
    };
  }
  return result;
}

function loadUserStatus(): Record<string, string> {
  return {};
}

async function loadConfig(): Promise<Record<string, any>> {
  const rows = await prisma.appConfig.findMany();
  const result: Record<string, any> = {};
  for (const row of rows) {
    try { result[row.key] = typeof row.data === "object" ? row.data : JSON.parse(row.data as string); }
    catch { result[row.key] = row.data; }
  }
  return result;
}

export async function persistNow(state: any): Promise<void> {
  try {
    await persistAll(state);
  } catch (e) {
    logger.error({ err: e }, "[db] persist error");
  }
}

export function saveState(state: any): Promise<void> {
  return persistAll(state).catch((e) => logger.error({ err: e }, "[db] persist error"));
}

async function persistAll(state: any): Promise<void> {
  if (!state) return;

  if (isFallbackMode()) {
    try {
      setFallbackDb(state);
      fs.writeFileSync(FALLBACK_DB_PATH, JSON.stringify(state, null, 2), "utf8");
    } catch (err) {
      logger.error({ err }, "[db] Fallback save failed");
    }
    return;
  }

  console.log("DBP1: persistAll start");
  console.log("DBP2: persisting users");
  await safeUpsert(prisma.user, (state.users || []).map(toDbUser), "id");
  console.log("DBP3: persisting rides");
  await safeUpsert(prisma.ride, (state.rides || []).map(toDbRide), "id");
  console.log("DBP4: persisting rideRequests");
  await safeUpsert(prisma.rideRequest, (state.requests || []).map(toDbRideRequest), "id");
  console.log("DBP5: persisting subscriptions");
  await safeUpsert(prisma.subscription, (state.subscriptions || []).map(toDbSub), "id");
  console.log("DBP6: persisting matches");
  await safeUpsert(prisma.match, (state.matches || []).map(toDbMatch), "id");
  console.log("DBP7: persisting trips");
  await safeUpsert(prisma.trip, (state.trips || []).map(toDbTrip), "id");
  console.log("DBP8: persisting hostActivityDays");
  await safeUpsert(prisma.hostActivityDay, (state.hostActivityDays || []).map(toDbHostActivityDay), "id");
  console.log("DBP9: persisting payments");
  await safeUpsert(prisma.payment, (state.payments || []).map(toDbPayment), "id");
  console.log("DBP10: persisting chatMessages");
  await safeUpsert(prisma.chatMessage, (state.chatMessages || []).map(toDbChatMessage), "id");
  console.log("DBP11: persisting supportTickets");
  await safeUpsert(prisma.supportTicket, (state.tickets || []).map(toDbSupportTicket), "id");
  console.log("DBP12: persisting guestCredits");
  await safeUpsert(prisma.guestCredit, (state.guestCredits || []).map(toDbGuestCredit), "id");
  console.log("DBP13: persisting auditLogs");
  await safeUpsert(prisma.auditLog, (state.auditLogs || []).map(toDbAuditLog), "id");
  console.log("DBP14: persisting promoCodes");
  await safeUpsert(prisma.promoCode, (state.promoCodes || []).map(toDbPromoCode), "id");
  console.log("DBP15: persisting vouchers");
  await safeUpsert(prisma.voucher, (state.vouchers || []).map(toDbVoucher), "id");
  console.log("DBP16: persisting cmsPages");
  await safeUpsert(prisma.cmsPage, (state.cmsPages || []).map(toDbCmsPage), "id");
  console.log("DBP17: persisting subscriptionPlans");
  await safeUpsert(prisma.subscriptionPlan, (state.subscriptionPlans || []).map(toDbSubscriptionPlan), "id");
  console.log("DBP18: persisting notificationTemplates");
  await safeUpsert(prisma.notificationTemplate, (state.notificationTemplates || []).map(toDbNotificationTemplate), "id");

  console.log("DBP19: persisting notifications");
  await persistNotifications(state.notifications);
  console.log("DBP20: persisting wallets");
  await persistWallets(state.wallets);
  console.log("DBP21: persisting config");
  await persistConfig(state);
  console.log("DBP22: persistAll end");
}

// The Prisma column is `notes` (Json) and `status` is a DB enum (UPPERCASE);
// in-memory payments use lowercase status, like the API layer.
export function fromDbPayment(p: any): any {
  if (!p) return p;
  const { updatedAt, ...rest } = p;
  return {
    ...rest,
    status: String(p.status || "created").toLowerCase(),
    notes: p.notes || undefined,
    createdAt: toIso(p.createdAt),
  };
}

export function toDbPayment(p: any): any {
  if (!p) return p;
  const { updatedAt, ...rest } = p;
  let statusStr = String(p.status || "created").toUpperCase();
  if (statusStr !== "SUCCESS" && statusStr !== "FAILED") {
    statusStr = "CREATED";
  }
  return {
    ...rest,
    status: statusStr,
    notes: p.notes || undefined,
    createdAt: p.createdAt ? new Date(p.createdAt) : undefined,
  };
}

async function safeUpsert(model: any, items: any[], key: string): Promise<void> {
  if (!items || items.length === 0) return;
  let failed = 0;
  let firstError: unknown = null;
  const chunkSize = 10;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    await Promise.all(
      chunk.map(async (item) => {
        if (!item || item[key] == null) return;
        try {
          await model.upsert({
            where: { [key]: item[key] },
            create: item,
            update: item,
          });
        } catch (e) {
          failed++;
          if (!firstError) firstError = e;
        }
      })
    );
  }
  if (failed > 0) {
    logger.error(
      { err: firstError, failed, total: items.length },
      "[db] safeUpsert: rows failed to persist"
    );
  }
}

async function persistNotifications(notifications: any[]): Promise<void> {
  if (!notifications || notifications.length === 0) return;
  for (const n of notifications) {
    try {
      await prisma.notification.upsert({
        where: { id: n.id },
        create: {
          id: n.id,
          userId: n.userId,
          title: n.title,
          body: n.body,
          type: n.type || "system",
          read: n.read || false,
          meta: n.meta || undefined,
          channel: "PUSH",
        },
        update: {
          read: n.read || false,
        },
      });
    } catch {}
  }
}

async function persistWallets(wallets: Record<string, any>): Promise<void> {
  if (!wallets) return;
  for (const [userId, w] of Object.entries(wallets)) {
    const wallet = w as any;
    try {
      await prisma.wallet.upsert({
        where: { userId },
        create: { userId, credits: wallet.credits || 0 },
        update: { credits: wallet.credits || 0 },
      });
      if (wallet.history) {
        for (const txn of wallet.history) {
          try {
            await prisma.walletTransaction.upsert({
              where: { id: txn.id },
              create: {
                id: txn.id,
                walletId: userId,
                amount: txn.amount || 0,
                type: txn.type || "credit",
                description: txn.description || "",
                timestamp: txn.timestamp ? new Date(txn.timestamp) : new Date(),
              },
              update: {
                amount: txn.amount || 0,
                type: txn.type || "credit",
                description: txn.description || "",
              },
            });
          } catch {}
        }
      }
    } catch {}
  }
}

async function persistConfig(state: any): Promise<void> {
  const configKeys = ["systemSettings", "pricingConfig", "themeConfig", "brandingConfig", "featureFlags", "tripValidationConfig"];
  for (const key of configKeys) {
    if (state[key] === undefined) continue;
    try {
      await prisma.appConfig.upsert({
        where: { key },
        create: { key, data: state[key] as any },
        update: { data: state[key] as any },
      });
    } catch {}
  }
}

async function seedDatabase(defaults: any): Promise<void> {
  if (defaults.users?.length) {
    await safeUpsert(prisma.user, defaults.users.map(toDbUser), "id");
  }
  if (defaults.rides?.length) await safeUpsert(prisma.ride, defaults.rides.map(toDbRide), "id");
  if (defaults.requests?.length) await safeUpsert(prisma.rideRequest, defaults.requests.map(toDbRideRequest), "id");
  if (defaults.subscriptions?.length) await safeUpsert(prisma.subscription, defaults.subscriptions.map(toDbSub), "id");
  if (defaults.matches?.length) await safeUpsert(prisma.match, defaults.matches.map(toDbMatch), "id");
  if (defaults.trips?.length) await safeUpsert(prisma.trip, defaults.trips.map(toDbTrip), "id");
  if (defaults.hostActivityDays?.length) await safeUpsert(prisma.hostActivityDay, defaults.hostActivityDays.map(toDbHostActivityDay), "id");
  if (defaults.payments?.length) await safeUpsert(prisma.payment, defaults.payments.map(toDbPayment), "id");
  if (defaults.chatMessages?.length) await safeUpsert(prisma.chatMessage, defaults.chatMessages.map(toDbChatMessage), "id");
  if (defaults.tickets?.length) await safeUpsert(prisma.supportTicket, defaults.tickets.map(toDbSupportTicket), "id");
  if (defaults.notifications?.length) await persistNotifications(defaults.notifications);
  if (defaults.wallets) await persistWallets(defaults.wallets);
  if (defaults.auditLogs?.length) await safeUpsert(prisma.auditLog, defaults.auditLogs.map(toDbAuditLog), "id");
  if (defaults.promoCodes?.length) await safeUpsert(prisma.promoCode, defaults.promoCodes.map(toDbPromoCode), "id");
  if (defaults.vouchers?.length) await safeUpsert(prisma.voucher, defaults.vouchers.map(toDbVoucher), "id");
  if (defaults.cmsPages?.length) await safeUpsert(prisma.cmsPage, defaults.cmsPages.map(toDbCmsPage), "id");
  if (defaults.subscriptionPlans?.length) await safeUpsert(prisma.subscriptionPlan, defaults.subscriptionPlans.map(toDbSubscriptionPlan), "id");
  if (defaults.notificationTemplates?.length) await safeUpsert(prisma.notificationTemplate, defaults.notificationTemplates.map(toDbNotificationTemplate), "id");
  await persistConfig(defaults);
}

export async function wipeAllData(keepAdmins: boolean = true): Promise<void> {
  if (isFallbackMode()) {
    try {
      if (fs.existsSync(FALLBACK_DB_PATH)) {
        fs.unlinkSync(FALLBACK_DB_PATH);
      }
    } catch (err) {
      logger.error({ err }, "[db] Error removing fallback db file");
    }
    return;
  }

  try {
    await prisma.trip.deleteMany({});
    await prisma.match.deleteMany({});
    await prisma.subscription.deleteMany({});
    await prisma.rideRequest.deleteMany({});
    await prisma.ride.deleteMany({});
    await prisma.hostActivityDay.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.chatMessage.deleteMany({});
    await prisma.supportTicket.deleteMany({});
    await prisma.guestCredit.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.walletTransaction.deleteMany({});
    await prisma.wallet.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.vehicle.deleteMany({});

    if (keepAdmins) {
      await prisma.user.deleteMany({
        where: { role: { not: "ADMIN" } }
      });
    } else {
      await prisma.user.deleteMany({});
    }
    logger.info("[db] Cleared database records successfully.");
  } catch (err) {
    logger.error({ err }, "[db] Error clearing database tables");
  }
}
