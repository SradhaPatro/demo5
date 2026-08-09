import { findBuddyForGuest, tryMatchGuestSub, runMatchSweep, MatchableState } from "./matching";
import type { Subscription, User, Match } from "../src/types";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error("❌ FAILED:", msg);
    process.exit(1);
  }
  console.log("✓ PASSED:", msg);
}

async function runTests() {
  console.log("==========================================");
  console.log("Testing Guest/Host Independent Match Scenarios");
  console.log("==========================================\n");

  const guestUser: User = {
    id: "user_guest", name: "Guest User", email: "guest@example.com", phone: "1234567890",
    role: "guest", gender: "male", isIdVerified: true, isCompanyVerified: true,
    avatarUrl: "", buddyScore: 80, rating: 4.8
  };

  const host1User: User = {
    id: "user_host1", name: "Host One", email: "host1@example.com", phone: "1234567891",
    role: "host", gender: "male", isIdVerified: true, isCompanyVerified: true,
    avatarUrl: "", buddyScore: 85, rating: 4.9
  };

  const host2User: User = {
    id: "user_host2", name: "Host Two", email: "host2@example.com", phone: "1234567892",
    role: "host", gender: "male", isIdVerified: true, isCompanyVerified: true,
    avatarUrl: "", buddyScore: 82, rating: 4.7
  };

  const baseOrigin = "Koramangala, Bengaluru";
  const baseDest = "Indiranagar, Bengaluru";
  const originGeo = { lat: 12.9352, lng: 77.6245 };
  const destGeo = { lat: 12.9784, lng: 77.6408 };

  // --------------------------------------------------------------------------
  // TEST 1: Same Host matches both morning and evening
  // --------------------------------------------------------------------------
  console.log("Scenario 1: Same Host matches both morning and evening");
  {
    const guestMorningSub: Subscription = {
      id: "sub_g_m1", userId: guestUser.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: baseOrigin, destination: baseDest,
      originGeo, destGeo, departureTime: "09:00", matchId: null
    };

    const guestEveningSub: Subscription = {
      id: "sub_g_e1", userId: guestUser.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: baseDest, destination: baseOrigin,
      originGeo: destGeo, destGeo: originGeo, departureTime: "18:00", matchId: null
    };

    const host1Sub: Subscription = {
      id: "sub_h1", userId: host1User.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: baseOrigin, destination: baseDest,
      originGeo, destGeo, forwardTime: "09:00", returnTime: "18:00", matchId: null
    };

    const state: MatchableState = {
      users: [guestUser, host1User],
      subscriptions: [guestMorningSub, guestEveningSub, host1Sub],
      matches: []
    };

    const created = await runMatchSweep(state);
    assert(created.length === 2, "Created 2 matches for morning and evening");
    assert(guestMorningSub.matchId !== null, "Morning sub is matched");
    assert(guestEveningSub.matchId !== null, "Evening sub is matched");

    const morningMatch = state.matches.find(m => m.guestSubscriptionId === guestMorningSub.id);
    const eveningMatch = state.matches.find(m => m.guestSubscriptionId === guestEveningSub.id);

    assert(morningMatch?.hostId === host1User.id, "Morning matched to Host 1");
    assert(eveningMatch?.hostId === host1User.id, "Evening matched to Host 1");
  }
  console.log("------------------------------------------\n");

  // --------------------------------------------------------------------------
  // TEST 2: Host 1 matches morning and Host 2 matches evening
  // --------------------------------------------------------------------------
  console.log("Scenario 2: Host 1 matches morning and Host 2 matches evening");
  {
    const guestMorningSub: Subscription = {
      id: "sub_g_m2", userId: guestUser.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: baseOrigin, destination: baseDest,
      originGeo, destGeo, departureTime: "09:00", matchId: null
    };

    const guestEveningSub: Subscription = {
      id: "sub_g_e2", userId: guestUser.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: baseDest, destination: baseOrigin,
      originGeo: destGeo, destGeo: originGeo, departureTime: "18:00", matchId: null
    };

    // Host 1 available at 09:00 morning, but 22:00 evening (not matching 18:00)
    const host1Sub: Subscription = {
      id: "sub_h1_t2", userId: host1User.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: baseOrigin, destination: baseDest,
      originGeo, destGeo, forwardTime: "09:00", returnTime: "22:00", matchId: null
    };

    // Host 2 available at 06:00 morning (not matching 09:00), but 18:00 evening
    const host2Sub: Subscription = {
      id: "sub_h2_t2", userId: host2User.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: baseOrigin, destination: baseDest,
      originGeo, destGeo, forwardTime: "06:00", returnTime: "18:00", matchId: null
    };

    const state: MatchableState = {
      users: [guestUser, host1User, host2User],
      subscriptions: [guestMorningSub, guestEveningSub, host1Sub, host2Sub],
      matches: []
    };

    const created = await runMatchSweep(state);
    assert(created.length === 2, "Created 2 matches for morning and evening");

    const morningMatch = state.matches.find(m => m.guestSubscriptionId === guestMorningSub.id);
    const eveningMatch = state.matches.find(m => m.guestSubscriptionId === guestEveningSub.id);

    assert(morningMatch?.hostId === host1User.id, "Morning matched to Host 1");
    assert(eveningMatch?.hostId === host2User.id, "Evening matched to Host 2");
  }
  console.log("------------------------------------------\n");

  // --------------------------------------------------------------------------
  // TEST 3: Morning matches but evening remains pending
  // --------------------------------------------------------------------------
  console.log("Scenario 3: Morning matches but evening remains pending");
  {
    const guestMorningSub: Subscription = {
      id: "sub_g_m3", userId: guestUser.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: baseOrigin, destination: baseDest,
      originGeo, destGeo, departureTime: "09:00", matchId: null
    };

    const guestEveningSub: Subscription = {
      id: "sub_g_e3", userId: guestUser.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: baseDest, destination: baseOrigin,
      originGeo: destGeo, destGeo: originGeo, departureTime: "18:00", matchId: null
    };

    // Host 1 only available in morning (09:00), evening time 22:00 (outside window)
    const host1Sub: Subscription = {
      id: "sub_h1_t3", userId: host1User.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: baseOrigin, destination: baseDest,
      originGeo, destGeo, forwardTime: "09:00", returnTime: "22:00", matchId: null
    };

    const state: MatchableState = {
      users: [guestUser, host1User],
      subscriptions: [guestMorningSub, guestEveningSub, host1Sub],
      matches: []
    };

    const created = await runMatchSweep(state);
    assert(created.length === 1, "Only 1 match created (morning)");
    assert(guestMorningSub.matchId !== null, "Morning sub is matched");
    assert(guestEveningSub.matchId === null, "Evening sub remains pending");

    const morningMatch = state.matches.find(m => m.guestSubscriptionId === guestMorningSub.id);
    assert(morningMatch?.hostId === host1User.id, "Morning matched to Host 1");
  }
  console.log("------------------------------------------\n");

  // --------------------------------------------------------------------------
  // TEST 4: Both remain pending and later become matched when a suitable Host becomes available
  // --------------------------------------------------------------------------
  console.log("Scenario 4: Both remain pending and later become matched when host becomes available");
  {
    const guestMorningSub: Subscription = {
      id: "sub_g_m4", userId: guestUser.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: baseOrigin, destination: baseDest,
      originGeo, destGeo, departureTime: "09:00", matchId: null
    };

    const guestEveningSub: Subscription = {
      id: "sub_g_e4", userId: guestUser.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: baseDest, destination: baseOrigin,
      originGeo: destGeo, destGeo: originGeo, departureTime: "18:00", matchId: null
    };

    const state: MatchableState = {
      users: [guestUser],
      subscriptions: [guestMorningSub, guestEveningSub],
      matches: []
    };

    // Phase 1: No host available
    const sweep1 = await runMatchSweep(state);
    assert(sweep1.length === 0, "No matches created initially");
    assert(guestMorningSub.matchId === null, "Morning sub remains pending");
    assert(guestEveningSub.matchId === null, "Evening sub remains pending");

    // Phase 2: Host becomes available later
    const newHostSub: Subscription = {
      id: "sub_h1_t4", userId: host1User.id, planName: "Monthly Plan", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: baseOrigin, destination: baseDest,
      originGeo, destGeo, forwardTime: "09:00", returnTime: "18:00", matchId: null
    };
    state.users.push(host1User);
    state.subscriptions.push(newHostSub);

    // Phase 3: Background sweep runs again
    const sweep2 = await runMatchSweep(state);
    assert(sweep2.length === 2, "Matches created when Host becomes available");
    assert(guestMorningSub.matchId !== null, "Morning sub is now matched");
    assert(guestEveningSub.matchId !== null, "Evening sub is now matched");
  }
  console.log("------------------------------------------\n");
  console.log("ALL 4 SCENARIOS PASSED PERFECTLY!");
}

runTests().catch(err => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
