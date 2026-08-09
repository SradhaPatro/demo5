import prisma from "./prisma.js";

async function investigate() {
  console.log("=== DRILL-DOWN INVESTIGATION ===\n");

  const HOST_ID = 'usr_3576191';

  // 1. All subscriptions for this host (all statuses)
  const hostSubs: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, "userId", role, status, direction, origin, destination,
           "forwardTime", "returnTime", "createdAt", "updatedAt"
    FROM subscriptions
    WHERE "userId" = $1 AND role = 'host'
    ORDER BY "createdAt" ASC
  `, HOST_ID);
  console.log("1. ALL host subscriptions for usr_3576191:", JSON.stringify(hostSubs, null, 2));

  // 2. All active matches involving this host
  const hostMatches: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, "hostId", "hostSubscriptionId", "guestId", "guestSubscriptionId",
           direction, status, "createdAt", "updatedAt"
    FROM matches
    WHERE "hostId" = $1
    ORDER BY "createdAt" ASC
  `, HOST_ID);
  console.log("2. ALL matches for host usr_3576191:", JSON.stringify(hostMatches, null, 2));

  // 3. The two subscriptions that are both active — when were they created vs when was the duplicate match created?
  // sub_1272ae6 and sub_ff9ed54 — check if one should have been expired
  const twoSubs: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, status, "createdAt", "updatedAt", origin, destination, "forwardTime", "returnTime"
    FROM subscriptions
    WHERE id IN ('sub_1272ae6', 'sub_ff9ed54')
    ORDER BY "createdAt" ASC
  `);
  console.log("3. The two host subscriptions sub_1272ae6 and sub_ff9ed54:", JSON.stringify(twoSubs, null, 2));

  // 4. Timeline: were both subs ever simultaneously ACTIVE? Check updatedAt vs match createdAt
  // match_00fab22a and match_014c5188 were created 1ms apart — race condition check
  const twoMatches: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, "hostSubscriptionId", "guestSubscriptionId", "guestId", direction, status, "createdAt"
    FROM matches
    WHERE id IN ('match_00fab22a', 'match_014c5188', 'match_1a16e9d6', 'match_744eab54')
    ORDER BY "createdAt" ASC
  `);
  console.log("4. The duplicate match pairs (created timestamps):", JSON.stringify(twoMatches, null, 2));

  // 5. Guest subscriptions involved — do they have matchId set?
  const guestSubs: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, "userId", role, status, direction, "matchId", "createdAt"
    FROM subscriptions
    WHERE id IN ('sub_78f0808', 'sub_6bf3a58')
  `);
  console.log("5. Guest subs with >1 active match:", JSON.stringify(guestSubs, null, 2));

  await prisma.$disconnect();
}

investigate().catch((e) => {
  console.error(e);
  process.exit(1);
});
