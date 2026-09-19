/**
 * Adaptador del puerto de render: el mensaje de estado en Components V2.
 *
 * Se construye en dos pasos: `renderStatusView` produce bloques de texto puros
 * (faciles de testear y de leer en un snapshot) y `toComponents` los mete en un
 * `Container` con el color de acento del estado global.
 *
 * Components V2 (flag `IsComponentsV2`) en lugar de un embed clasico: un embed
 * tiene 25 campos y 6000 caracteres para todo el mensaje, y aqui hay 23
 * servicios, 5 webs y 6 filas de recursos; el mensaje con el flag admite 40
 * componentes y no hace falta recortar nada. El flag se pone desde el primer
 * envio porque no se puede quitar despues.
 *
 * El mensaje empieza en `RECURSOS` y el estado global lo dice el color de acento
 * del contenedor, no un titulo. El bloque del pie lleva el sistema operativo y
 * la hora de la ultima actualizacion.
 *
 * Lo que se muestra y lo que no (grupos, desglose de fail2ban, ping, numero de
 * bloques de la barra, colores y las filas de recursos) sale del inventario.
 */
import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";

import type {
  DisplaySettings,
  MetricKey,
  MetricThreshold,
  ResourceRowSettings,
  ResourceSettings,
} from "../../domain/entities/inventory.ts";
import type { ServiceStatus } from "../../domain/entities/service-status.ts";
import type { StatusSnapshot } from "../../domain/entities/status-snapshot.ts";
import type { StatusView } from "../../domain/entities/status-view.ts";
import type { DiskUsage } from "../../domain/entities/system-metrics.ts";
import type { TemperatureReading } from "../../domain/entities/temperature-reading.ts";
import type { StatusRendererPort } from "../../domain/ports/status-renderer.ts";
import {
  displayWidth,
  formatBytes,
  formatCelsius,
  formatInterval,
  formatMilliseconds,
  formatPercent,
  formatShortClock,
  formatUptime,
  NOT_AVAILABLE,
  packEntries,
  progressBar,
} from "../../domain/services/format.ts";
import {
  accentColor,
  levelFromServiceState,
  levelFromTemperature,
  levelFromThreshold,
  levelFromWebsite,
  levelMark,
  stateMark,
  worstLevel,
  type Level,
} from "../../domain/services/thresholds.ts";

/** Limite de caracteres de un `TextDisplay` en Discord. */
export const MAX_TEXT_DISPLAY_CHARS = 4000;

/** Limite de componentes por mensaje en Discord. */
export const MAX_COMPONENTS = 40;

/**
 * Ancho maximo (en columnas) de las lineas que empaqueta el bot.
 *
 * Discord parte las lineas donde quiere, asi que las listas (servicios,
 * temperaturas) se cortan antes: cada entrada queda entera en una linea. Es un
 * presupuesto de anchura, no un limite de Discord.
 */
export const MAX_LINE_WIDTH = 60;

/**
 * Ancho maximo de una fila de recursos. Es mas generoso que `MAX_LINE_WIDTH`
 * porque la barra (10 cuadrados = 20 columnas) y el detalle de un disco no se
 * pueden partir sin romper la fila, que es lo que se lee de un vistazo.
 */
export const MAX_RESOURCE_ROW_WIDTH = 72;

export interface StatusRendererOptions {
  display: DisplaySettings;
  /** Filas de recursos: etiquetas, emojis y sensores enlazados. */
  resources: ResourceSettings;
  /** Umbrales de recursos y de latencia (`alerts.thresholds` del inventario). */
  thresholds: Record<MetricKey, MetricThreshold>;
  updateIntervalSeconds: number;
  version: string;
}

/**
 * Adaptador del puerto de render: la configuracion se fija al construirlo (en
 * el composition root) y el caso de uso solo ve `render(snapshot)`.
 */
export function createStatusRenderer(options: StatusRendererOptions): StatusRendererPort {
  return {
    render: (snapshot) => renderStatusView(snapshot, options),
  };
}

export function renderStatusView(
  snapshot: StatusSnapshot,
  options: StatusRendererOptions,
): StatusView {
  const resources = renderResources(snapshot, options);
  const services = renderServices(snapshot, options.display);
  const websites = renderWebsites(snapshot);
  const network = renderNetwork(snapshot, options.display);
  const fail2ban = renderFail2ban(snapshot, options.display);
  const footer = renderFooter(snapshot, options);

  // El nivel global sigue teniendo en cuenta todas las temperaturas, esten o no
  // enlazadas con una fila de recursos: el color de acento no puede perderse una
  // lectura fuera de rango.
  const temperatures = snapshot.temperatures.map((reading) =>
    levelFromTemperature(reading.celsius, reading.warn, reading.crit),
  );

  const level = worstLevel([
    ...resources.levels,
    ...temperatures,
    ...services.levels,
    ...websites.levels,
    levelFromThreshold(snapshot.bot.pingMs, options.thresholds.ping_ms),
  ]);

  const blocks = [resources.text, services.text, websites.text, network, fail2ban, footer].filter(
    (block): block is string => block !== null && block !== "",
  );

  return {
    blocks: blocks.map(truncate),
    level,
    accentColor: accentColor(level, options.display.colors),
  };
}

function truncate(block: string): string {
  return block.length <= MAX_TEXT_DISPLAY_CHARS
    ? block
    : `${block.slice(0, MAX_TEXT_DISPLAY_CHARS - 1)}…`;
}

interface Section {
  text: string | null;
  levels: Level[];
}

interface ResourceRow {
  icon: string;
  /** Etiqueta ya en mayusculas y sin rellenar; el relleno lo pone el render. */
  label: string;
  /** Uso medido; `null` = no se ha podido leer y la fila sale sin barra. */
  percent: number | null;
  /** Texto del uso (`23.1%`, `124.0 GB / 916.0 GB`...); `""` si no lleva. */
  usage: string;
  /** `true` si `usage` es un porcentaje (o su `N/A`) y comparte columna. */
  percentColumn: boolean;
  /** Detalle detras del uso: la temperatura de la fila, si tiene. */
  detail: string;
  level: Level;
}

/**
 * Las seis filas de recursos: CPU y GPU con su `%` y su temperatura, RAM con su
 * `%` y los tres volumenes con sus GB y su temperatura. Cada fila es una linea:
 * con cuadrados emoji la barra no se alinea al pixel (la fuente es proporcional
 * y el ancho depende del cliente), asi que se prioriza que cada fila se lea bien.
 */
function renderResources(snapshot: StatusSnapshot, options: StatusRendererOptions): Section {
  const { resources, thresholds, display } = options;
  const readings = temperatureByName(snapshot.temperatures);
  const diskByMount = new Map(snapshot.system.disks.map((disk) => [disk.mount, disk]));

  const cpuLevel = levelFromThreshold(snapshot.system.cpuPercent, thresholds.cpu_percent);
  const memoryLevel = levelFromThreshold(
    snapshot.system.memory?.percent ?? null,
    thresholds.memory_percent,
  );

  const rows: ResourceRow[] = [];
  // Niveles del uso (sin las temperaturas, que entran aparte): el color de
  // acento no puede depender de que una lectura se muestre en una fila u otra.
  const levels: Level[] = [cpuLevel, memoryLevel];

  rows.push(
    row(resources.cpu, readings, {
      percent: snapshot.system.cpuPercent,
      usage: formatPercent(snapshot.system.cpuPercent),
      percentColumn: true,
      level: cpuLevel,
    }),
  );

  const gpuHasData = snapshot.system.gpuPercent !== null;
  rows.push(
    row(resources.gpu, readings, {
      percent: snapshot.system.gpuPercent,
      usage: gpuHasData ? formatPercent(snapshot.system.gpuPercent) : "",
      percentColumn: gpuHasData,
      // La GPU no tiene umbral de uso en el inventario: lo unico que puede
      // marcar su fila es la temperatura, y sin dato de uso la fila sale sin
      // barra y sin `%`, con su temperatura o `N/A`.
      level: gpuHasData ? "ok" : "unknown",
      detail: gpuHasData ? undefined : temperatureDetail(readingOf(resources.gpu, readings)) || NOT_AVAILABLE,
    }),
  );

  rows.push(
    row(resources.memory, readings, {
      percent: snapshot.system.memory?.percent ?? null,
      usage: formatPercent(snapshot.system.memory?.percent ?? null),
      percentColumn: true,
      detail: formatMemory(snapshot),
      level: memoryLevel,
    }),
  );

  for (const disk of resources.disks) {
    const usage = diskByMount.get(disk.mount) ?? null;
    const level = levelFromThreshold(usage?.percent ?? null, thresholds.disk_percent);
    levels.push(level);
    rows.push(
      row(disk, readings, {
        percent: usage?.percent ?? null,
        usage: formatDiskUsage(usage),
        // El uso de un disco son GB, no un porcentaje: no compite con esa
        // columna, pero su `N/A` si se alinea con ella.
        percentColumn: false,
        level,
      }),
    );
  }

  return {
    text: ["⚙️ RECURSOS", ...renderResourceLines(rows, display.progressBarBlocks)].join("\n"),
    levels,
  };
}

/**
 * Fila ya montada con su temperatura enlazada. El `detail` de `overrides` es el
 * de la propia fila (los GB de la RAM, por ejemplo); la temperatura se anade
 * detras, y la marca de anomalia es la peor de las dos.
 */
function row(
  settings: ResourceRowSettings,
  readings: Map<string, TemperatureReading>,
  overrides: {
    percent: number | null;
    usage: string;
    percentColumn: boolean;
    /** Nivel del uso medido, sin contar la temperatura. */
    level: Level;
    /** Detalle que sustituye a la temperatura; ausente = la propia temperatura. */
    detail?: string;
  },
): ResourceRow {
  const reading = readingOf(settings, readings);
  const temperatureLevel =
    reading === undefined
      ? "unknown"
      : levelFromTemperature(reading.celsius, reading.warn, reading.crit);

  return {
    icon: settings.icon,
    label: settings.label.toUpperCase(),
    percent: overrides.percent,
    usage: overrides.usage,
    percentColumn: overrides.percentColumn,
    detail: overrides.detail ?? temperatureDetail(reading),
    level: mergeLevels(overrides.level, temperatureLevel),
  };
}

function readingOf(
  settings: ResourceRowSettings,
  readings: Map<string, TemperatureReading>,
): TemperatureReading | undefined {
  return settings.temperature === null ? undefined : readings.get(settings.temperature);
}

/** Detalle de la temperatura de una fila; las filas sin sensor no anaden nada. */
function temperatureDetail(reading: TemperatureReading | undefined): string {
  return reading === undefined ? "" : formatCelsius(reading.celsius);
}

function formatMemory(snapshot: StatusSnapshot): string {
  const memory = snapshot.system.memory;
  if (memory === null) return "";
  return `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`;
}

/** Los GB de un volumen, o `N/A` si el sistema no lo conoce. */
function formatDiskUsage(usage: DiskUsage | null): string {
  if (usage === null) return NOT_AVAILABLE;
  return `${formatBytes(usage.usedBytes)} / ${formatBytes(usage.totalBytes)}`;
}

/**
 * Las dos marcas de una fila (uso y temperatura) en una sola: si un dato no se
 * puede leer pero el otro si, manda el que se conoce.
 */
function mergeLevels(usage: Level, temperature: Level): Level {
  if (usage === "unknown") return temperature;
  if (temperature === "unknown") return usage;
  return worstLevel([usage, temperature]);
}

function renderResourceLines(rows: ResourceRow[], blocks: number): string[] {
  const labelWidth = Math.max(...rows.map((row) => displayWidth(row.label)));
  // Los porcentajes comparten columna (el `N/A` tambien); los GB de un disco son
  // mas anchos y no la mueven.
  const percentWidth = Math.max(
    0,
    ...rows
      .filter((row) => row.percentColumn)
      .map((row) => displayWidth(row.usage)),
  );

  return rows.map((item) => {
    const padding = " ".repeat(labelWidth - displayWidth(item.label));
    const cells: string[] = [];
    if (item.percent !== null) cells.push(progressBar(item.percent, blocks));
    if (item.usage !== "") {
      cells.push(
        displayWidth(item.usage) < percentWidth
          ? item.usage.padStart(percentWidth)
          : item.usage,
      );
    }

    const body = cells.join("  ");
    const detail =
      item.detail === ""
        ? ""
        : body === ""
          ? item.detail
          : ` · ${item.detail}`;
    const mark = item.level === "ok" ? "" : `\u00A0${levelMark(item.level)}`;

    return `${item.icon}\u00A0${item.label}${padding}  ${body}${detail}${mark}`;
  });
}

/** Temperaturas por nombre de sensor; el primero gana si hubiera repetidos. */
function temperatureByName(readings: TemperatureReading[]): Map<string, TemperatureReading> {
  const map = new Map<string, TemperatureReading>();
  for (const reading of readings) {
    if (!map.has(reading.name)) map.set(reading.name, reading);
  }
  return map;
}

function renderServices(snapshot: StatusSnapshot, display: DisplaySettings): Section {
  const groups = snapshot.services;
  if (groups.length === 0) return { text: null, levels: [] };

  const units = groups.flatMap((group) => group.units);
  if (units.length === 0) return { text: null, levels: [] };

  const levels = units.map((unit) => levelFromServiceState(unit.state));
  const running = levels.filter((level) => level === "ok").length;

  // NBSP entre la marca y el nombre: el ✅ no se queda huerfano al final de una
  // linea con el servicio en la siguiente. Cada entrada es una unidad.
  const entryOf = (unit: ServiceStatus): string => `${stateMark(unit.state)}\u00A0${unit.unit}`;

  const lines: string[] = [];
  if (display.showGroups) {
    const labelWidth = Math.max(...groups.map((group) => displayWidth(group.group)));
    for (const group of groups) {
      const entries = group.units.map(entryOf);
      if (entries.length === 0) continue;

      const label = group.group + " ".repeat(labelWidth - displayWidth(group.group));
      const indent = " ".repeat(labelWidth + 1);
      const packed = packEntries(entries, { maxWidth: MAX_LINE_WIDTH, indent });
      const first = packed[0];
      if (first === undefined) continue;

      lines.push(`${label} ${first.slice(indent.length)}`);
      lines.push(...packed.slice(1));
    }
  } else {
    lines.push(...packEntries(units.map(entryOf), { maxWidth: MAX_LINE_WIDTH }));
  }

  return {
    text: [`🧩 SERVICIOS ${running}/${units.length} activos`, ...lines].join("\n"),
    levels,
  };
}

function renderWebsites(snapshot: StatusSnapshot): Section {
  const websites = snapshot.websites;
  if (websites.length === 0) return { text: null, levels: [] };

  const up = websites.filter((website) => website.up).length;
  const lines = websites.map((website) => {
    const icon = website.up ? "✅" : "❌";
    const detail = website.up
      ? formatMilliseconds(website.latencyMs)
      : website.statusCode === null
        ? (website.error ?? NOT_AVAILABLE)
        : `${website.statusCode} · ${formatMilliseconds(website.latencyMs)}`;
    return `${icon} ${website.label} ${detail}`;
  });

  return {
    text: [`🌐 WEBS ${up}/${websites.length}`, ...lines].join("\n"),
    levels: websites.map((website) => levelFromWebsite(website.up)),
  };
}

/** La latencia del propio bot, si el inventario la muestra. */
function renderNetwork(
  snapshot: StatusSnapshot,
  display: DisplaySettings,
): string | null {
  if (!display.showPing) return null;
  return ["📡 RED", `Bot ${formatMilliseconds(snapshot.bot.pingMs)}`].join("\n");
}

/**
 * Fail2ban en su propio bloque: la cabecera en una linea y cada carcel en la
 * suya. Con el desglose apagado solo va el total.
 */
function renderFail2ban(snapshot: StatusSnapshot, display: DisplaySettings): string {
  const fail2ban = snapshot.fail2ban;
  if (!fail2ban.available) return "🔒 FAIL2BAN · sin datos";

  const lines = [`🔒 FAIL2BAN · ${fail2ban.totalBanned} IPs baneadas`];
  if (display.showFail2banBreakdown) {
    for (const jail of fail2ban.jails) {
      if ((jail.banned ?? 0) > 0 || jail.banned === null) {
        lines.push(`${jail.name} ${jail.banned ?? "?"}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Pie de dos lineas: el sistema (distribucion, kernel y uptime) y la
 * actualizacion (intervalo, hora y version).
 */
function renderFooter(snapshot: StatusSnapshot, options: StatusRendererOptions): string {
  const { os, uptimeSeconds } = snapshot.system;
  const system = [
    formatDistribution(os) ?? NOT_AVAILABLE,
    os?.kernel ?? NOT_AVAILABLE,
    formatUptime(uptimeSeconds),
  ].join(" · ");
  const updated = [
    `Actualizado cada ${formatInterval(options.updateIntervalSeconds)}`,
    `última ${formatShortClock(snapshot.collectedAt)}`,
    `v${options.version}`,
  ].join(" · ");

  return `${system}\n${updated}`;
}

/**
 * `Ubuntu 24.04`: `osInfo().distro` solo trae el nombre y `release` trae cosas
 * como `24.04.5 LTS`, asi que se muestra solo la version base.
 */
function formatDistribution(os: StatusSnapshot["system"]["os"]): string | null {
  if (os === null) return null;
  const version = /^\d+(\.\d+)?/.exec(os.release)?.[0] ?? os.release;
  return [os.distro, version].filter((part) => part !== "").join(" ");
}

/**
 * Convierte la vista en componentes listos para enviar. Se devuelve tambien el
 * flag porque Components V2 lo exige en cada envio y edicion.
 */
export function toComponents(view: StatusView): {
  components: ContainerBuilder[];
  flags: number;
} {
  const container = new ContainerBuilder().setAccentColor(view.accentColor);
  view.blocks.forEach((block, index) => {
    if (index > 0) container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(block));
  });

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/** Numero de componentes que genera la vista, para no pasarse del limite. */
export function countComponents(view: StatusView): number {
  const blocks = view.blocks.length;
  if (blocks === 0) return 1;
  return 1 + blocks + (blocks - 1);
}
