/**
 * Estado de una unidad systemd.
 */
export type ServiceState =
  | "active"
  | "activating"
  | "deactivating"
  | "failed"
  | "inactive"
  | "reloading"
  | "unknown";

export interface ServiceStatus {
  unit: string;
  state: ServiceState;
}

export interface ServiceGroupStatus {
  group: string;
  units: ServiceStatus[];
}
