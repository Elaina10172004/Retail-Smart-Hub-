const desktopApiBaseUrl = typeof window !== 'undefined' ? window.desktopShell?.apiBaseUrl : undefined;
const viteApiBaseUrl = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL;
export const API_BASE_URL = desktopApiBaseUrl || viteApiBaseUrl || '/api';
const GET_CACHE_TTL_MS = 10_000;

let authTokenCache: string | null = null;
let tokenStoreInitialized = false;

interface GetCacheEntry<T = unknown> {
  expiresAt: number;
  value?: T;
  promise?: Promise<T>;
}

const getCache = new Map<string, GetCacheEntry>();

export function clearApiGetCache() {
  getCache.clear();
}

function hasDesktopTokenBridge() {
  return typeof window !== 'undefined' && Boolean(window.desktopShell?.auth);
}

async function loadTokenFromDesktopBridge() {
  if (!hasDesktopTokenBridge()) {
    return '';
  }

  try {
    return (await window.desktopShell!.auth.getToken()) || '';
  } catch {
    return '';
  }
}

export async function initializeAuthTokenStore() {
  if (tokenStoreInitialized) {
    return;
  }

  authTokenCache = await loadTokenFromDesktopBridge();
  tokenStoreInitialized = true;
}

export function getAuthToken() {
  return authTokenCache;
}

export async function setAuthToken(token: string) {
  const normalizedToken = token.trim();
  if (authTokenCache !== (normalizedToken || null)) {
    clearApiGetCache();
  }
  authTokenCache = normalizedToken || null;
  tokenStoreInitialized = true;

  if (!hasDesktopTokenBridge()) {
    return;
  }

  if (!normalizedToken) {
    await window.desktopShell!.auth.clearToken();
    return;
  }

  await window.desktopShell!.auth.setToken(normalizedToken);
}

export async function clearAuthToken() {
  await setAuthToken('');
}

function parseJson<T>(value: string): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function pickApiErrorMessage(parsedBody: unknown, rawBody: string) {
  if (parsedBody && typeof parsedBody === 'object') {
    const payload = parsedBody as {
      message?: unknown;
      detail?: unknown;
    };

    if (typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }

    if (typeof payload.detail === 'string' && payload.detail.trim()) {
      return payload.detail.trim();
    }

    if (payload.detail && typeof payload.detail === 'object') {
      const detailObject = payload.detail as { message?: unknown };
      if (typeof detailObject.message === 'string' && detailObject.message.trim()) {
        return detailObject.message.trim();
      }
      try {
        return JSON.stringify(payload.detail);
      } catch {
        return '';
      }
    }
  }

  return rawBody.trim();
}

async function executeRequest<T>(path: string, init: RequestInit | undefined, authToken: string | null, method: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(init?.headers || {}),
    },
  });

  const rawBody = await response.text();
  const parsedBody = parseJson<T & { message?: string; detail?: unknown }>(rawBody);

  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      void clearAuthToken();
      window.dispatchEvent(new Event('auth:expired'));
    }
    const reason = pickApiErrorMessage(parsedBody, rawBody) || response.statusText || 'Request failed';
    throw new Error(`${method} ${path} -> ${response.status} ${reason}`);
  }

  return (parsedBody as T) ?? ({} as T);
}

function shouldCacheGet(path: string, init?: RequestInit) {
  const method = (init?.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    return false;
  }
  if (init?.cache === 'no-store' || init?.cache === 'reload') {
    return false;
  }
  if (path.startsWith('/system/session') || path.startsWith('/system/notifications') || path.startsWith('/health')) {
    return false;
  }
  return true;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!tokenStoreInitialized) {
    await initializeAuthTokenStore();
  }

  const authToken = getAuthToken();
  const method = (init?.method || 'GET').toUpperCase();

  if (shouldCacheGet(path, init)) {
    const cacheKey = `${authToken || 'anonymous'} ${path}`;
    const cached = getCache.get(cacheKey) as GetCacheEntry<T> | undefined;
    const now = Date.now();

    if (cached?.value !== undefined && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached?.promise) {
      return cached.promise;
    }

    const promise = executeRequest<T>(path, init, authToken, method)
      .then((value) => {
        getCache.set(cacheKey, {
          value,
          expiresAt: Date.now() + GET_CACHE_TTL_MS,
        });
        return value;
      })
      .catch((error) => {
        const current = getCache.get(cacheKey);
        if (current?.promise === promise) {
          getCache.delete(cacheKey);
        }
        throw error;
      });

    getCache.set(cacheKey, {
      promise,
      expiresAt: now + GET_CACHE_TTL_MS,
    });
    return promise;
  }

  const result = await executeRequest<T>(path, init, authToken, method);
  if (method !== 'GET') {
    clearApiGetCache();
  }
  return result;
}

export const apiClient = {
  get<T>(path: string, init?: RequestInit) {
    return request<T>(path, init);
  },
  patch<T>(path: string, body?: unknown, init?: RequestInit) {
    return request<T>(path, {
      ...init,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  },
  put<T>(path: string, body?: unknown, init?: RequestInit) {
    return request<T>(path, {
      ...init,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  },
  post<T>(path: string, body?: unknown, init?: RequestInit) {
    return request<T>(path, {
      ...init,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  },
  delete<T>(path: string, init?: RequestInit) {
    return request<T>(path, {
      ...init,
      method: 'DELETE',
    });
  },
};
