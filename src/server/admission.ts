type Bucket = { tokens: number; lastAt: number };

export class AdmissionLimiter {
  private readonly buckets = new Map<string, Bucket>();
  allow(key: string, ratePerSecond: number, burst: number): boolean {
    const now = Date.now(); const current = this.buckets.get(key) ?? { tokens: burst, lastAt: now };
    const elapsed = Math.max(0, now - current.lastAt) / 1000;
    current.tokens = Math.min(burst, current.tokens + elapsed * ratePerSecond); current.lastAt = now;
    if (current.tokens < 1) { this.prune(now); this.buckets.set(key, current); return false; }
    current.tokens -= 1; this.buckets.set(key, current); this.prune(now); return true;
  }
  private prune(now: number): void { if (this.buckets.size < 10_000) return; for (const [key, bucket] of this.buckets) if (now - bucket.lastAt > 60_000) this.buckets.delete(key); }
}
