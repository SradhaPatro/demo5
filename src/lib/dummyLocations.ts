export interface DummyLocation {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  description: string;
}

export const DUMMY_LOCATIONS: DummyLocation[] = [
  { id: 'loc_1', name: 'Whitefield', city: 'Bengaluru', lat: 12.9698, lng: 77.7499, description: 'ITPB Tech Hub & Residential Area' },
  { id: 'loc_2', name: 'Bellandur', city: 'Bengaluru', lat: 12.9279, lng: 77.6771, description: 'Ecospace & Outer Ring Road Corridor' },
  { id: 'loc_3', name: 'Marathahalli', city: 'Bengaluru', lat: 12.9591, lng: 77.6674, description: 'Multiplex Junction & Tech Park Link' },
  { id: 'loc_4', name: 'Electronic City', city: 'Bengaluru', lat: 12.8399, lng: 77.6770, description: 'Phase 1 & Phase 2 IT Hubs' },
  { id: 'loc_5', name: 'Koramangala', city: 'Bengaluru', lat: 12.9352, lng: 77.6245, description: 'Startup Hub & Forum Corridor' },
  { id: 'loc_6', name: 'HSR Layout', city: 'Bengaluru', lat: 12.9121, lng: 77.6446, description: 'Sector 1 to Sector 7 Tech Belt' },
  { id: 'loc_7', name: 'Indiranagar', city: 'Bengaluru', lat: 12.9784, lng: 77.6408, description: '100ft Road Metro Hub' },
  { id: 'loc_8', name: 'Sarjapur', city: 'Bengaluru', lat: 12.9010, lng: 77.7013, description: 'Wipro Campus Corridor' },
  { id: 'loc_9', name: 'Hebbal', city: 'Bengaluru', lat: 13.0358, lng: 77.5970, description: 'Flyover Junction & Manyata Park Link' },
];

export function calculateDummyDistanceKm(loc1Name: string, loc2Name: string): number {
  if (!loc1Name || !loc2Name) return 8;
  const l1 = DUMMY_LOCATIONS.find(l => l.name.toLowerCase() === loc1Name.toLowerCase() || loc1Name.toLowerCase().includes(l.name.toLowerCase()));
  const l2 = DUMMY_LOCATIONS.find(l => l.name.toLowerCase() === loc2Name.toLowerCase() || loc2Name.toLowerCase().includes(l.name.toLowerCase()));
  
  if (l1 && l2) {
    if (l1.id === l2.id) return 3;
    const R = 6371; // Earth radius in km
    const dLat = (l2.lat - l1.lat) * Math.PI / 180;
    const dLng = (l2.lng - l1.lng) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(l1.lat * Math.PI / 180) * Math.cos(l2.lat * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const straightKm = R * c;
    return Math.max(3, Math.round(straightKm * 1.35 * 10) / 10);
  }
  
  const str = (loc1Name + '|' + loc2Name).toLowerCase();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 5 + (Math.abs(hash) % 18);
}
