import { findBuddyForGuest, tryMatchGuestSub, runMatchSweep, MatchableState } from "./matching";
import type { Subscription, User, Match } from "../src/types";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error("❌ FAILED:", msg);
    throw new Error(`Assertion failed: ${msg}`);
  }
  console.log("  ✓ PASSED:", msg);
}

async function runAll14Cases() {
  console.log("==================================================");
  console.log("     MOVEBUDDY GUEST-HOST MATCHING TEST SUITE     ");
  console.log("==================================================\n");

  const g1User: User = {
    id: "user_g1", name: "Guest G1", email: "g1@example.com", phone: "9000000001",
    role: "guest", gender: "female", isIdVerified: true, isCompanyVerified: true,
    avatarUrl: "", buddyScore: 85, rating: 4.8
  };

  const g2User: User = {
    id: "user_g2", name: "Guest G2", email: "g2@example.com", phone: "9000000002",
    role: "guest", gender: "male", isIdVerified: true, isCompanyVerified: true,
    avatarUrl: "", buddyScore: 80, rating: 4.7
  };

  const h1User: User = {
    id: "user_h1", name: "Host H1", email: "h1@example.com", phone: "9000000003",
    role: "host", gender: "male", isIdVerified: true, isCompanyVerified: true,
    avatarUrl: "", buddyScore: 90, rating: 4.9
  };

  const h2User: User = {
    id: "user_h2", name: "Host H2", email: "h2@example.com", phone: "9000000004",
    role: "host", gender: "female", isIdVerified: true, isCompanyVerified: true,
    avatarUrl: "", buddyScore: 88, rating: 4.8
  };

  // Coords for Koramangala (A) and Indiranagar (B) - approx 4.8 km apart
  const geoA = { lat: 12.9352, lng: 77.6245 };
  const geoB = { lat: 12.9784, lng: 77.6408 };
  // Coords far away (e.g., Whitefield - approx 15 km away)
  const geoFar = { lat: 12.9698, lng: 77.7500 };

  // =========================================================================
  // CASE 1 — SAME HOST MATCHES BOTH RIDES
  // =========================================================================
  console.log("CASE 1 — SAME HOST MATCHES BOTH RIDES");
  {
    const subG1_M: Subscription = {
      id: "c1_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    const subG1_E: Subscription = {
      id: "c1_g1_e", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: "Indiranagar", destination: "Koramangala",
      originGeo: geoB, destGeo: geoA, departureTime: "18:00", matchId: null
    };
    const subH1: Subscription = {
      id: "c1_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "08:05", returnTime: "18:05", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User],
      subscriptions: [subG1_M, subG1_E, subH1],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 2, "Created 2 matches");
    const mM = state.matches.find(m => m.guestSubscriptionId === subG1_M.id);
    const mE = state.matches.find(m => m.guestSubscriptionId === subG1_E.id);
    assert(mM?.hostId === h1User.id, "Morning matched to H1");
    assert(mE?.hostId === h1User.id, "Evening matched to H1");
  }
  console.log("");

  // =========================================================================
  // CASE 2 — DIFFERENT HOSTS FOR MORNING AND EVENING
  // =========================================================================
  console.log("CASE 2 — DIFFERENT HOSTS FOR MORNING AND EVENING");
  {
    const subG1_M: Subscription = {
      id: "c2_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    const subG1_E: Subscription = {
      id: "c2_g1_e", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: "Indiranagar", destination: "Koramangala",
      originGeo: geoB, destGeo: geoA, departureTime: "18:00", matchId: null
    };
    const subH1: Subscription = {
      id: "c2_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "08:05", returnTime: "22:00", matchId: null
    };
    const subH2: Subscription = {
      id: "c2_h2", userId: h2User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "06:00", returnTime: "18:05", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User, h2User],
      subscriptions: [subG1_M, subG1_E, subH1, subH2],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 2, "Created 2 matches");
    const mM = state.matches.find(m => m.guestSubscriptionId === subG1_M.id);
    const mE = state.matches.find(m => m.guestSubscriptionId === subG1_E.id);
    assert(mM?.hostId === h1User.id, "Morning matched to H1");
    assert(mE?.hostId === h2User.id, "Evening matched to H2");
  }
  console.log("");

  // =========================================================================
  // CASE 3 — MORNING MATCHED, EVENING PENDING
  // =========================================================================
  console.log("CASE 3 — MORNING MATCHED, EVENING PENDING");
  {
    const subG1_M: Subscription = {
      id: "c3_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    const subG1_E: Subscription = {
      id: "c3_g1_e", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: "Indiranagar", destination: "Koramangala",
      originGeo: geoB, destGeo: geoA, departureTime: "18:00", matchId: null
    };
    const subH1: Subscription = {
      id: "c3_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "08:05", returnTime: "22:00", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User],
      subscriptions: [subG1_M, subG1_E, subH1],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 1, "1 match created");
    assert(subG1_M.matchId !== null, "Morning sub matched");
    assert(subG1_E.matchId === null, "Evening sub remains pending");
    const mM = state.matches.find(m => m.guestSubscriptionId === subG1_M.id);
    assert(mM?.hostId === h1User.id, "Morning matched to H1");
  }
  console.log("");

  // =========================================================================
  // CASE 4 — EVENING MATCHED, MORNING PENDING
  // =========================================================================
  console.log("CASE 4 — EVENING MATCHED, MORNING PENDING");
  {
    const subG1_M: Subscription = {
      id: "c4_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    const subG1_E: Subscription = {
      id: "c4_g1_e", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: "Indiranagar", destination: "Koramangala",
      originGeo: geoB, destGeo: geoA, departureTime: "18:00", matchId: null
    };
    const subH1: Subscription = {
      id: "c4_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "11:00", returnTime: "18:05", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User],
      subscriptions: [subG1_M, subG1_E, subH1],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 1, "1 match created");
    assert(subG1_M.matchId === null, "Morning sub remains pending");
    assert(subG1_E.matchId !== null, "Evening sub matched");
    const mE = state.matches.find(m => m.guestSubscriptionId === subG1_E.id);
    assert(mE?.hostId === h1User.id, "Evening matched to H1");
  }
  console.log("");

  // =========================================================================
  // CASE 5 — NO HOST AVAILABLE
  // =========================================================================
  console.log("CASE 5 — NO HOST AVAILABLE");
  {
    const subG1_M: Subscription = {
      id: "c5_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    const subG1_E: Subscription = {
      id: "c5_g1_e", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: "Indiranagar", destination: "Koramangala",
      originGeo: geoB, destGeo: geoA, departureTime: "18:00", matchId: null
    };

    const state: MatchableState = {
      users: [g1User],
      subscriptions: [subG1_M, subG1_E],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 0, "0 matches created");
    assert(subG1_M.matchId === null, "Morning sub remains pending");
    assert(subG1_E.matchId === null, "Evening sub remains pending");
  }
  console.log("");

  // =========================================================================
  // CASE 6 — HOST BECOMES AVAILABLE LATER
  // =========================================================================
  console.log("CASE 6 — HOST BECOMES AVAILABLE LATER");
  {
    const subG1_M: Subscription = {
      id: "c6_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };

    const state: MatchableState = {
      users: [g1User],
      subscriptions: [subG1_M],
      matches: []
    };

    // Step 1: No host
    const m1 = await runMatchSweep(state);
    assert(m1.length === 0, "Step 1: 0 matches created, pending");
    assert(subG1_M.matchId === null, "Step 1: Morning sub remains pending");

    // Step 2: Host arrives later
    const subH1: Subscription = {
      id: "c6_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "08:10", returnTime: "18:00", matchId: null
    };
    state.users.push(h1User);
    state.subscriptions.push(subH1);

    const m2 = await runMatchSweep(state);
    assert(m2.length === 1, "Step 2: 1 match created automatically");
    assert(subG1_M.matchId !== null, "Step 2: Guest morning sub matched");
    const mM = state.matches.find(m => m.guestSubscriptionId === subG1_M.id);
    assert(mM?.hostId === h1User.id, "Step 2: Matched to H1");
  }
  console.log("");

  // =========================================================================
  // CASE 7 — PICKUP TOO FAR
  // =========================================================================
  console.log("CASE 7 — PICKUP TOO FAR");
  {
    const subG1_M: Subscription = {
      id: "c7_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    // Host pickup is far away (15 km away)
    const subH1: Subscription = {
      id: "c7_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Whitefield", destination: "Indiranagar",
      originGeo: geoFar, destGeo: geoB, forwardTime: "08:05", returnTime: "18:00", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User],
      subscriptions: [subG1_M, subH1],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 0, "No match due to pickup distance > 5km");
    assert(subG1_M.matchId === null, "Guest sub remains pending");
  }
  console.log("");

  // =========================================================================
  // CASE 8 — DESTINATION TOO FAR
  // =========================================================================
  console.log("CASE 8 — DESTINATION TOO FAR");
  {
    const subG1_M: Subscription = {
      id: "c8_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    // Host pickup is close (geoA), but destination is far away (geoFar - 15 km)
    const subH1: Subscription = {
      id: "c8_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Whitefield",
      originGeo: geoA, destGeo: geoFar, forwardTime: "08:05", returnTime: "18:00", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User],
      subscriptions: [subG1_M, subH1],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 0, "No match due to destination distance > 5km");
    assert(subG1_M.matchId === null, "Guest sub remains pending");
  }
  console.log("");

  // =========================================================================
  // CASE 9 — TIME DOES NOT MATCH
  // =========================================================================
  console.log("CASE 9 — TIME DOES NOT MATCH");
  {
    const subG1_M: Subscription = {
      id: "c9_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    // Host time is 09:00 (60 minutes difference > 30 minutes window)
    const subH1: Subscription = {
      id: "c9_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "09:00", returnTime: "18:00", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User],
      subscriptions: [subG1_M, subH1],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 0, "No match due to time difference > 30 mins");
    assert(subG1_M.matchId === null, "Guest sub remains pending");
  }
  console.log("");

  // =========================================================================
  // CASE 10 — TIME MATCHES
  // =========================================================================
  console.log("CASE 10 — TIME MATCHES");
  {
    const subG1_M: Subscription = {
      id: "c10_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    // Host time is 08:20 (20 minutes difference <= 30 minutes window)
    const subH1: Subscription = {
      id: "c10_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "08:20", returnTime: "18:00", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User],
      subscriptions: [subG1_M, subH1],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 1, "Match created for 20 mins difference");
    assert(subG1_M.matchId !== null, "Guest sub matched");
  }
  console.log("");

  // =========================================================================
  // CASE 11 — SAME GUEST, TWO INDEPENDENT MATCHES
  // =========================================================================
  console.log("CASE 11 — SAME GUEST, TWO INDEPENDENT MATCHES");
  {
    const subG1_M: Subscription = {
      id: "c11_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    const subG1_E: Subscription = {
      id: "c11_g1_e", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: "Indiranagar", destination: "Koramangala",
      originGeo: geoB, destGeo: geoA, departureTime: "18:00", matchId: null
    };
    const subH1: Subscription = {
      id: "c11_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "08:05", returnTime: "18:05", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User],
      subscriptions: [subG1_M, subG1_E, subH1],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 2, "2 matches created");
    assert(state.matches.length === 2, "2 match records stored independently in state");
    const mM = state.matches.find(m => m.direction === "forward");
    const mE = state.matches.find(m => m.direction === "return");
    assert(mM?.id !== mE?.id, "Matches have unique IDs");
    assert(mM?.guestSubscriptionId === subG1_M.id, "Morning match references morning sub ID");
    assert(mE?.guestSubscriptionId === subG1_E.id, "Evening match references evening sub ID");
  }
  console.log("");

  // =========================================================================
  // CASE 12 — SAME GUEST, TWO DIFFERENT HOSTS
  // =========================================================================
  console.log("CASE 12 — SAME GUEST, TWO DIFFERENT HOSTS");
  {
    const subG1_M: Subscription = {
      id: "c12_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    const subG1_E: Subscription = {
      id: "c12_g1_e", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: "Indiranagar", destination: "Koramangala",
      originGeo: geoB, destGeo: geoA, departureTime: "18:00", matchId: null
    };
    const subH1: Subscription = {
      id: "c12_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "08:05", returnTime: "22:00", matchId: null
    };
    const subH2: Subscription = {
      id: "c12_h2", userId: h2User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "06:00", returnTime: "18:05", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User, h2User],
      subscriptions: [subG1_M, subG1_E, subH1, subH2],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 2, "2 matches created");
    const mM = state.matches.find(m => m.guestSubscriptionId === subG1_M.id);
    const mE = state.matches.find(m => m.guestSubscriptionId === subG1_E.id);
    assert(mM?.hostId === h1User.id, "Morning matched to H1");
    assert(mE?.hostId === h2User.id, "Evening matched to H2");
    assert(mM?.hostId !== mE?.hostId, "Two different host IDs saved");
  }
  console.log("");

  // =========================================================================
  // CASE 13 — TWO GUESTS, ONE SUITABLE HOST RIDE
  // =========================================================================
  console.log("CASE 13 — TWO GUESTS, ONE SUITABLE HOST RIDE");
  {
    const subG1_M: Subscription = {
      id: "c13_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    const subG2_M: Subscription = {
      id: "c13_g2_m", userId: g2User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:05", matchId: null
    };
    const subH1: Subscription = {
      id: "c13_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "08:00", returnTime: "18:00", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, g2User, h1User],
      subscriptions: [subG1_M, subG2_M, subH1],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 1, "Only 1 guest matched to the single Host ride");
    const matchedCountForH1 = state.matches.filter(m => m.hostSubscriptionId === subH1.id && m.direction === "forward").length;
    assert(matchedCountForH1 === 1, "Host ride is paired 1:1 with exactly 1 guest (no double-matching)");
    const unmatchedGuestSub = [subG1_M, subG2_M].find(s => s.matchId === null);
    assert(unmatchedGuestSub !== undefined, "The other guest remains pending for future host availability");
  }
  console.log("");

  // =========================================================================
  // CASE 14 — COMPLETE END-TO-END TEST
  // =========================================================================
  console.log("CASE 14 — COMPLETE END-TO-END TEST");
  {
    const subG1_M: Subscription = {
      id: "c14_g1_m", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "forward", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, departureTime: "08:00", matchId: null
    };
    const subG1_E: Subscription = {
      id: "c14_g1_e", userId: g1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 500, status: "active",
      role: "guest", direction: "return", origin: "Indiranagar", destination: "Koramangala",
      originGeo: geoB, destGeo: geoA, departureTime: "18:00", matchId: null
    };
    const subH1: Subscription = {
      id: "c14_h1", userId: h1User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "08:10", returnTime: "22:00", matchId: null
    };
    const subH2: Subscription = {
      id: "c14_h2", userId: h2User.id, planName: "Monthly Pass", durationDays: 30,
      startDate: "2026-08-08", endDate: "2026-09-08", amountPaid: 99, status: "active",
      role: "host", origin: "Koramangala", destination: "Indiranagar",
      originGeo: geoA, destGeo: geoB, forwardTime: "06:00", returnTime: "18:15", matchId: null
    };

    const state: MatchableState = {
      users: [g1User, h1User, h2User],
      subscriptions: [subG1_M, subG1_E, subH1, subH2],
      matches: []
    };

    const matches = await runMatchSweep(state);
    assert(matches.length === 2, "G1 matched morning -> H1 and evening -> H2");
    const mM = state.matches.find(m => m.guestSubscriptionId === subG1_M.id);
    const mE = state.matches.find(m => m.guestSubscriptionId === subG1_E.id);
    assert(mM?.hostId === h1User.id, "Morning matched to H1");
    assert(mE?.hostId === h2User.id, "Evening matched to H2");
  }
  console.log("");

  console.log("==================================================");
  console.log("     ALL 14 MATCHING CASES EXECUTED SUCCESSFULLY!  ");
  console.log("==================================================");
}

runAll14Cases().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
