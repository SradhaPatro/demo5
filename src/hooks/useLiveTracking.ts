import { useEffect, useRef, useCallback } from "react";
import { getSocket, connectSocket } from "../lib/socket";
import { haversineMeters } from "../lib/geo";
import type { SocketTripPingPayload, SocketTripHeartbeatPayload, GeoPoint } from "../types";

/**
 * SIMULATED GPS CONFIGURATION FOR DEMO / PROTOTYPE
 * Set `USE_SIMULATED_GPS = true` to use simulated route movement without requesting browser GPS permissions.
 * Set `USE_SIMULATED_GPS = false` to switch back to real browser `navigator.geolocation.watchPosition()`.
 */
export const USE_SIMULATED_GPS = true;

export type GpsStatus = "idle" | "waiting_socket" | "starting" | "active" | "failed" | "paused";

interface UseLiveTrackingOptions {
  tripId: string | undefined;
  userId: string | undefined;
  role: "host" | "guest";
  enabled: boolean;
  originGeo?: GeoPoint;
  destGeo?: GeoPoint;
  onStatusChange?: (status: GpsStatus) => void;
  onGpsError?: (message: string) => void;
}

const MIN_PING_INTERVAL_MS = 2000;
const MIN_MOVE_METERS = 5;
const HEARTBEAT_INTERVAL_MS = 30000;
const STALE_THRESHOLD_MS = 60000;
const PING_INTERVAL_MS = 3000;

export function useLiveTracking({ tripId, userId, role, enabled, originGeo, destGeo, onStatusChange, onGpsError }: UseLiveTrackingOptions) {
  const watchIdRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastGeoRef = useRef<{ lat: number; lng: number } | null>(null);
  const lastEmitMsRef = useRef(0);
  const gpsStartedRef = useRef(false);
  const socketReadyRef = useRef(false);
  const statusRef = useRef<GpsStatus>("idle");
  const simProgressRef = useRef(0);

  // Stabilise callback refs so effects don't re-run when parent passes inline fns.
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onGpsErrorRef = useRef(onGpsError);
  onGpsErrorRef.current = onGpsError;

  const setStatus = useCallback((s: GpsStatus) => {
    if (statusRef.current === s) return;
    statusRef.current = s;
    onStatusChangeRef.current?.(s);
  }, []);

  const clearAll = useCallback(() => {
    if (watchIdRef.current != null) {
      try { navigator.geolocation.clearWatch(watchIdRef.current); } catch { /* ignore */ }
      watchIdRef.current = null;
    }
    if (intervalRef.current != null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (heartbeatRef.current != null) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    gpsStartedRef.current = false;
    lastGeoRef.current = null;
    simProgressRef.current = 0;
  }, []);

  const stop = useCallback(() => {
    clearAll();
    setStatus("idle");
  }, [clearAll]);

  // Track socket connection state
  useEffect(() => {
    const socket = connectSocket();
    if (socket.connected) {
      socketReadyRef.current = true;
      return;
    }
    const onConnect = () => { socketReadyRef.current = true; };
    const onDisconnect = () => { socketReadyRef.current = false; };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, []);

  // Main GPS lifecycle
  useEffect(() => {
    if (!enabled || !tripId || !userId) {
      stop();
      return;
    }

    if (!socketReadyRef.current) {
      setStatus("waiting_socket");
      return;
    }

    const socket = getSocket();
    if (!socket?.connected) {
      setStatus("waiting_socket");
      return;
    }

    setStatus("starting");

    const emitPing = (geo: { lat: number; lng: number }) => {
      if (!socket?.connected) return;
      const now = Date.now();
      const lastEmit = lastEmitMsRef.current;
      if (lastEmit > 0 && now - lastEmit < MIN_PING_INTERVAL_MS && !USE_SIMULATED_GPS) {
        const lastGeo = lastGeoRef.current;
        if (lastGeo && haversineMeters(geo, lastGeo) < MIN_MOVE_METERS) return;
      }
      lastEmitMsRef.current = now;
      const payload: SocketTripPingPayload = { tripId, geo };
      socket.emit("trip:ping", payload);
    };

    if (USE_SIMULATED_GPS) {
      // ── DEMO/SIMULATED GPS (No real browser geolocation required) ──
      gpsStartedRef.current = true;
      setStatus("active");

      const startPoint = (originGeo?.lat && originGeo?.lng)
        ? { lat: originGeo.lat, lng: originGeo.lng }
        : { lat: 12.9352, lng: 77.6245 }; // Default Koramangala
      const endPoint = (destGeo?.lat && destGeo?.lng)
        ? { lat: destGeo.lat, lng: destGeo.lng }
        : { lat: 12.9784, lng: 77.6408 }; // Default Indiranagar

      // Emit initial position immediately
      const initialGeo = {
        lat: startPoint.lat + (endPoint.lat - startPoint.lat) * simProgressRef.current,
        lng: startPoint.lng + (endPoint.lng - startPoint.lng) * simProgressRef.current,
      };
      lastGeoRef.current = initialGeo;
      emitPing(initialGeo);

      // Advance location along demo route every PING_INTERVAL_MS
      intervalRef.current = setInterval(() => {
        simProgressRef.current = (simProgressRef.current + 0.05) % 1.0;
        const currentGeo = {
          lat: startPoint.lat + (endPoint.lat - startPoint.lat) * simProgressRef.current,
          lng: startPoint.lng + (endPoint.lng - startPoint.lng) * simProgressRef.current,
        };
        lastGeoRef.current = currentGeo;
        if (socket?.connected) {
          emitPing(currentGeo);
        }
      }, PING_INTERVAL_MS);

    } else {
      // ── REAL GPS (Browser navigator.geolocation) ──
      if ("geolocation" in navigator) {
        gpsStartedRef.current = false;

        watchIdRef.current = navigator.geolocation.watchPosition(
          (pos) => {
            const geo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            lastGeoRef.current = geo;
            if (!gpsStartedRef.current) {
              gpsStartedRef.current = true;
              setStatus("active");
            }
            emitPing(geo);
          },
          (err) => {
            const msgs: Record<number, string> = {
              [err.PERMISSION_DENIED]: "GPS permission denied",
              [err.POSITION_UNAVAILABLE]: "GPS position unavailable",
              [err.TIMEOUT]: "GPS request timed out",
            };
            const msg = msgs[err.code] || `GPS error: ${err.message}`;
            console.warn("[gps] watchPosition error:", msg);
            onGpsErrorRef.current?.(msg);
            setStatus("failed");
          },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
        );
      } else {
        onGpsErrorRef.current?.("Geolocation not available in this browser");
        setStatus("failed");
      }

      intervalRef.current = setInterval(() => {
        if (lastGeoRef.current && socket?.connected) {
          emitPing(lastGeoRef.current);
        }
      }, PING_INTERVAL_MS);
    }

    // ── Heartbeat monitor ──────────────────────────────────────────
    heartbeatRef.current = setInterval(() => {
      const lastEmit = lastEmitMsRef.current;
      const age = lastEmit > 0 ? (Date.now() - lastEmit) / 1000 : 0;
      const status: SocketTripHeartbeatPayload["status"] =
        !socketReadyRef.current ? "offline"
        : (!gpsStartedRef.current || lastEmit === 0) ? (statusRef.current === "failed" ? "offline" : "active")
        : age > STALE_THRESHOLD_MS / 1000 ? "gps_failed"
        : "active";

      const hb: SocketTripHeartbeatPayload = {
        tripId,
        status,
        lastPingAge: Math.round(age),
      };
      socket?.emit("trip:heartbeat", hb);
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      clearAll();
    };
  }, [tripId, userId, role, enabled, originGeo, destGeo, stop, clearAll]);

  // ── Browser visibility ───────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !tripId || USE_SIMULATED_GPS) return;

    const handleVisibility = () => {
      if (document.hidden) {
        // Tab hidden — pause GPS watcher to save battery
        if (watchIdRef.current != null) {
          try { navigator.geolocation.clearWatch(watchIdRef.current); } catch { /* */ }
          watchIdRef.current = null;
        }
        setStatus("paused");
      } else {
        // Tab visible — resume GPS
        if (watchIdRef.current == null && "geolocation" in navigator) {
          setStatus("starting");
          watchIdRef.current = navigator.geolocation.watchPosition(
            (pos) => {
              const geo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
              lastGeoRef.current = geo;
              gpsStartedRef.current = true;
              setStatus("active");
              if (getSocket()?.connected) {
                const payload: SocketTripPingPayload = { tripId, geo };
                getSocket()!.emit("trip:ping", payload);
              }
            },
            (err) => {
              console.warn("[gps] watchPosition error after resume:", err.message);
              onGpsErrorRef.current?.(`GPS error after resume: ${err.message}`);
              setStatus("failed");
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
          );
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, tripId]);

  // ── Page unload ──────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !tripId) return;
    const handlePageHide = () => { stop(); };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [enabled, tripId, stop]);

  // ── Online / Offline ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !tripId) return;

    const handleOnline = () => {
      // Re-send last known position immediately when back online
      if (lastGeoRef.current && getSocket()?.connected) {
        const payload: SocketTripPingPayload = { tripId, geo: lastGeoRef.current };
        getSocket()!.emit("trip:ping", payload);
      }
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [enabled, tripId]);
}

