interface CounterState {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
}

interface RateLimitConfig {
  windowMs: number;
  maxAttempts: number;
  blockMs: number;
}

const buckets = new Map<string, CounterState>();

function nowMs() {
  return Date.now();
}

export function consumeRateLimit(key: string, config: RateLimitConfig) {
  const now = nowMs();
  const current = buckets.get(key);

  if (!current) {
    buckets.set(key, {
      count: 1,
      windowStartedAt: now,
      blockedUntil: 0,
    });
    return {
      allowed: true,
      remaining: Math.max(config.maxAttempts - 1, 0),
      retryAfterSeconds: 0,
    };
  }

  if (current.blockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((current.blockedUntil - now) / 1000),
    };
  }

  if (now - current.windowStartedAt > config.windowMs) {
    current.count = 0;
    current.windowStartedAt = now;
    current.blockedUntil = 0;
  }

  current.count += 1;

  if (current.count > config.maxAttempts) {
    current.blockedUntil = now + config.blockMs;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil(config.blockMs / 1000),
    };
  }

  return {
    allowed: true,
    remaining: Math.max(config.maxAttempts - current.count, 0),
    retryAfterSeconds: 0,
  };
}

export function clearRateLimit(key: string) {
  buckets.delete(key);
}

export function clearAllRateLimits() {
  buckets.clear();
}

