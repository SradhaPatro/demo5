import React, { useEffect, useRef, useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';
import type { GeoPoint } from '../types';
import { DUMMY_LOCATIONS, DummyLocation } from '../lib/dummyLocations';
import { searchLocations, LocationSearchResult } from '../lib/maps';

export interface PlaceValue {
  address: string;
  geo?: GeoPoint;
}

interface PlacePickerProps {
  label: string;
  placeholder?: string;
  value: PlaceValue;
  onChange: (v: PlaceValue) => void;
}

export default function PlacePicker({ label, placeholder, value, onChange }: PlacePickerProps) {
  const [query, setQuery] = useState(value.address || '');
  const [suggestions, setSuggestions] = useState<LocationSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<any>(null);

  useEffect(() => { setQuery(value.address || ''); }, [value.address]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleInput = (text: string) => {
    setQuery(text);
    onChange({ address: text });

    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    if (!text || text.trim().length < 3) {
      setSuggestions(DUMMY_LOCATIONS.map(loc => ({
        placeId: loc.id,
        address: `${loc.name}, ${loc.city}`,
        lat: loc.lat,
        lng: loc.lng,
      })));
      setOpen(true);
      return;
    }

    setLoading(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const results = await searchLocations(text);
        if (results && results.length > 0) {
          setSuggestions(results);
        } else {
          // Fallback to local dummy filtering
          const q = text.toLowerCase().trim();
          const filtered = DUMMY_LOCATIONS.filter(loc =>
            loc.name.toLowerCase().includes(q) ||
            loc.city.toLowerCase().includes(q) ||
            loc.description.toLowerCase().includes(q)
          ).map(loc => ({
            placeId: loc.id,
            address: `${loc.name}, ${loc.city}`,
            lat: loc.lat,
            lng: loc.lng,
          }));
          setSuggestions(filtered);
        }
      } catch {
        // Fallback
      } finally {
        setLoading(false);
        setOpen(true);
      }
    }, 300);
  };

  const selectSuggestion = (item: LocationSearchResult) => {
    setOpen(false);
    setQuery(item.address);
    onChange({
      address: item.address,
      geo: { lat: item.lat, lng: item.lng }
    });
  };

  return (
    <div ref={boxRef} className="relative">
      <label className="block text-xs font-semibold !text-[#b57e00] uppercase tracking-wider mb-1">{label}</label>
      <div className="relative">
        {loading ? (
          <Loader2 className="absolute right-3 top-3 w-4 h-4 text-[#ffb300] animate-spin z-10" />
        ) : (
          <MapPin className="absolute left-3 top-3 w-4 h-4 !text-[#2a2e34]/40 z-10" />
        )}
        <input
          type="text"
          placeholder={placeholder || 'Search address (e.g. Whitefield, Bellandur)'}
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => {
            if (suggestions.length === 0) {
              setSuggestions(DUMMY_LOCATIONS.map(loc => ({
                placeId: loc.id,
                address: `${loc.name}, ${loc.city}`,
                lat: loc.lat,
                lng: loc.lng,
              })));
            }
            setOpen(true);
          }}
          autoComplete="off"
          style={{ paddingLeft: '2.5rem' }}
          className="w-full !bg-[#eef0f3] border !border-[#ffb300]/25 rounded-xl py-2.5 !pl-10 pr-4 !text-[#2a2e34] placeholder-[#2a2e34]/40 text-sm focus:outline-none focus:!border-[#ffb300]"
        />
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 !bg-white border !border-[#ffb300]/25 rounded-xl shadow-2xl overflow-hidden max-h-56 overflow-y-auto">
          {suggestions.map((item) => (
            <button
              key={item.placeId}
              type="button"
              onClick={() => selectSuggestion(item)}
              className="w-full text-left px-3 py-2.5 text-xs !text-[#2a2e34] hover:!bg-[#ffb300]/10 flex items-start gap-2 border-b !border-[#ffb300]/5 last:border-0"
            >
              <MapPin className="w-3.5 h-3.5 !text-[#b57e00] mt-0.5 shrink-0" />
              <div>
                <div className="font-bold">{item.address}</div>
                <div className="text-[10px] !text-[#2a2e34]/50">Lat: {item.lat.toFixed(4)}, Lng: {item.lng.toFixed(4)}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {value.geo && (
        <p className="text-[11px] !text-emerald-600/80 mt-1">📍 Address selected ({value.geo.lat.toFixed(4)}, {value.geo.lng.toFixed(4)})</p>
      )}
    </div>
  );
}
