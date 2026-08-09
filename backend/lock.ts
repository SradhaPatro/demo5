import { randomUUID } from "crypto";

const locks = new Map<string, { owner: string; acquiredAt: number }>();
const LOCK_TTL_MS = 120_000;

export async function acquireLock(
  key: string,
  ttlMs: number = LOCK_TTL_MS,
  retryDelayMs: number = 100,
  maxRetries?: number
): Promise<string | null> {
  const actualMaxRetries = maxRetries ?? Math.ceil(ttlMs / retryDelayMs);
  const owner = randomUUID();
  for (let attempt = 0; attempt < actualMaxRetries; attempt++) {
    const existing = locks.get(key);
    if (!existing || Date.now() - existing.acquiredAt > ttlMs) {
      locks.set(key, { owner, acquiredAt: Date.now() });
      return owner;
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  return null;
}

export async function releaseLock(key: string, owner: string): Promise<void> {
  const existing = locks.get(key);
  if (existing?.owner === owner) {
    locks.delete(key);
  }
}

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs: number = LOCK_TTL_MS
): Promise<T> {
  const owner = await acquireLock(key, ttlMs);
  if (!owner) {
    throw new Error(`Could not acquire lock for key: ${key}`);
  }
  try {
    return await fn();
  } finally {
    await releaseLock(key, owner);
  }
}

