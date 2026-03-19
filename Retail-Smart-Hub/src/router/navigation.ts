import type { AppModuleId } from '@/config/modules';
import { defaultModuleId } from '@/config/modules';

export const LOGIN_PATH = '/login';

const modulePathMap: Record<AppModuleId, string> = {
  dashboard: '/dashboard',
  orders: '/orders',
  customers: '/customers',
  inventory: '/inventory',
  procurement: '/procurement',
  arrival: '/arrival',
  inbound: '/inbound',
  shipping: '/shipping',
  finance: '/finance',
  reports: '/reports',
  ai: '/ai',
  config: '/config',
  settings: '/settings',
};

function normalizePath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '');
  return normalized || '/';
}

export function getModulePath(moduleId: AppModuleId) {
  return modulePathMap[moduleId];
}

export function resolveModuleFromPath(pathname: string) {
  const normalizedPath = normalizePath(pathname);

  if (normalizedPath === '/') {
    return defaultModuleId;
  }

  if (normalizedPath === '/arrival') {
    return 'inbound';
  }

  return (
    (Object.entries(modulePathMap).find(([, path]) => path === normalizedPath)?.[0] as AppModuleId | undefined) ??
    null
  );
}

export function getCurrentPathname() {
  if (typeof window === 'undefined') {
    return '/';
  }

  return normalizePath(window.location.pathname || '/');
}
