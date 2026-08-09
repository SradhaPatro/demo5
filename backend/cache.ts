interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}


interface CacheOptions {
  maxSize: number;
  defaultTTL: number;
}

export class TtlCache<T = unknown> {
  private store = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private defaultTTL: number;
  private name: string;

  constructor(name: string, opts: Partial<CacheOptions> = {}) {
    this.name = name;
    this.maxSize = opts.maxSize ?? 2000;
    this.defaultTTL = opts.defaultTTL ?? 60_000;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttl?: number): void {
    if (this.store.size >= this.maxSize) this.evict();
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttl ?? this.defaultTTL),
    });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private evict(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of this.store) {
      if (v.expiresAt < oldestTime) {
        oldestTime = v.expiresAt;
        oldest = k;
      }
    }
    if (oldest) this.store.delete(oldest);
  }
}

export async function cacheGet<T>(_prefix: string, _key: string): Promise<T | undefined> {
  return undefined;
}

export async function cacheSet<T>(_prefix: string, _key: string, _value: T, _ttl: number): Promise<void> {}

export async function cacheDel(_prefix: string, _key: string): Promise<void> {}

export async function cacheClear(_prefix: string): Promise<void> {}

