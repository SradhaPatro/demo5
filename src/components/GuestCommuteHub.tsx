import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { User, Subscription, CommuteDirection } from '../types';
import PlacePicker, { PlaceValue } from './PlacePicker';
import RouteMap from './RouteMap';
import PricingPlans from './PricingPlans';
import PaymentSummary from './PaymentSummary';
import { startCheckout } from '../lib/checkout';
import { calcGuestSavings, calcGuestFinalPrice, planLabelToType, formatINR } from '../lib/pricing';
import { Sunrise, Sunset, Loader, CheckCircle, Clock, Search, ShieldAlert, TrendingDown, Leaf, ArrowRight, XCircle, MapPin, UserCheck } from 'lucide-react';
import TripCard from './TripCard';
import { useTrip } from '../hooks/useTrip';
import { useLiveTracking } from '../hooks/useLiveTracking';
import { calculateCommuteDayInfo } from '../lib/commuteSchedule';

interface Props {
  currentUser: User;
  onRefreshWallet: () => void;
}

type PlanName = '7-Day Plan' | '15-Day Plan' | 'Monthly Plan';

interface BuddyMatch {
  id: string; direction: CommuteDirection; proximityTierM: number; score: number;
  buddy: { id: string; name: string; avatarUrl: string; rating: number } | null;
  route: { origin: string; destination: string } | null;
}

interface PlanFlow {
  direction: CommuteDirection;
  distanceKm: number;
  subDetails: Record<string, unknown>;
}

const DIRECTIONS: { key: CommuteDirection; label: string; sub: string; icon: typeof Sunrise }[] = [
  { key: 'forward', label: 'Morning · Home → Destination', sub: 'Your ride to office / college', icon: Sunrise },
  { key: 'return', label: 'Evening · Destination → Home', sub: 'Your ride back home', icon: Sunset },
];

export default function GuestCommuteHub({ currentUser, onRefreshWallet }: Props) {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [matches, setMatches] = useState<BuddyMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [tripBusy, setTripBusy] = useState(false);
  const tripOps = useTrip(currentUser?.id);

  const handleConfirmPickup = async (tripId: string, opts: { method: "otp" | "qr" | "manual"; code?: string }) => {
    setTripBusy(true);
    await tripOps.confirmPickup(tripId, opts);
    setTripBusy(false);
  };

  const handleGuestConfirm = async (tripId: string) => {
    setTripBusy(true);
    await tripOps.guestConfirmTrip(tripId);
    setTripBusy(false);
  };

  const handleCancelTrip = async (tripId: string, reason?: string) => {
    setTripBusy(true);
    await tripOps.cancelTrip(tripId, reason);
    setTripBusy(false);
  };

  useLiveTracking({
    tripId: tripOps.activeTrip?.id,
    userId: currentUser?.id,
    role: 'guest',
    enabled: tripOps.activeTrip?.status === 'in_progress',
    originGeo: tripOps.activeTrip?.originGeo,
    destGeo: tripOps.activeTrip?.destGeo,
  });
  const [sos, setSos] = useState('');
  const [flow, setFlow] = useState<PlanFlow | null>(null);   // when set → full-page plans
  const [pendingPlan, setPendingPlan] = useState<PlanName | null>(null); // chosen plan → summary screen
  const [quote, setQuote] = useState<any>(null);                          // authoritative price breakdown
  const [paying, setPaying] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const safeJson = (r: Response) => (r.ok && r.headers.get('content-type')?.includes('application/json') ? r.json().catch(() => null) : null);
      const [s, m] = await Promise.all([
        fetch(`/api/subscriptions/${currentUser.id}`).then(safeJson),
        fetch(`/api/matches/${currentUser.id}`).then(safeJson),
      ]);
      const toArray = (data: any) => Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      setSubs(toArray(s));
      setMatches(toArray(m));
    } catch { /* offline */ } finally { setLoading(false); }
  }, [currentUser.id]);

  useEffect(() => { load(); }, [load]);

  // Poll every 3s while any subscription is in a non-terminal state
  useEffect(() => {
    const hasPending = subs.some(s => s.status === 'pending' || s.status === 'geocoding' || s.status === 'matching');
    if (!hasPending) return;
    const interval = setInterval(() => { load(); }, 3000);
    return () => clearInterval(interval);
  }, [subs, load]);

  const triggerSos = async () => {
    try {
      await fetch('/api/support/tickets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, senderName: currentUser.name, ticketType: 'sos', category: 'CRITICAL EMERGENCY', description: `SOS triggered by ${currentUser.name} during commute.` }),
      });
      setSos('🚨 SOS sent — support & emergency contacts notified.');
    } catch { setSos('Could not send SOS. Please call your local emergency number.'); }
    setTimeout(() => setSos(''), 6000);
  };

  // Plan chosen → fetch the authoritative price breakdown, then show the summary.
  const handleSelectPlan = async (planName: PlanName) => {
    if (!flow || pendingPlan) return;
    setErr('');
    try {
      const res = await fetch('/api/subscriptions/calculate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'guest', planType: planLabelToType(planName), distanceKm: flow.distanceKm }),
      });
      setQuote(await res.json());
    } catch { setQuote(null); }
    setPendingPlan(planName);
  };

  // "Pay" on the summary → process instant payment and activate.
  const handlePay = async (): Promise<boolean> => {
    if (!flow || !pendingPlan) return false;
    setErr(''); setPaying(true);
    const amountToPay = quote?.finalPrice ?? calcGuestFinalPrice({ distanceKm: flow.distanceKm, plan: planLabelToType(pendingPlan) }).finalPrice;
    const result = await startCheckout({
      planName: pendingPlan,
      role: 'guest',
      distanceKm: flow.distanceKm,
      subDetails: { ...flow.subDetails, amountPaid: amountToPay }
    });
    setPaying(false);
    if (!result.success) { setErr(result.error || 'Payment failed'); return false; }
    await load();           // now shows the active pass + buddy
    onRefreshWallet();
    return true;
  };

  if (loading) return <div className="flex justify-center py-20"><Loader className="w-6 h-6 animate-spin text-[#ffb300]" /></div>;

  // ── Branded order summary (after a plan is chosen, before Razorpay) ──
  if (flow && pendingPlan) {
    const sd = flow.subDetails as any;
    const fallback = calcGuestFinalPrice({ distanceKm: flow.distanceKm, plan: planLabelToType(pendingPlan) }).finalPrice;
    return (
      <div className="min-h-screen">
        <PaymentSummary
          role="guest"
          planName={pendingPlan}
          amount={quote?.finalPrice ?? fallback}
          planPrice={quote?.planPrice}
          welcomeCredit={quote?.welcomeCredit ?? 0}
          walletCredit={quote?.walletCredit ?? 0}
          distanceKm={flow.distanceKm}
          origin={sd.origin}
          destination={sd.destination}
          direction={flow.direction}
          departureTime={sd.departureTime}
          paying={paying}
          error={err}
          onPay={handlePay}
          onCancel={() => { setErr(''); setPendingPlan(null); setFlow(null); setQuote(null); load(); }}
        />
      </div>
    );
  }

  // ── Full-page Subscription Plans (separate "page") ──
  if (flow) {
    return (
      <div className="min-h-screen">
        {err && <div className="max-w-5xl mx-auto !bg-rose-50 border-l-4 border-rose-500 !text-rose-700 text-xs p-2.5 m-3 rounded">{err}</div>}
        <PricingPlans role="guest" distanceKm={flow.distanceKm} busyPlan={pendingPlan} onSelect={handleSelectPlan} onBack={() => { setErr(''); setFlow(null); }} />
      </div>
    );
  }

  const activeSub = subs.find(s => s.role === 'guest' && (s.status === 'active' || s.status === 'matching'));
  const dayInfo = calculateCommuteDayInfo(activeSub || null);

  // ── Hub ──
  return (
    <div className="max-w-3xl mx-auto px-4 py-6 pb-32 space-y-5">
      <div className="text-center mb-2">
        <h2 className="text-2xl font-black !text-[#2a2e34]">Your Daily Commute</h2>
        <p className="text-sm !text-[#2a2e34]/60 mt-1">A full commute needs two passes — one per direction. We auto-assign your buddy; no browsing, no choosing.</p>
      </div>

      {/* Active Commute Plan & Day Counter Header */}
      {activeSub && (
        <div className="!bg-[#2a2e34] border !border-emerald-500/30 rounded-2xl p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] font-black uppercase tracking-widest !text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
                {dayInfo.planName}
              </span>
              <div className="text-xl font-black !text-[#e9eaec] mt-1.5">
                Day {dayInfo.currentDay} <span className="text-sm font-semibold !text-[#e9eaec]/60">of {dayInfo.totalDays} active days</span>
              </div>
              <div className="text-xs !text-[#e9eaec]/60 mt-0.5">{dayInfo.formattedDate} {dayInfo.isWeekend ? '(Weekend • Non-commute day)' : ''}</div>
            </div>
            <div className="text-right">
              <span className="text-xs font-bold text-emerald-400 flex items-center gap-1">
                <CheckCircle className="w-4 h-4 inline" /> Active Commuter Pass
              </span>
              <div className="text-[10px] !text-[#e9eaec]/50 mt-1">Buddy auto-assigned per direction</div>
            </div>
          </div>
          <div className="w-full bg-[#1c1f22] h-2 rounded-full overflow-hidden border border-emerald-500/20 flex">
            <div
              className="bg-gradient-to-r from-emerald-500 to-teal-400 h-full rounded-full transition-all duration-500"
              style={{ width: `${(dayInfo.currentDay / dayInfo.totalDays) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Active trip card */}
      {tripOps.activeTrip && (
        <TripCard
          trip={tripOps.activeTrip}
          role="guest"
          onConfirmPickup={handleConfirmPickup}
          onGuestConfirm={handleGuestConfirm}
          onCancelTrip={handleCancelTrip}
          busy={tripBusy}
          error={tripOps.error}
        />
      )}

      {DIRECTIONS.map(d => (
        <DirectionCard
          key={d.key}
          dir={d}
          allSubs={subs}
          sub={subs.filter(s => s.role === 'guest' && (s.direction?.toLowerCase() === d.key || (d.key === 'return' && s.direction?.toLowerCase() === 'evening') || (d.key === 'forward' && s.direction?.toLowerCase() === 'morning')) && (s.status === 'active' || s.status === 'pending' || s.status === 'geocoding' || s.status === 'matching' || s.status === 'failed')).slice(-1)[0] || null}
          match={matches.find(m => m.direction?.toLowerCase() === d.key || (d.key === 'return' && m.direction?.toLowerCase() === 'evening') || (d.key === 'forward' && m.direction?.toLowerCase() === 'morning')) || null}
          onFindMatch={(f) => { setErr(''); setFlow(f); }}
        />
      ))}

      <div>
        <button onClick={triggerSos} className="w-full bg-transparent border-2 !border-[#dc2626] !text-[#dc2626] hover:!bg-[#dc2626]/10 font-bold py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 transition-colors">
          <ShieldAlert className="w-4 h-4" /> Emergency SOS
        </button>
        {sos && <div className="mt-2 text-center text-xs !bg-rose-50 !text-rose-700 p-2 rounded">{sos}</div>}
      </div>
    </div>
  );
}

function DirectionCard({ dir, sub, match, allSubs = [], onFindMatch }: {
  dir: { key: CommuteDirection; label: string; sub: string; icon: typeof Sunrise };
  sub: Subscription | null; match: BuddyMatch | null; allSubs?: Subscription[];
  onFindMatch: (f: PlanFlow) => void;
}) {
  const Icon = dir.icon;
  const [open, setOpen] = useState(false);
  const [home, setHome] = useState<PlaceValue>({ address: '' });
  const [dest, setDest] = useState<PlaceValue>({ address: '' });
  const [time, setTime] = useState(dir.key === 'forward' ? '09:00' : '18:00');
  const [distanceKm, setDistanceKm] = useState(0); // 0 = not computed yet
  const [distanceSource, setDistanceSource] = useState('');
  const [computing, setComputing] = useState(false);
  const [err, setErr] = useState('');
  const findingRef = useRef(false);

  // Auto-fill Home and Destination from opposite direction if available and fields are empty
  useEffect(() => {
    if (open && !home.address && !dest.address && allSubs.length > 0) {
      const oppSub = allSubs.find(s => s.role === 'guest' && String(s.direction).toLowerCase() !== String(dir.key).toLowerCase() && s.status !== 'failed');
      if (oppSub) {
        const oppDir = String(oppSub.direction || '').toLowerCase();
        const isOppFwd = oppDir === 'forward' || oppDir === 'morning';
        if (isOppFwd) {
          // Opposite is forward: origin = Home, destination = Office
          if (oppSub.origin) setHome({ address: oppSub.origin, geo: oppSub.originGeo });
          if (oppSub.destination) setDest({ address: oppSub.destination, geo: oppSub.destGeo });
        } else {
          // Opposite is return: origin = Office, destination = Home
          if (oppSub.destination) setHome({ address: oppSub.destination, geo: oppSub.destGeo });
          if (oppSub.origin) setDest({ address: oppSub.origin, geo: oppSub.originGeo });
        }
      }
    }
  }, [open, allSubs, dir.key, home.address, dest.address]);

  const origin = dir.key === 'forward' ? home : dest;
  const destination = dir.key === 'forward' ? dest : home;

  // Auto-calculate the real route distance once BOTH addresses are chosen.
  useEffect(() => {
    if (!origin.address || !destination.address) { setDistanceKm(0); return; }
    let cancelled = false;
    setComputing(true);
    fetch('/api/distance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: origin.address, destination: destination.address, originGeo: origin.geo, destGeo: destination.geo }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.km) { setDistanceKm(d.km); setDistanceSource(d.source || ''); } })
      .catch(() => {})
      .finally(() => { if (!cancelled) setComputing(false); });
    return () => { cancelled = true; };
  }, [origin.address, destination.address, origin.geo?.lat, destination.geo?.lat]);

  const hasRoute = distanceKm > 0;
  const savings = useMemo(() => hasRoute ? calcGuestSavings(distanceKm, '1m') : null, [distanceKm, hasRoute]);

  const findMatch = () => {
    if (findingRef.current) return;
    if (!origin.address || !destination.address) { setErr('Set Home and Destination first.'); return; }
    if (!hasRoute) { setErr('Calculating route distance — one moment…'); return; }
    findingRef.current = true;
    setErr('');
    onFindMatch({
      direction: dir.key, distanceKm,
      subDetails: { direction: dir.key, origin: origin.address, destination: destination.address, originGeo: origin.geo, destGeo: destination.geo, departureTime: time, pickupRadiusM: 5000, dropRadiusM: 5000 },
    });
    setTimeout(() => { findingRef.current = false; }, 1000);
  };

  // Subscription exists — show active pass card
  if (sub) {
    if (sub.status === 'failed') {
      return (
        <div className="!bg-white border !border-rose-300 rounded-2xl p-4 sm:p-5">
          <Header Icon={Icon} dir={dir} pill="Failed" pillClass="!bg-rose-500/15 !text-rose-600" />
          <div className="mt-3 text-xs !text-[#2a2e34]/70 break-words">{sub.origin} → {sub.destination} · {sub.planName}</div>
          <div className="mt-4 !bg-rose-50 rounded-xl p-4 flex items-center gap-3 border !border-rose-200">
            <XCircle className="w-5 h-5 text-rose-400 shrink-0" />
            <div className="text-xs !text-rose-700">Activation failed. Please contact support@movebuddy.com or file a support ticket for assistance.</div>
          </div>
        </div>
      );
    }

    // Active / Pending / Geocoding / Matching pass
    return (
      <div className="!bg-white border-2 !border-emerald-500/40 rounded-2xl p-4 sm:p-5 shadow-sm">
        <Header Icon={Icon} dir={dir} pill="Active Pass" pillClass="!bg-emerald-500/15 !text-emerald-700 font-black" />
        <div className="mt-3 text-xs !text-[#2a2e34]/80 break-words font-medium flex items-center justify-between gap-2">
          <span>{sub.origin} → {sub.destination} · {sub.departureTime || dir.key} · <strong className="!text-[#b57e00] font-bold">{sub.planName}</strong></span>
          <span className="text-[10px] text-emerald-800 bg-emerald-100 border border-emerald-300 font-extrabold px-2 py-0.5 rounded-full shrink-0">✓ Pass Saved &amp; Active</span>
        </div>

        {match && match.buddy ? (
          <div className="mt-4 !bg-[#eef0f3] rounded-xl p-4 flex items-center gap-3 border !border-emerald-500/20">
            <img src={match.buddy.avatarUrl} alt="" className="w-12 h-12 rounded-full object-cover border-2 !border-emerald-500 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase font-bold !text-emerald-700 tracking-wider">Matched Buddy</div>
              <div className="text-sm font-bold !text-[#2a2e34] truncate">{match.buddy.name}</div>
              <div className="text-[11px] !text-[#2a2e34]/60">★ {match.buddy.rating || 'New'} · within {match.proximityTierM}m · match {match.score}%</div>
            </div>
            <CheckCircle className="w-5 h-5 text-emerald-500 shrink-0" />
          </div>
        ) : (
          <div className="mt-4 !bg-[#eef0f3] rounded-xl p-4 flex items-center gap-3 border !border-emerald-500/20">
            <Search className="w-5 h-5 !text-[#b57e00] animate-pulse shrink-0" />
            <div className="text-xs !text-[#2a2e34]/80 font-medium">
              <span className="font-bold text-amber-700 block text-xs">Host Currently Unavailable</span>
              A Host is currently unavailable for this ride. The system will automatically match you when a suitable Host becomes available.
            </div>
          </div>
        )}
      </div>
    );
  }

  // Setup
  return (
    <div className="!bg-white border !border-[#ffb300]/15 rounded-2xl p-4 sm:p-5">
      <Header Icon={Icon} dir={dir} pill="No Pass" pillClass="!bg-[#eef0f3] !text-[#2a2e34]/50" />
      {!open ? (
        <button onClick={() => setOpen(true)} className="mt-4 w-full !bg-[#ffb300] hover:!bg-[#e09d00] !text-[#2a2e34] font-bold py-2.5 rounded-xl text-sm transition-colors">
          Set up this commute
        </button>
      ) : (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-3">
            <PlacePicker label="Home" placeholder="Your home address" value={home} onChange={setHome} />
            <PlacePicker label="Destination (Office / College)" placeholder="Where you commute to" value={dest} onChange={setDest} />
            {(origin.geo || destination.geo) && (
              <div className="my-2">
                <RouteMap originGeo={origin.geo} destinationGeo={destination.geo} originAddress={origin.address} destinationAddress={destination.address} />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold !text-[#b57e00] uppercase tracking-wider mb-1"><Clock className="w-3 h-3 inline mr-1" />Departure time</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} className="w-full !bg-[#eef0f3] border !border-[#ffb300]/25 rounded-xl py-2.5 px-3 !text-[#2a2e34] text-sm focus:outline-none focus:!border-[#ffb300]" />
            </div>

            <div className="text-[11px] !text-[#2a2e34]/60">
              {computing ? 'Calculating route distance…' : hasRoute ? <>Route distance: <span className="!text-[#b57e00] font-bold">{distanceKm} km</span> {distanceSource === 'estimate' ? '(estimated — pick from address suggestions for exact)' : '(auto-detected)'}</> : 'Select Home & Destination to detect distance.'}
            </div>
          </div>
          <div className="!bg-[#eef0f3] rounded-xl p-4 border !border-[#ffb300]/15 flex flex-col">
            <div className="text-[10px] uppercase font-bold !text-[#b57e00] tracking-wider mb-2">Your savings (monthly)</div>
            {!hasRoute || !savings ? (
              <div className="flex-1 flex items-center justify-center text-center text-xs !text-[#2a2e34]/50 py-6">
                {computing ? 'Calculating your route…' : 'Enter your Home & Destination above to see how much you save with MoveBuddy.'}
              </div>
            ) : (
              <>
                <Row label={`Bike taxi (~₹13/km × ${distanceKm}km)`} value={formatINR(savings.individual)} strike />
                <Row label="MoveBuddy pooling" value={formatINR(savings.moveBuddy)} accent />
                <div className="my-2 border-t !border-[#ffb300]/10" />
                <div className="flex items-center justify-between">
                  <span className="text-xs !text-emerald-600 font-bold flex items-center gap-1"><TrendingDown className="w-3.5 h-3.5" /> You save</span>
                  <span className="text-lg font-black !text-emerald-600">{formatINR(savings.saved)} <span className="text-[11px]">({savings.savedPct}%)</span></span>
                </div>
                <div className="mt-2 flex items-center gap-1 text-[11px] !text-[#2a2e34]/60"><Leaf className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> ~{savings.co2KgSaved} kg CO₂ saved · ₹{savings.monthlyProjection}/mo projected</div>
              </>
            )}
            <button onClick={findMatch} disabled={!hasRoute || computing} className="mt-4 md:mt-auto w-full !bg-[#ffb300] hover:!bg-[#e09d00] !text-[#2a2e34] font-black py-2.5 rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50">
              {computing ? 'Detecting route…' : <>Find Matching Ride <ArrowRight className="w-4 h-4" /></>}
            </button>
            {err && <div className="mt-2 text-[11px] !text-rose-600">{err}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strike, accent }: { label: string; value: string; strike?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-xs !text-[#2a2e34]/60">{label}</span>
      <span className={`text-sm font-bold ${strike ? 'line-through !text-[#2a2e34]/40' : accent ? '!text-[#b57e00]' : '!text-[#2a2e34]'}`}>{value}</span>
    </div>
  );
}

function Header({ Icon, dir, pill, pillClass }: { Icon: typeof Sunrise; dir: { label: string; sub: string }; pill: string; pillClass: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="!bg-[#ffb300]/15 p-2 rounded-xl shrink-0"><Icon className="w-5 h-5 !text-[#b57e00]" /></div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold !text-[#2a2e34]">{dir.label}</div>
        <div className="text-[11px] !text-[#2a2e34]/50">{dir.sub}</div>
      </div>
      <span className={`text-[9px] font-black uppercase px-2 py-1 rounded shrink-0 ${pillClass}`}>{pill}</span>
    </div>
  );
}
