import { randomUUID } from "crypto";
import type { GeoPoint } from "../src/types";
import { logger } from "./logger";
import { TtlCache, cacheGet, cacheSet } from "./cache";

const FALLBACK_KM = 8;
const ROUTE_CACHE_TTL = 3600_000;
const GEO_CACHE_TTL = 3600_000;

export interface DistanceResult {
  km: number;
  durationMin: number;
  source: "ors" | "estimate" | "haversine";
  fallbackReason?: string;
}

const cache = new TtlCache<DistanceResult>("route", { maxSize: 2000, defaultTTL: ROUTE_CACHE_TTL });
const geoCache = new TtlCache<GeoPoint>("geo", { maxSize: 2000, defaultTTL: GEO_CACHE_TTL });

export function mapsConfigured(): boolean {
  return !!process.env.OPENROUTESERVICE_API_KEY;
}

/**
 * Convert great-circle meters to estimated road km (× 1.35 winding factor).
 */
function haversineKm(origin: GeoPoint, destination: GeoPoint): number {
  const meters = haversineMeters(origin, destination);
  return Math.max(1, Math.round((meters / 1000) * 1.35 * 10) / 10);
}

/**
 * Try to geocode both addresses, then return a haversine-based road estimate.
 * Returns null if either address cannot be geocoded.
 */
async function estimateFromGeocode(origin: string, destination: string): Promise<{ km: number; durationMin: number } | null> {
  const [originGeo, destGeo] = await Promise.all([geocode(origin), geocode(destination)]);
  if (originGeo && destGeo) {
    const km = haversineKm(originGeo, destGeo);
    return { km, durationMin: Math.round(km * 3) };
  }
  return null;
}

const BANGALORE_HUBS: Record<string, GeoPoint> = {
  whitefield: { lat: 12.9698, lng: 77.7499 },
  bellandur: { lat: 12.9279, lng: 77.6771 },
  marathahalli: { lat: 12.9591, lng: 77.6674 },
  "electronic city": { lat: 12.8399, lng: 77.6770 },
  koramangala: { lat: 12.9352, lng: 77.6245 },
  "hsr layout": { lat: 12.9121, lng: 77.6446 },
  indiranagar: { lat: 12.9784, lng: 77.6408 },
  sarjapur: { lat: 12.9010, lng: 77.7013 },
  hebbal: { lat: 13.0358, lng: 77.5970 },
};

export async function geocode(address: string): Promise<GeoPoint | null> {
  if (!address) return null;
  const ck = address.trim().toLowerCase();
  for (const [name, pt] of Object.entries(BANGALORE_HUBS)) {
    if (ck.includes(name)) return pt;
  }
  // Deterministic local geocode fallback
  let hash = 0;
  for (let i = 0; i < ck.length; i++) {
    hash = ((hash << 5) - hash) + ck.charCodeAt(i);
    hash |= 0;
  }
  const latOffset = ((Math.abs(hash) % 100) - 50) / 1000;
  const lngOffset = ((Math.abs(hash >> 2) % 100) - 50) / 1000;
  return { lat: 12.93 + latOffset, lng: 77.62 + lngOffset };
}

export async function getDistanceKm(origin: string, destination: string): Promise<DistanceResult> {
  const o = origin?.trim().toLowerCase() || "";
  const d = destination?.trim().toLowerCase() || "";
  if (o && d && o === d) {
    return { km: 0, durationMin: 0, source: "estimate" };
  }
  const geo1 = await geocode(origin);
  const geo2 = await geocode(destination);
  if (geo1 && geo2) {
    const km = haversineKm(geo1, geo2);
    return { km, durationMin: Math.round(km * 2.5), source: "estimate" };
  }
  return { km: FALLBACK_KM, durationMin: FALLBACK_KM * 3, source: "estimate" };
}

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
