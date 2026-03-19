export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message?: string;
  timestamp: string;
}

export interface HealthStatus {
  service: string;
  status: 'ok';
  environment: string;
  uptimeSeconds: number;
}

export type ModuleStatus = 'ui-shell' | 'api-skeleton' | 'planned';

export interface ModuleCatalogItem {
  id: string;
  label: string;
  description: string;
  status: ModuleStatus;
  apiPrefix: string;
}
