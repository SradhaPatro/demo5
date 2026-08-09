import prisma from "./prisma.js";

/**
 * Extended cleanup pass:
 * - Fix sub_6bf3a58 which still has 2 active matches (keep the newer one)
 * - Fix all subscriptions with stale matchIds pointing to non-ACTIVE matches
 * - Restore idx_active_match_guest_sub once duplicates are gone
 */
async function cleanup2() {
  console.log("=== CLEANUP PASS 2 ===\n");

  // ── 1. Fix sub_6bf3a58: has 2 active matches, keep the newer one ───────────
  const dup6bf: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, "createdAt", "hostSubscriptionId", direction, status
    FROM matches
    WHERE "guestSubscriptionId" = 'sub_6bf3a58' AND status = 'ACTIVE'
    ORDER BY "createdAt" ASC
  `);
  console.log("sub_6bf3a58 active matches:", JSON.stringify(dup6bf, null, 2));

  if (dup6bf.length > 1) {
    // Cancel all but the newest
    const toCancel = dup6bf.slice(0, dup6bf.length - 1).map(m => m.id);
    const r = await prisma.match.updateMany({
      where: { id: { in: toCancel }, status: "ACTIVE" },
      data: { status: "CANCELLED" },
    });
    console.log(`Cancelled ${r.count} older duplicate match(es) for sub_6bf3a58`);
    // Update the guest subscription matchId to the kept match
    const kept = dup6bf[dup6bf.length - 1];
    await prisma.subscription.update({
      where: { id: "sub_6bf3a58" },
      data: { matchId: kept.id },
    });
    console.log(`Set sub_6bf3a58.matchId = ${kept.id}`);
  }

  // ── 2. Fix all subscriptions with stale matchId ─────────────────────────────
  // Find subs whose matchId points to a non-ACTIVE match
  const stale: any[] = await prisma.$queryRawUnsafe(`
    SELECT s.id as sub_id, s."matchId", m.status as match_status
    FROM subscriptions s
    JOIN matches m ON s."matchId" = m.id
    WHERE s.status = 'ACTIVE' AND m.status != 'ACTIVE'
  `);
  console.log(`\nFound ${stale.length} subscription(s) with stale matchId`);

  for (const row of stale) {
    // Check if there's actually an active match for this subscription
    const activeMatch: any[] = await prisma.$queryRawUnsafe(`
      SELECT id FROM matches
      WHERE "guestSubscriptionId" = $1 AND status = 'ACTIVE'
      LIMIT 1
    `, row.sub_id);

    if (activeMatch.length > 0) {
      // Update to point to the real active match
      await prisma.subscription.update({
        where: { id: row.sub_id },
        data: { matchId: activeMatch[0].id },
      });
      console.log(`  Fixed sub ${row.sub_id}: matchId ${row.matchId} → ${activeMatch[0].id}`);
    } else {
      // No active match — clear matchId so guest can be re-matched
      await prisma.subscription.update({
        where: { id: row.sub_id },
        data: { matchId: null },
      });
      console.log(`  Cleared sub ${row.sub_id}: matchId ${row.matchId} → null (will be re-matched by sweep)`);
    }
  }

  // ── 3. Now restore guest sub index (duplicates should be gone) ──────────────
  console.log("\nRestoring idx_active_match_guest_sub...");
  try {
    await prisma.$queryRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_active_match_guest_sub
      ON matches ("guestSubscriptionId") WHERE status = 'ACTIVE';
    `);
    console.log("  idx_active_match_guest_sub: OK ✅");
  } catch (e: any) {
    console.error("  FAILED:", e.message);
  }

  // ── 4. Final verification ───────────────────────────────────────────────────
  console.log("\n=== FINAL VERIFICATION ===");

  const dupHost: any[] = await prisma.$queryRawUnsafe(`
    SELECT "hostId", direction, COUNT(*)::int as cnt
    FROM matches WHERE status = 'ACTIVE'
    GROUP BY "hostId", direction HAVING COUNT(*) > 1
  `);
  console.log("Duplicate hostId+direction:", dupHost.length === 0 ? "NONE ✅" : JSON.stringify(dupHost));

  const dupGuest: any[] = await prisma.$queryRawUnsafe(`
    SELECT "guestSubscriptionId", COUNT(*)::int as cnt
    FROM matches WHERE status = 'ACTIVE'
    GROUP BY "guestSubscriptionId" HAVING COUNT(*) > 1
  `);
  console.log("Duplicate guestSubscriptionId:", dupGuest.length === 0 ? "NONE ✅" : JSON.stringify(dupGuest));

  const staleAfter: any[] = await prisma.$queryRawUnsafe(`
    SELECT s.id, s."matchId", m.status
    FROM subscriptions s
    JOIN matches m ON s."matchId" = m.id
    WHERE s.status = 'ACTIVE' AND m.status != 'ACTIVE'
  `);
  console.log("Stale matchIds:", staleAfter.length === 0 ? "NONE ✅" : JSON.stringify(staleAfter));

  const indexes: any[] = await prisma.$queryRawUnsafe(`
    SELECT indexname FROM pg_indexes WHERE tablename = 'matches' AND indexname LIKE 'idx_active%'
  `);
  console.log("Active unique indexes:", indexes.map(i => i.indexname).join(", ") || "NONE ❌");

  const activeMatches: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, "guestId", "hostId", direction, "guestSubscriptionId", "hostSubscriptionId"
    FROM matches WHERE status = 'ACTIVE' ORDER BY "createdAt"
  `);
  console.log(`\nAll ${activeMatches.length} active matches:`);
  activeMatches.forEach(m => console.log(`  ${m.id}: host=${m.hostId} (${m.hostSubscriptionId}) → guest=${m.guestId} dir=${m.direction}`));

  await prisma.$disconnect();
  console.log("\n=== DONE ===");
}

cleanup2().catch(e => { console.error(e); process.exit(1); });
