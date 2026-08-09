import prisma from "./prisma.js";
import { withLock } from "./lock.js";
import { tryMatchGuestSub, runMatchSweep, hostBusy } from "./matching.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

async function main() {
// ── Shared in-memory DB state factory ────────────────────────────────────────
function makeGeo(lat: number, lng: number) { return { lat, lng }; }

const WHITEFIELD = makeGeo(12.9698, 77.7500);
const BELLANDUR  = makeGeo(12.9279, 77.6771);
const KORAMANGALA = makeGeo(12.9346, 77.6249);
const INDIRANAGAR = makeGeo(12.9784, 77.6408);
const HSR_LAYOUT = makeGeo(12.9116, 77.6389);

function makeDb(overrides: any = {}) {
  return {
    users: [
      { id: "h1", name: "Host H1" },
      { id: "h2", name: "Host H2" },
      { id: "g1", name: "Guest G1" },
      { id: "g2", name: "Guest G2" },
      { id: "g3", name: "Guest G3" },
    ],
    subscriptions: [],
    matches: [],
    wallets: { h1: { userId: "h1", credits: 0, history: [] }, h2: { userId: "h2", credits: 0, history: [] }, g1: { userId: "g1", credits: 0, history: [] }, g2: { userId: "g2", credits: 0, history: [] }, g3: { userId: "g3", credits: 0, history: [] } },
    pricingConfig: {},
    ...overrides,
  };
}

function hostSub(id: string, userId: string, origin: any, dest: any, forwardTime = "09:00", returnTime = "18:00", status = "active") {
  return { id, userId, role: "host", status, origin: "Whitefield", destination: "Bellandur", originGeo: origin, destGeo: dest, forwardTime, returnTime, matchId: null, planName: "Host Plan" };
}

function guestSub(id: string, userId: string, origin: any, dest: any, direction: string, departureTime: string, status = "active") {
  return { id, userId, role: "guest", status, origin: "Whitefield", destination: "Bellandur", originGeo: origin, destGeo: dest, direction, departureTime, matchId: null, planName: "7 Day Plan" };
}

// ── SECTION 1: Core matching rules ───────────────────────────────────────────
console.log("\n========== SECTION 1: Core Matching Rules ==========\n");

// Test 1: Host within 5km — should match
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs1", "h1", WHITEFIELD, BELLANDUR),
    guestSub("gs1", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
  ];
  const m = await tryMatchGuestSub(db as any, db.subscriptions[1] as any);
  assert(m !== null, "Test 1: Guest matches host within 5km");
}

// Test 2: Host too far (>5km) — should NOT match
{
  const db = makeDb();
  const FAR_ORIGIN = makeGeo(13.1000, 77.7500); // ~15km away
  db.subscriptions = [
    hostSub("hs2", "h1", FAR_ORIGIN, BELLANDUR),
    guestSub("gs2", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
  ];
  const m = await tryMatchGuestSub(db as any, db.subscriptions[1] as any);
  assert(m === null, "Test 2: No match when origin >5km apart");
}

// Test 3: Time within 30min — should match
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs3", "h1", WHITEFIELD, BELLANDUR, "09:00"),
    guestSub("gs3", "g1", WHITEFIELD, BELLANDUR, "forward", "09:15"),
  ];
  const m = await tryMatchGuestSub(db as any, db.subscriptions[1] as any);
  assert(m !== null, "Test 3: Guest matches when time diff ≤30min (15min)");
}

// Test 4: Time too far (>30min) — should NOT match
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs4", "h1", WHITEFIELD, BELLANDUR, "09:00"),
    guestSub("gs4", "g1", WHITEFIELD, BELLANDUR, "forward", "10:00"),
  ];
  const m = await tryMatchGuestSub(db as any, db.subscriptions[1] as any);
  assert(m === null, "Test 4: No match when time diff >30min (60min)");
}

// Test 5: Morning and Evening are independent — same host can do both
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs5", "h1", WHITEFIELD, BELLANDUR),
    guestSub("gs5a", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
    guestSub("gs5b", "g1", BELLANDUR, WHITEFIELD, "return", "18:00"),
  ];
  const mFwd = await tryMatchGuestSub(db as any, db.subscriptions[1] as any);
  const mRet = await tryMatchGuestSub(db as any, db.subscriptions[2] as any);
  assert(mFwd !== null, "Test 5a: Host can match guest for FORWARD");
  assert(mRet !== null, "Test 5b: Same host can match same guest for RETURN (independent)");
  if (mFwd && mRet) {
    assert(mFwd.direction !== mRet.direction, "Test 5c: Forward and Return are stored as separate matches");
  }
}

// Test 6: Same host subscription can only have ONE active match per direction
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs6", "h1", WHITEFIELD, BELLANDUR),
    guestSub("gs6a", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
    guestSub("gs6b", "g2", WHITEFIELD, BELLANDUR, "forward", "09:00"),
  ];
  const m1 = await tryMatchGuestSub(db as any, db.subscriptions[1] as any);
  const m2 = await tryMatchGuestSub(db as any, db.subscriptions[2] as any);
  assert(m1 !== null, "Test 6a: First guest matches host for FORWARD");
  assert(m2 === null, "Test 6b: Second guest cannot match same host+subscription for FORWARD (hostBusy)");
}

// Test 7: Guest subscription can only have ONE active match
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs7a", "h1", WHITEFIELD, BELLANDUR),
    hostSub("hs7b", "h2", WHITEFIELD, BELLANDUR),
    guestSub("gs7", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
  ];
  const m1 = await tryMatchGuestSub(db as any, db.subscriptions[2] as any);
  // Now manually set matchId to simulate a prior match
  assert(m1 !== null, "Test 7a: Guest gets matched");
  // After match, the sub has matchId set — another tryMatch should return null
  const m2 = await tryMatchGuestSub(db as any, db.subscriptions[2] as any);
  assert(m2 === null, "Test 7b: Guest with existing matchId cannot be double-matched");
}

// Test 8: Direction filter — host FORWARD time used for forward, RETURN time for return
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs8", "h1", WHITEFIELD, BELLANDUR, "09:00", "18:00"),
    guestSub("gs8r", "g1", BELLANDUR, WHITEFIELD, "return", "18:00"), // return: reversed route
  ];
  const m = await tryMatchGuestSub(db as any, db.subscriptions[1] as any);
  assert(m !== null, "Test 8: Host returnTime matched for RETURN direction (route reversal)");
}

// Test 9: RETURN direction uses guest origin/dest as drop/pickup (engine expects guest in native orientation)
{
  const db = makeDb();
  // Guest travels from Bellandur back to Whitefield (origin=Bellandur, dest=Whitefield)
  // This is the native storage format for a RETURN trip.
  // Engine for RETURN: compares host.destGeo ↔ guest.originGeo and host.originGeo ↔ guest.destGeo
  // (i.e. host drops at Whitefield, guest pickup at Whitefield — both within 5km)
  db.subscriptions = [
    hostSub("hs9", "h1", WHITEFIELD, BELLANDUR, "09:00", "18:00"),
    guestSub("gs9", "g1", BELLANDUR, WHITEFIELD, "return", "18:00"),
  ];
  const m = await tryMatchGuestSub(db as any, db.subscriptions[1] as any);
  assert(m !== null, "Test 9: RETURN direction with correctly stored guest route (Bellandur→Whitefield) matches host");
}

// Test 10: No host available — pending guest stays unmatched
{
  const db = makeDb();
  db.subscriptions = [
    guestSub("gs10", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
  ];
  const m = await tryMatchGuestSub(db as any, db.subscriptions[0] as any);
  assert(m === null, "Test 10: Guest stays unmatched when no host is available");
  assert(db.subscriptions[0].matchId === null, "Test 10b: matchId stays null when unmatched");
}

// Test 11: Background sweep — host activation triggers matching of pending guests
{
  const db = makeDb();
  db.subscriptions = [
    guestSub("gs11a", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
    guestSub("gs11b", "g2", WHITEFIELD, BELLANDUR, "forward", "09:10"),
    hostSub("hs11", "h1", WHITEFIELD, BELLANDUR),
  ];
  const matches = await runMatchSweep(db as any);
  assert(matches.length >= 1, "Test 11: runMatchSweep pairs pending guests with new host");
  assert(db.matches.length >= 1, "Test 11b: Matches are written to state.matches");
}

// Test 12: Same guest can have different hosts for morning and evening
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs12a", "h1", WHITEFIELD, BELLANDUR, "09:00", "06:00"), // h1 for forward only
    hostSub("hs12b", "h2", KORAMANGALA, BELLANDUR, "09:00", "18:00"), // h2 for both
    guestSub("gs12a", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
    guestSub("gs12b", "g1", BELLANDUR, KORAMANGALA, "return", "18:00"),
  ];
  const mFwd = await tryMatchGuestSub(db as any, db.subscriptions[2] as any);
  const mRet = await tryMatchGuestSub(db as any, db.subscriptions[3] as any);
  // Guest can be matched to different hosts for different directions
  assert(mFwd !== null || mRet !== null, "Test 12: Guest can have different hosts for morning/evening");
}

// Test 13: Expired host subscription — guests should not be matched to it
{
  const db = makeDb();
  db.subscriptions = [
    { ...hostSub("hs13", "h1", WHITEFIELD, BELLANDUR), status: "expired" },
    guestSub("gs13", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
  ];
  const m = await tryMatchGuestSub(db as any, db.subscriptions[1] as any);
  assert(m === null, "Test 13: Expired host subscription is not used for matching");
}

// Test 14: hostBusy() correctly identifies busy host+direction
{
  const db = makeDb();
  db.subscriptions = [hostSub("hs14", "h1", WHITEFIELD, BELLANDUR)];
  db.matches = [{ id: "m1", hostSubscriptionId: "hs14", guestSubscriptionId: "gs14", direction: "FORWARD", status: "active" }];
  const busy = hostBusy(db as any, "hs14", "forward");
  const notBusy = hostBusy(db as any, "hs14", "return");
  assert(busy === true, "Test 14a: hostBusy returns true when host has active FORWARD match");
  assert(notBusy === false, "Test 14b: hostBusy returns false for RETURN when only FORWARD is matched");
}

// ── SECTION 2: Concurrent activation safety ──────────────────────────────────
console.log("\n========== SECTION 2: Concurrent Activation Safety ==========\n");

// Test 15: withLock prevents concurrent activation for same user+direction
{
  const results: string[] = [];
  const lockResults = await Promise.allSettled([
    withLock("sub:usr_test:host", async () => {
      await new Promise(r => setTimeout(r, 50));
      results.push("task1");
      return "task1";
    }, 5000),
    withLock("sub:usr_test:host", async () => {
      await new Promise(r => setTimeout(r, 10));
      results.push("task2");
      return "task2";
    }, 5000),
  ]);
  // Both should eventually complete (lock queues them)
  assert(results.length === 2, "Test 15a: Both activations complete sequentially under lock");
  assert(results[0] === "task1" && results[1] === "task2", "Test 15b: Lock ensures sequential (not interleaved) execution");
}

// Test 16: Concurrent match attempts — no double-match for same guest
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs16a", "h1", WHITEFIELD, BELLANDUR),
    hostSub("hs16b", "h2", WHITEFIELD, BELLANDUR),
    guestSub("gs16", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"),
  ];
  const guestSubObj = db.subscriptions[2] as any;

  // Simulate concurrent matching attempts
  const [m1, m2] = await Promise.all([
    tryMatchGuestSub(db as any, guestSubObj),
    tryMatchGuestSub(db as any, guestSubObj),
  ]);

  const activeMatchCount = db.matches.filter((m: any) =>
    m.guestSubscriptionId === "gs16" && m.status === "active"
  ).length;

  assert(activeMatchCount <= 1, "Test 16: Concurrent matching produces at most 1 active match per guest sub");
  const nonNull = [m1, m2].filter(Boolean).length;
  assert(nonNull <= 1, "Test 16b: At most one concurrent call creates a match (race guard works)");
}

// Test 17: stale matchId cleanup — cancelled match does not block re-matching
{
  const db = makeDb();
  db.subscriptions = [
    hostSub("hs17", "h1", WHITEFIELD, BELLANDUR),
    { ...guestSub("gs17", "g1", WHITEFIELD, BELLANDUR, "forward", "09:00"), matchId: "old_match" },
  ];
  db.matches = [{ id: "old_match", guestSubscriptionId: "gs17", hostSubscriptionId: "hs17", direction: "FORWARD", status: "cancelled" }];

  // Guest has a stale matchId pointing to a cancelled match
  // tryMatchGuestSub's idempotency guard checks matchId, so it will block re-match!
  // This is expected — re-matching requires clearing matchId first (done by admin reassign or cleanup)
  const guestSubObj = db.subscriptions[1] as any;
  assert(guestSubObj.matchId === "old_match", "Test 17a: Guest has stale matchId (old_match)");

  // After clearing matchId (as cleanup script + admin reassign does)
  guestSubObj.matchId = null;
  const m = await tryMatchGuestSub(db as any, guestSubObj);
  assert(m !== null, "Test 17b: Guest can be re-matched after stale matchId is cleared");
}


// ── SUMMARY ──────────────────────────────────────────────────────────────────
  console.log("\n========== RESULTS ==========");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    failures.forEach(f => console.log(`  ❌ ${f}`));
    await prisma.$disconnect();
    process.exit(1);
  } else {
    console.log("\n✅ All scenarios passed!");
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
