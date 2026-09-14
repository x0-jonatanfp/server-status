/**
 * Estado de las unidades systemd del inventario.
 *
 * Se pregunta una sola vez por todas las unidades
 * (`systemctl show -p Id,LoadState,ActiveState,SubState`) en lugar de lanzar dos
 * procesos por unidad: con 23 unidades eran 46 procesos cada ciclo.
 *
 * `is-active` no distingue una unidad inexistente de una parada (ambas salen
 * como `inactive`), asi que el estado se saca de `LoadState` + `ActiveState`:
 * `LoadState=not-found` se reporta como `unknown`.
 *
 * Todo esto funciona sin sudo: consultar el estado no necesita privilegios.
 */
import type { ServiceGroup } from "../../domain/entities/inventory.ts";
import type { ServiceGroupStatus, ServiceState } from "../../domain/entities/service-status.ts";
import type { ServiceStatusPort } from "../../domain/ports/services.ts";
import { defaultExec, stdoutOf, type ExecFileFn } from "../exec.ts";

export const DEFAULT_SYSTEMCTL_PATH = "/usr/bin/systemctl";
const DEFAULT_TIMEOUT_MS = 5000;

const KNOWN_STATES: readonly ServiceState[] = [
  "active",
  "activating",
  "deactivating",
  "failed",
  "inactive",
  "reloading",
];

export interface ServiceStatusPortOptions {
  groups: ServiceGroup[];
  systemctlPath?: string;
  timeoutMs?: number;
  exec?: ExecFileFn;
}

export function createServiceStatusPort(
  options: ServiceStatusPortOptions,
): ServiceStatusPort {
  const setup = {
    exec: options.exec ?? defaultExec,
    systemctlPath: options.systemctlPath ?? DEFAULT_SYSTEMCTL_PATH,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  return {
    collect: () => collectServices(options.groups, setup),
  };
}

interface SystemctlSetup {
  exec: ExecFileFn;
  systemctlPath: string;
  timeoutMs: number;
}

interface UnitInfo {
  loadState: string;
  activeState: string;
}

/** Recolecta el estado agrupado, en el orden del inventario. */
async function collectServices(
  groups: ServiceGroup[],
  setup: SystemctlSetup,
): Promise<ServiceGroupStatus[]> {
  const units = [...new Set(groups.flatMap((group) => group.units))];
  if (units.length === 0) return [];

  const info = await showUnits(units, setup);
  return groups.map((group) => ({
    group: group.group,
    units: group.units.map((unit) => ({ unit, state: stateOf(info.get(unit)) })),
  }));
}

function stateOf(info: UnitInfo | undefined): ServiceState {
  if (!info) return "unknown";
  if (info.loadState === "not-found" || info.loadState === "error") return "unknown";
  const state = info.activeState as ServiceState;
  return KNOWN_STATES.includes(state) ? state : "unknown";
}

async function showUnits(
  units: string[],
  setup: SystemctlSetup,
): Promise<Map<string, UnitInfo>> {
  const args = ["show", "-p", "Id,LoadState,ActiveState,SubState", "--", ...units];

  let stdout: string;
  try {
    ({ stdout } = await setup.exec(setup.systemctlPath, args, { timeout: setup.timeoutMs }));
  } catch (error) {
    stdout = stdoutOf(error);
  }

  const result = new Map<string, UnitInfo>();
  // `systemctl show` separa cada unidad con una linea en blanco.
  for (const block of stdout.split(/\n\s*\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const separator = line.indexOf("=");
      if (separator === -1) continue;
      fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
    const id = fields.get("Id");
    if (!id) continue;
    const info: UnitInfo = {
      loadState: fields.get("LoadState") ?? "",
      activeState: fields.get("ActiveState") ?? "",
    };
    // El id lleva sufijo de tipo (`.service`), el inventario no.
    result.set(id, info);
    result.set(id.replace(/\.\w+$/, ""), info);
  }
  return result;
}
