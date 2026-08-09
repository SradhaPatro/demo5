import { useEffect, useMemo, useState } from 'react';
import { User, Subscription } from '../types';
import PlacePicker, { PlaceValue } from './PlacePicker';
import RouteMap from './RouteMap';
import PaymentSummary from './PaymentSummary';
import { startCheckout } from '../lib/checkout';
import { formatINR, calcHostSlab, calcHostEarningsProjection, type PlanType } from '../lib/pricing';
import { Loader, CheckCircle, Clock, Wallet, ArrowRight, TrendingUp, BadgeIndianRupee, Info, Play } from 'lucide-react';
import TripCard from './TripCard';
import { useTrip } from '../hooks/useTrip';
import { useLiveTracking } from '../hooks/useLiveTracking';
import { calculateCommuteDayInfo, formatTimeHHMM } from '../lib/commuteSchedule';

interface Props { currentUser: User; onRefreshWallet: () => void; }

interface HostMatch {
  id: string; direction: 'forward' | 'return'; proximityTierM: number; score: number;
  buddy: { id: string; name: string; avatarUrl: string; rating: number } | null;
}
interface Payout {
  hasActiveSubscription: boolean; planName?: string; totalDays?: number;
  eligibleActiveDays?: number; maxPayout?: number; payout: number; formula?: string;
}

// Earnings-projection labels. NOT purchasable plans — they only show how much a
// host could earn for that many active ride days. Display labels stay friendly.
const PROJECTIONS: { plan: PlanType; label: string; badge?: string }[] = [
  { plan: '7d', label: '7-Day Plan' },
  { plan: '15d', label: '15-Day Plan', badge: 'Popular' },
  { plan: '1m', label: 'Monthly Plan', badge: 'Best Value' },
];

export default function HostCommuteHub({ currentUser, onRefreshWallet }: Props) {
  const [sub, setSub] = useState<Subscription | null>(null);
  const [matches, setMatches] = useState<HostMatch[]>([]);
  const [payout, setPayout] = useState<Payout | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [confirming, setConfirming] = useState(false); // showing the activation payment summary
  const [distanceKm, setDistanceKm] = useState(0);
  const [distanceSource, setDistanceSource] = useState('');
  const [computing, setComputing] = useState(false);
  const [err, setErr] = useState('');
  const [matchBusy, setMatchBusy] = useState<string | null>(null);
  const [tripBusy, setTripBusy] = useState(false);

  const tripOps = useTrip(currentUser?.id);

  const handleBeginRide = async (tripId: string) => {
    setTripBusy(true);
    await tripOps.beginRide(tripId);
    setTripBusy(false);
  };

  const handleHostComplete = async (tripId: string) => {
    setTripBusy(true);
    await tripOps.hostCompleteRide(tripId);
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
    role: 'host',
    enabled: tripOps.activeTrip?.status === 'in_progress',
    originGeo: tripOps.activeTrip?.originGeo,
    destGeo: tripOps.activeTrip?.destGeo,
  });

  const [home, setHome] = useState<PlaceValue>({ address: '' });
  const [dest, setDest] = useState<PlaceValue>({ address: '' });
  const [forwardTime, setForwardTime] = useState('09:00');
  const [returnTime, setReturnTime] = useState('18:00');

  const load = async () => {
    try {
      const safeJson = (r: Response) => (r.ok && r.headers.get('content-type')?.includes('application/json') ? r.json().catch(() => null) : null);
      const [subs, m, p] = await Promise.all([
        fetch(`/api/subscriptions/${currentUser.id}`).then(safeJson),
        fetch(`/api/matches/${currentUser.id}`).then(safeJson),
        fetch(`/api/host/${currentUser.id}/payout`).then(safeJson),
      ]);
      const toArray = (data: any) => Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      const subList = toArray(subs);
      setSub(subList.find((s: Subscription) => s.role === 'host' && (s.status === 'active' || s.status === 'pending' || s.status === 'geocoding' || s.status === 'matching')) || null);
      setMatches(toArray(m));
      setPayout(p);
    } catch { /* offline */ } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [currentUser.id]);

  // Auto-calculate the real route distance once BOTH addresses are chosen.
  useEffect(() => {
    if (!home.address || !dest.address) { setDistanceKm(0); return; }
    let cancelled = false;
    setComputing(true);
    fetch('/api/distance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: home.address, destination: dest.address, originGeo: home.geo, destGeo: dest.geo }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.km) { setDistanceKm(d.km); setDistanceSource(d.source || ''); } })
      .catch(() => {})
      .finally(() => { if (!cancelled) setComputing(false); });
    return () => { cancelled = true; };
  }, [home.address, dest.address, home.geo?.lat, dest.geo?.lat]);

  const hasRoute = distanceKm > 0;
  const slab = useMemo(() => (hasRoute ? calcHostSlab(distanceKm) : 0), [distanceKm, hasRoute]);
  const projections = useMemo(
    () => PROJECTIONS.map(p => ({ ...p, ...calcHostEarningsProjection(distanceKm, p.plan) })),
    [distanceKm],
  );

  // "Pay & Activate" → branded summary → Razorpay → activate. The host pays the
  // FLAT slab; the active window is monthly (earnings accrue from real activity).
  const handlePay = async (): Promise<boolean> => {
    setErr(''); setPaying(true);
    const result = await startCheckout({
      planName: 'Monthly Plan', role: 'host', distanceKm,
      subDetails: { amountPaid: slab, origin: home.address, destination: dest.address, originGeo: home.geo, destGeo: dest.geo, forwardTime, returnTime },
    });
    setPaying(false);
    if (!result.success) { setErr(result.error || 'Payment failed'); return false; }
    await load(); onRefreshWallet();
    return true;
  };

  const startTodayTrip = async (matchId: string) => {
    setMatchBusy(matchId);
    await tripOps.startTrip(matchId);
    setMatchBusy(null);
  };

  if (loading) return <div className="flex justify-center py-20"><Loader className="w-6 h-6 animate-spin text-[#ffb300]" /></div>;

  // ── Activation payment summary (after "Pay & Activate") ──
  if (!sub && confirming) {
    return (
      <div className="max-w-3xl mx-auto">
        <PaymentSummary
          role="host"
          planName="Monthly Plan"
          amount={slab}
          distanceKm={distanceKm}
          origin={home.address}
          destination={dest.address}
          paying={paying}
          error={err}
          onPay={handlePay}
          onCancel={() => { setErr(''); setConfirming(false); load(); }}
        />
      </div>
    );
  }

  // ── Not activated: route form → slab fee + earnings projections → activate ──
  if (!sub) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6 pb-32 space-y-5">
        <div className="text-center">
          <h2 className="text-2xl font-black !text-[#e9eaec]">Host Network</h2>
          <p className="text-sm !text-[#e9eaec]/60 mt-1">You pay a one-time activation fee (₹49 / ₹99) based on route distance — no plan to buy.</p>
        </div>
        {err && <div className="!bg-rose-950/60 border-l-4 border-rose-500 !text-rose-200 text-xs p-2.5 rounded">{err}</div>}

        {/* Route form — only Home, Destination, Departure Time */}
        <div className="!bg-[#2a2e34] border !border-[#ffb300]/15 rounded-2xl p-5 space-y-3">
          <div className="text-sm font-bold !text-[#e9eaec]">Set your route to join the matching network</div>
          <PlacePicker label="Home" placeholder="Your home address" value={home} onChange={setHome} />
          <PlacePicker label="Destination (Office / College)" placeholder="Where you commute to" value={dest} onChange={setDest} />
          {(home.geo || dest.geo) && (
            <div className="my-2">
              <RouteMap originGeo={home.geo} destinationGeo={dest.geo} originAddress={home.address} destinationAddress={dest.address} />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold !text-[#ffb300] uppercase tracking-wider mb-1"><Clock className="w-3 h-3 inline mr-1" />Morning time (Home → Office)</label>
              <input type="time" value={forwardTime} onChange={e => setForwardTime(e.target.value)} className="w-full !bg-[#1c1f22] border !border-[#ffb300]/25 rounded-xl py-2.5 px-3 !text-[#e9eaec] text-sm focus:outline-none focus:!border-[#ffb300]" />
            </div>
            <div>
              <label className="block text-xs font-semibold !text-[#ffb300] uppercase tracking-wider mb-1"><Clock className="w-3 h-3 inline mr-1" />Evening time (Office → Home)</label>
              <input type="time" value={returnTime} onChange={e => setReturnTime(e.target.value)} className="w-full !bg-[#1c1f22] border !border-[#ffb300]/25 rounded-xl py-2.5 px-3 !text-[#e9eaec] text-sm focus:outline-none focus:!border-[#ffb300]" />
            </div>
          </div>
          <div className="text-[11px] !text-[#e9eaec]/60">
            {computing ? 'Calculating route distance…' : hasRoute
              ? <>Route distance: <span className="!text-[#ffb300] font-bold">{distanceKm} km</span> {distanceSource === 'estimate' ? '(estimated — pick from suggestions for exact)' : '(auto-detected)'}</>
              : 'Enter Home & Destination to detect distance.'}
          </div>
        </div>

        {hasRoute && (
          <>
            {/* Slab fee — the only upfront charge */}
            <div className="!bg-[#2a2e34] border !border-[#ffb300]/30 rounded-2xl p-5 flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-[10px] uppercase font-bold !text-[#ffb300] tracking-widest"><BadgeIndianRupee className="w-3.5 h-3.5" /> Activation fee · one-time</div>
                <div className="text-3xl font-black !text-[#e9eaec] mt-1">{formatINR(slab)}</div>
                <div className="text-[11px] !text-[#e9eaec]/50 mt-0.5">{distanceKm <= 5 ? 'Route up to 5 km' : 'Route over 5 km'} · pay once to activate your ride offer</div>
              </div>
              <CheckCircle className="w-7 h-7 text-emerald-400 shrink-0" />
            </div>

            {/* Earnings projections — NOT plans */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 !text-[#ffb300]" />
                <h3 className="text-sm font-bold !text-[#e9eaec]">Your potential earnings</h3>
                <span className="text-[10px] !text-[#e9eaec]/40">if you stay active for…</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {projections.map(p => (
                  <button
                    key={p.plan}
                    type="button"
                    onClick={() => { setErr(''); setConfirming(true); }}
                    className={`text-left !bg-[#2a2e34] border rounded-2xl p-4 transition-colors cursor-pointer hover:!border-[#ffb300] ${p.badge === 'Popular' ? '!border-[#ffb300]/60' : '!border-[#ffb300]/15'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-black !text-[#e9eaec]">{p.label}</span>
                      {p.badge && <span className={`text-[8px] font-black uppercase px-1.5 py-0.5 rounded-full ${p.badge === 'Popular' ? '!bg-[#ffb300] !text-[#2a2e34]' : '!bg-[#1c1f22] !text-[#ffb300] border !border-[#ffb300]/30'}`}>{p.badge}</span>}
                    </div>
                    <div className="text-[10px] !text-[#e9eaec]/50 mt-0.5">{p.activeDays} active ride days</div>
                    <div className="text-2xl font-black !text-[#ffb300] mt-2">{formatINR(p.total)}</div>
                    <div className="text-[9px] !text-[#e9eaec]/40 uppercase tracking-wide">projected earnings</div>
                    <div className="mt-2 pt-2 border-t !border-[#ffb300]/10 space-y-0.5 text-[10px] !text-[#e9eaec]/60">
                      <div className="flex justify-between"><span>Ride earnings</span><span>{formatINR(p.rideEarnings)}</span></div>
                      <div className="flex justify-between"><span>Slab incentive</span><span>{formatINR(p.slabIncentive)}</span></div>
                    </div>
                    <div className="mt-3 flex items-center justify-center gap-1 text-[10px] font-bold !text-[#ffb300] !bg-[#ffb300]/10 rounded-lg py-1.5">
                      Tap to activate · {formatINR(slab)} once <ArrowRight className="w-3 h-3" />
                    </div>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] !text-[#e9eaec]/50 flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 !text-[#ffb300]/70" />
                The cards are earnings ESTIMATES, not different plans — you pay the same one-time {formatINR(slab)} fee whichever you tap. Earnings = ₹3.5/km × distance × active ride days + a slab incentive that grows with activity (full slab at ~22 active days), paid from rides you actually complete.
              </p>
            </div>

            <button
              onClick={() => { setErr(''); setConfirming(true); }}
              disabled={confirming}
              className="w-full !bg-[#ffb300] hover:!bg-[#e09d00] !text-[#2a2e34] py-3 rounded-xl text-sm font-black flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {confirming ? <Loader className="w-4 h-4 animate-spin" /> : null}
              Pay {formatINR(slab)} &amp; Activate Ride Offer <ArrowRight className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    );
  }

  // Calculate active working commute day info
  const dayInfo = calculateCommuteDayInfo(sub);

  // ── Active host + payout + day-based commute schedule ──
  return (
    <div className="max-w-3xl mx-auto px-4 py-6 pb-32 space-y-5">
      <div className="text-center">
        <h2 className="text-2xl font-black !text-[#e9eaec]">Host Commute Dashboard</h2>
        <p className="text-sm !text-[#e9eaec]/60 mt-1">Your active commute plan & schedule</p>
      </div>

      {/* Commute Plan Header & Active Day Counter */}
      <div className="!bg-gradient-to-r from-[#2a2e34] to-[#1c1f22] border !border-[#ffb300]/30 rounded-2xl p-5 shadow-lg space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[10px] font-black uppercase tracking-widest !text-[#ffb300] bg-[#ffb300]/10 px-2.5 py-1 rounded-full border border-[#ffb300]/20">
              {dayInfo.planName}
            </span>
            <div className="text-2xl font-black !text-[#e9eaec] mt-1.5">
              Day {dayInfo.currentDay} <span className="text-sm font-semibold !text-[#e9eaec]/60">of {dayInfo.totalDays} active days</span>
            </div>
            <div className="text-xs !text-[#e9eaec]/60 mt-0.5">{dayInfo.formattedDate} {dayInfo.isWeekend ? '(Weekend • Non-commute day)' : ''}</div>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-bold">
              <CheckCircle className="w-4 h-4" /> Ride Offer Active
            </div>
            <div className="text-[11px] !text-[#e9eaec]/50 mt-1">{sub?.origin} ⇄ {sub?.destination}</div>
          </div>
        </div>

        {/* Timeline Progress Bar */}
        <div className="pt-2">
          <div className="flex justify-between text-[10px] font-bold !text-[#e9eaec]/60 mb-1.5">
            <span className="!text-[#ffb300]">Today (Day {dayInfo.currentDay})</span>
            <span>Day {Math.min(dayInfo.totalDays, dayInfo.currentDay + 1)}</span>
            <span>Day {Math.min(dayInfo.totalDays, dayInfo.currentDay + 2)}</span>
            <span>Day {dayInfo.totalDays}</span>
          </div>
          <div className="w-full bg-[#1c1f22] h-2 rounded-full overflow-hidden border border-[#ffb300]/20 flex">
            <div
              className="bg-gradient-to-r from-[#ffb300] to-emerald-400 h-full rounded-full transition-all duration-500"
              style={{ width: `${(dayInfo.currentDay / dayInfo.totalDays) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* Active trip card if trip currently ongoing */}
      {tripOps.activeTrip && (
        <TripCard
          trip={tripOps.activeTrip}
          role="host"
          onBeginRide={handleBeginRide}
          onHostComplete={handleHostComplete}
          onCancelTrip={handleCancelTrip}
          busy={tripBusy}
          error={tripOps.error}
        />
      )}

      {/* Activity-Based Payout Summary */}
      {payout && (
        <div className="!bg-[#2a2e34] border !border-[#ffb300]/15 rounded-2xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-[#ffb300]/10 border border-[#ffb300]/20 text-[#ffb300]">
              <Wallet className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs font-bold !text-[#e9eaec]">Activity-Based Payout Projection</div>
              <div className="text-xl font-black !text-[#ffb300]">{formatINR(payout.payout)}</div>
              <div className="text-[10px] !text-[#e9eaec]/50">{payout.formula || `${payout.eligibleActiveDays}/${payout.totalDays} active days completed`}</div>
            </div>
          </div>
        </div>
      )}

      {/* Today's Commute Schedule (Morning & Evening) */}
      <div className="!bg-[#2a2e34] border !border-[#ffb300]/20 rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between border-b border-[#ffb300]/10 pb-3">
          <div className="text-sm font-bold !text-[#e9eaec] flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#ffb300]" /> Today's Commute Schedule
          </div>
          <span className="text-[11px] font-bold !text-[#ffb300]">Day {dayInfo.currentDay} / {dayInfo.totalDays}</span>
        </div>

        {matches.length === 0 ? (
          <div className="text-xs !text-[#e9eaec]/50 py-4 text-center">
            No guests matched yet. We'll assign compatible riders on your route automatically.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {matches.map(m => {
              const isMorning = m.direction === 'forward';
              const legTime = isMorning ? (sub?.forwardTime || '09:00') : (sub?.returnTime || '18:00');
              const legOrigin = isMorning ? sub?.origin : sub?.destination;
              const legDest = isMorning ? sub?.destination : sub?.origin;

              return (
                <div key={m.id} className="!bg-[#1c1f22] rounded-xl p-4 border !border-[#ffb300]/15 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${isMorning ? 'bg-amber-500/20 text-amber-300' : 'bg-indigo-500/20 text-indigo-300'}`}>
                        {isMorning ? '🌅 Morning Leg' : '🌆 Evening Leg'}
                      </span>
                      <span className="text-xs font-mono font-bold text-[#e9eaec]">{formatTimeHHMM(legTime)}</span>
                    </div>
                    <span className="text-[10px] text-emerald-400 font-semibold">Match {m.score}%</span>
                  </div>

                  <div className="text-xs text-[#e9eaec]/80 flex items-center gap-2">
                    <span className="font-semibold text-emerald-400">{legOrigin}</span>
                    <ArrowRight className="w-3 h-3 text-[#ffb300] shrink-0" />
                    <span className="font-semibold text-rose-400">{legDest}</span>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[#ffb300]/10">
                    <div className="flex items-center gap-2.5">
                      {m.buddy ? (
                        <img src={m.buddy.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover border border-[#ffb300]" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-[#2a2e34] border border-[#ffb300]/30 flex items-center justify-center text-xs font-bold text-[#ffb300]">G</div>
                      )}
                      <div>
                        <div className="text-xs font-bold !text-[#e9eaec]">{m.buddy?.name || 'Assigned Guest'}</div>
                        <div className="text-[10px] !text-[#e9eaec]/50">Guest Rider · within {m.proximityTierM}m</div>
                      </div>
                    </div>

                    {!tripOps.activeTrip && (
                      <button
                        onClick={() => startTodayTrip(m.id)}
                        disabled={matchBusy === m.id}
                        className="!bg-[#ffb300] hover:!bg-[#e09d00] !text-[#2a2e34] text-xs font-black px-4 py-2 rounded-xl flex items-center gap-1.5 shadow disabled:opacity-60"
                      >
                        {matchBusy === m.id ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                        Start {isMorning ? 'Morning' : 'Evening'} Commute
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Day-based Timeline / Upcoming Schedule Preview */}
      <div className="!bg-[#2a2e34] border !border-[#ffb300]/15 rounded-2xl p-5 space-y-3">
        <div className="text-xs font-bold uppercase tracking-wider text-[#ffb300]">Upcoming Commute Schedule</div>
        <div className="space-y-2">
          <div className="!bg-[#1c1f22] p-3 rounded-xl flex items-center justify-between text-xs text-[#e9eaec]/70">
            <div>
              <span className="font-bold text-[#e9eaec]">Tomorrow (Day {Math.min(dayInfo.totalDays, dayInfo.currentDay + 1)})</span>
              <div className="text-[10px] text-[#e9eaec]/50 mt-0.5">Morning {formatTimeHHMM(sub?.forwardTime)} • Evening {formatTimeHHMM(sub?.returnTime)}</div>
            </div>
            <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20 font-semibold">Scheduled</span>
          </div>
          <div className="!bg-[#1c1f22] p-3 rounded-xl flex items-center justify-between text-xs text-[#e9eaec]/50">
            <div>
              <span className="font-bold text-[#e9eaec]/80">Day {Math.min(dayInfo.totalDays, dayInfo.currentDay + 2)}</span>
              <div className="text-[10px] text-[#e9eaec]/40 mt-0.5">Morning {formatTimeHHMM(sub?.forwardTime)} • Evening {formatTimeHHMM(sub?.returnTime)}</div>
            </div>
            <span className="text-[10px] bg-[#2a2e34] text-[#e9eaec]/50 px-2 py-0.5 rounded border border-[#ffb300]/10">Upcoming</span>
          </div>
        </div>
      </div>
    </div>
  );
}
