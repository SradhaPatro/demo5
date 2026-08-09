// Offline Redis stub — in-memory fallback
export function getRedis(): null {
  return null;
}

export function isRedisConnected(): boolean {
  return false;
}

export async function closeRedis(): Promise<void> {}

