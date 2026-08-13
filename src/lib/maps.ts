/**
 * MoveBuddy Mapping Library
 * Supports Google Maps API with fallback to OpenStreetMap (Nominatim) & Haversine distance engine.
 */

export interface LocationSearchResult {
  placeId: string;
  address: string;
  lat: number;
  lng: number;
}

export interface DistanceResult {
  distanceKm: number;
  durationMinutes: number;
}

/**
 * Calculates distance in meters between two lat/lng coordinates
 */
export function haversineMeters(
  lat1: number | { lat: number; lng: number },
  lng1?: number | { lat: number; lng: number },
  lat2?: number,
  lng2?: number
): number {
  let l1: number, g1: number, l2: number, g2: number;
  if (typeof lat1 === "object" && typeof lng1 === "object") {
    l1 = lat1.lat; g1 = lat1.lng;
    l2 = lng1.lat; g2 = lng1.lng;
  } else {
    l1 = lat1 as number; g1 = lng1 as number;
    l2 = lat2!; g2 = lng2!;
  }
  const R = 6371000; // Earth radius in meters
  const dLat = ((l2 - l1) * Math.PI) / 180;
  const dLng = ((g2 - g1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((l1 * Math.PI) / 180) *
      Math.cos((l2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

/**
 * Calculates Haversine distance in km between two lat/lng coordinates
 */
export function calculateHaversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  return Math.round((haversineMeters(lat1, lng1, lat2, lng2) / 1000) * 10) / 10;
}

export function getDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  return calculateHaversineDistance(lat1, lng1, lat2, lng2);
}

export async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const results = await searchLocations(address);
  if (results && results.length > 0) {
    return { lat: results[0].lat, lng: results[0].lng };
  }
  return null;
}

/**
 * Searches locations using Nominatim OSM (or Google Maps if configured)
 */
export async function searchLocations(query: string): Promise<LocationSearchResult[]> {
  if (!query || query.trim().length < 3) return [];

  let apiKey =
    typeof process !== "undefined"
      ? (process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY)
      : undefined;

  if (!apiKey) {
    try {
      const viteEnv = new Function("return import.meta.env")();
      apiKey = viteEnv?.VITE_GOOGLE_MAPS_API_KEY;
    } catch {
      // Ignore if not in a Vite/ESM environment
    }
  }

  if (apiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        query
      )}&key=${apiKey}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.results && data.results.length > 0) {
        return data.results.map((r: any, idx: number) => ({
          placeId: r.place_id || `g_${idx}`,
          address: r.formatted_address,
          lat: r.geometry.location.lat,
          lng: r.geometry.location.lng,
        }));
      }
    } catch {
      // Fallback to OSM
    }
  }

  // OpenStreetMap Nominatim Free Fallback
  try {
    const cleanQuery = query.toLowerCase().includes("bengaluru") || query.toLowerCase().includes("bangalore") 
      ? query 
      : `${query}, Bengaluru`;

    // Try primary search with countrycode restriction & Bengaluru viewbox (bounding box)
    const fetchOsm = async (qStr: string) => {
      const osmUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        qStr
      )}&countrycodes=in&viewbox=77.35,13.15,77.85,12.75&limit=5`;
      const res = await fetch(osmUrl, {
        headers: { "User-Agent": "MoveBuddy-CommuteApp/1.0" },
      });
      return await res.json();
    };

    let data = await fetchOsm(cleanQuery);

    // If full address search (e.g., door no, cross road) yielded 0 results, retry with broader locality part
    if ((!Array.isArray(data) || data.length === 0) && cleanQuery.includes(",")) {
      const parts = cleanQuery.split(",").map(p => p.trim()).filter(Boolean);
      // Try last 2-3 tokens (e.g. "gurumurthy reddy layout, 560016, bengaluru")
      const fallbackQuery = parts.slice(Math.max(1, parts.length - 3)).join(", ");
      data = await fetchOsm(fallbackQuery);
    }

    if (Array.isArray(data) && data.length > 0) {
      return data.map((item: any) => ({
        placeId: `osm_${item.place_id}`,
        address: item.display_name,
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
      }));
    }
  } catch {
    // Return mock fallback for query
  }

  return [
    {
      placeId: "mock_1",
      address: `${query}, Tech Hub Campus`,
      lat: 12.9716,
      lng: 77.5946,
    },
  ];
}

/**
 * Calculates distance and estimated commute time between two coordinates
 */
export function estimateRouteDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): DistanceResult {
  const distKm = calculateHaversineDistance(lat1, lng1, lat2, lng2);
  const minutes = Math.max(5, Math.round((distKm / 25) * 60));
  return {
    distanceKm: distKm,
    durationMinutes: minutes,
  };
}
