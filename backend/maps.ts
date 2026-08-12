import {
  calculateHaversineDistance,
  haversineMeters,
  getDistanceKm,
  geocode,
  searchLocations,
  estimateRouteDistance,
} from "../src/lib/maps";

export {
  calculateHaversineDistance,
  haversineMeters,
  getDistanceKm,
  geocode,
  searchLocations,
  estimateRouteDistance,
};

export interface DistanceRequest {
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
}

export function handleCalculateDistance(req: DistanceRequest) {
  const { originLat, originLng, destLat, destLng } = req;
  const distanceKm = calculateHaversineDistance(originLat, originLng, destLat, destLng);
  const durationMinutes = Math.max(5, Math.round((distanceKm / 25) * 60));

  return {
    success: true,
    distanceKm,
    durationMinutes,
  };
}
