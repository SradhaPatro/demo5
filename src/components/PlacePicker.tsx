import React, { useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import type { GeoPoint } from '../types';
import { DUMMY_LOCATIONS, DummyLocation } from '../lib/dummyLocations';

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
  const [suggestions, setSuggestions] = useState<DummyLocation[]>(DUMMY_LOCATIONS);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value.address || ''); }, [value.address]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const handleInput = (text: string) => {
    setQuery(text);
    const q = text.toLowerCase().trim();
    const filtered = DUMMY_LOCATIONS.filter(loc =>
      loc.name.toLowerCase().includes(q) ||
      loc.city.toLowerCase().includes(q) ||
      loc.description.toLowerCase().includes(q)
    );
    setSuggestions(filtered.length > 0 ? filtered : DUMMY_LOCATIONS);
    setOpen(true);
    // Find exact or partial match for coordinates
    const matched = DUMMY_LOCATIONS.find(loc => loc.name.toLowerCase() === q);
    onChange({
      address: text,
      geo: matched ? { lat: matched.lat, lng: matched.lng } : undefined
    });
  };

  const selectSuggestion = (loc: DummyLocation) => {
    const fullAddress = `${loc.name}, ${loc.city}`;
    setOpen(false);
    setQuery(fullAddress);
    onChange({
      address: fullAddress,
      geo: { lat: loc.lat, lng: loc.lng }
    });
  };

  return (
    <div ref={boxRef} className="relative">
      <label className="block text-xs font-semibold !text-[#b57e00] uppercase tracking-wider mb-1">{label}</label>
      <div className="relative">
        <MapPin className="absolute left-3 top-3 w-4 h-4 !text-[#2a2e34]/40 z-10" />
        <input
          type="text"
          placeholder={placeholder || 'Search address (e.g. Whitefield, Bellandur)'}
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={() => { setSuggestions(DUMMY_LOCATIONS); setOpen(true); }}
          autoComplete="off"
          style={{ paddingLeft: '2.5rem' }}
          className="w-full !bg-[#eef0f3] border !border-[#ffb300]/25 rounded-xl py-2.5 !pl-10 pr-4 !text-[#2a2e34] placeholder-[#2a2e34]/40 text-sm focus:outline-none focus:!border-[#ffb300]"
        />
      </div>

      {open && suggestions.length > 0 && (
        <div className="absolute z-30 left-0 right-0 mt-1 !bg-white border !border-[#ffb300]/25 rounded-xl shadow-2xl overflow-hidden max-h-56 overflow-y-auto">
          {suggestions.map((loc) => (
            <button
              key={loc.id}
              type="button"
              onClick={() => selectSuggestion(loc)}
              className="w-full text-left px-3 py-2 text-xs !text-[#2a2e34] hover:!bg-[#ffb300]/10 flex items-start gap-2 border-b !border-[#ffb300]/5 last:border-0"
            >
              <MapPin className="w-3.5 h-3.5 !text-[#b57e00] mt-0.5 shrink-0" />
              <div>
                <div className="font-bold">{loc.name}, {loc.city}</div>
                <div className="text-[10px] !text-[#2a2e34]/50">{loc.description}</div>
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
