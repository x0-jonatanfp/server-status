/**
 * Adaptador del puerto de render: el mensaje de estado en Components V2.
 *
 * Se construye en dos pasos: `renderStatusView` produce bloques de texto puros
 * (faciles de testear y de leer en un snapshot) y `toComponents` los mete en un
 * `Container` con el color de acento del estado global.
 *
 * Components V2 (flag `IsComponentsV2`) en lugar de un embed clasico: un embed
 * tiene 25 campos y 6000 caracteres para todo el mensaje, y aqui hay 23
 * servicios, 5 webs y 6 temperaturas; el mensaje con el flag admite 40
 * componentes y no hace falta recortar nada. El flag se pone desde el primer
 * envio porque no se puede quitar despues.
 *
 * Lo que se muestra y lo que no (grupos, desglose de fail2ban, ping, numero de
 * bloques de la barra y colores) sale del bloque `display` del inventario.
 */
import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";

import type { DisplaySettings, MetricKey, MetricThreshold } from "../../domain/entities/inventory.ts";
import type { ServiceStatus } from "../../domain/entities/service-status.ts";
import type { StatusSnapshot } from "../../domain/entities/status-snapshot.ts";
import type { StatusView } from "../../domain/entities/status-view.ts";
import type { StatusRendererPort } from "../../domain/ports/status-renderer.ts";
import {
  displayWidth,
  formatBytes,
  formatCelsius,
  formatClock,
  formatInterval,
  formatMilliseconds,
  formatPercent,
  formatUptime,
  NOT_AVAILABLE,
  packEntries,
  progressBar,
} from "../../domain/services/format.ts";
import {
  accentColor,
  levelEmoji,
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
 * temperaturas) y la tabla de recursos se cortan antes: cada entrada queda
 * entera en una linea. Es un presupuesto de anchura, no un limite de Discord.
 */
export const MAX_LINE_WIDTH = 60;

export interface StatusRendererOptions {
  display: DisplaySettings;
  /** Umbrales de recursos y de latencia (`alerts.thresholds` del inventario). */
  thresholds: Record<MetricKey, MetricThreshold>;
  hostLabel?: string | null;
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
  const temperatures = renderTemperatures(snapshot);
  const services = renderServices(snapshot, options.display);
  const websites = renderWebsites(snapshot);
  const network = renderNetwork(snapshot, options);
  const footer = renderFooter(snapshot, options);

  const level = worstLevel([
    ...resources.levels,
    ...temperatures.levels,
    ...services.levels,
    ...websites.levels,
    levelFromThreshold(snapshot.bot.pingMs, options.thresholds.ping_ms),
  ]);

  const blocks = [
    renderHeader(snapshot, options, level),
    resources.text,
    temperatures.text,
    services.text,
    websites.text,
    network,
    footer,
  ].filter((block): block is string => block !== null);

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

function renderHeader(
  snapshot: StatusSnapshot,
  options: StatusRendererOptions,
  level: Level,
): string {
  const { os, uptimeSeconds } = snapshot.system;
  const title = [
    `${levelEmoji(level)} SERVER STATUS`,
    os?.hostname ?? NOT_AVAILABLE,
    formatClock(snapshot.collectedAt),
  ].join(" · ");
  const subtitle = [
    options.hostLabel,
    formatDistribution(os) ?? NOT_AVAILABLE,
    `kernel ${os?.kernel ?? NOT_AVAILABLE}`,
    `up ${formatUptime(uptimeSeconds)}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return `${title}\n${subtitle}`;
}

interface Section {
  text: string | null;
  levels: Level[];
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

interface ResourceRow {
  label: string;
  percent: number | null;
  /** Detalle a la derecha de la barra (vacio en la CPU). */
  detail: string;
  level: Level;
}

/**
 * Tabla de recursos en un bloque de codigo monoespaciado.
 *
 * En vez de una linea por metrica con emoji, la tabla es texto: Discord la
 * pinta con ancho fijo y las columnas (etiqueta, barra, porcentaje, detalle)
 * caen siempre en el mismo sitio. El porcentaje se rellena a 6 columnas
 * ("100.0%") para que no se mueva con 1, 2 o 3 digitos ni con `N/A`.
 */
function renderResources(snapshot: StatusSnapshot, options: StatusRendererOptions): Section {
  const { display, thresholds } = options;
  const blocks = display.progressBarBlocks;
  const { memory, disk } = snapshot.system;

  const cpuLevel = levelFromThreshold(snapshot.system.cpuPercent, thresholds.cpu_percent);
  const memoryLevel = levelFromThreshold(memory?.percent ?? null, thresholds.memory_percent);
  const diskLevel = levelFromThreshold(disk?.percent ?? null, thresholds.disk_percent);

  const rows: ResourceRow[] = [
    { label: "CPU", percent: snapshot.system.cpuPercent, detail: "", level: cpuLevel },
    {
      label: "RAM",
      percent: memory?.percent ?? null,
      detail: `${formatBytes(memory?.usedBytes ?? null)} / ${formatBytes(memory?.totalBytes ?? null)}`,
      level: memoryLevel,
    },
    {
      label: "Disco",
      percent: disk?.percent ?? null,
      detail: `${formatBytes(disk?.usedBytes ?? null)} / ${formatBytes(disk?.totalBytes ?? null)}`,
      level: diskLevel,
    },
  ];

  const labelWidth = Math.max(...rows.map((row) => displayWidth(row.label)));
  // "100.0%" es el porcentaje mas ancho posible: la columna no depende del dato.
  const percentWidth = Math.max(
    ...rows.map((row) => displayWidth(formatPercent(row.percent))),
    displayWidth("100.0%"),
  );

  const table = rows.map((row) => {
    const label = row.label + " ".repeat(labelWidth - displayWidth(row.label));
    const percent = formatPercent(row.percent).padStart(percentWidth);
    const detail = row.detail === "" ? "" : `  ${row.detail}`;
    const mark = anomalyMark(row.level);
    return `${label}  ${progressBar(row.percent, blocks)}  ${percent}${detail}${mark}`;
  });

  return {
    text: ["⚙️ RECURSOS", "```", ...table, "```"].join("\n"),
    levels: [cpuLevel, memoryLevel, diskLevel],
  };
}

/**
 * Marca de una lectura fuera de rango: lo que esta bien no se marca. Los emoji
 * van siempre al final de la linea o dentro de entradas que no se parten, para
 * que su anchura no descoloque las columnas.
 */
function anomalyMark(level: Level): string {
  return level === "ok" ? "" : ` ${levelMark(level)}`;
}

function renderTemperatures(snapshot: StatusSnapshot): Section {
  const readings = snapshot.temperatures;
  const levels = readings.map((reading) =>
    levelFromTemperature(reading.celsius, reading.warn, reading.crit),
  );

  if (readings.length === 0) return { text: null, levels };

  // NBSP entre el nombre y su valor: Discord no puede partir la entrada y
  // dejar "CPU" en una linea y la temperatura en la siguiente.
  const entries = readings.map((reading, index) => {
    const level = levels[index] ?? "ok";
    const mark = level === "ok" ? "" : `${levelMark(level)}\u00A0`;
    return `${reading.name}\u00A0${mark}${formatCelsius(reading.celsius)}`;
  });

  const lines = packEntries(entries, { maxWidth: MAX_LINE_WIDTH, separator: " · " });
  return { text: ["🌡️ TEMPERATURAS", ...lines].join("\n"), levels };
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

function renderNetwork(snapshot: StatusSnapshot, options: StatusRendererOptions): string | null {
  const lines: string[] = [];

  if (options.display.showPing) {
    lines.push(`Bot ${formatMilliseconds(snapshot.bot.pingMs)}`);
  }

  const fail2ban = snapshot.fail2ban;
  if (!fail2ban.available) {
    lines.push("🔒 Fail2ban: sin datos");
  } else {
    const jails = options.display.showFail2banBreakdown
      ? fail2ban.jails.filter((jail) => (jail.banned ?? 0) > 0 || jail.banned === null)
      : [];
    const breakdown = jails.map((jail) => `${jail.name} ${jail.banned ?? "?"}`).join(" · ");
    lines.push(
      `🔒 Fail2ban: ${fail2ban.totalBanned} IPs baneadas${breakdown === "" ? "" : ` · ${breakdown}`}`,
    );
  }

  if (lines.length === 0) return null;
  const header = options.display.showPing ? "📡 RED" : null;
  return header ? [header, ...lines].join("\n") : lines.join("\n");
}

function renderFooter(snapshot: StatusSnapshot, options: StatusRendererOptions): string {
  return [
    `Actualizado cada ${formatInterval(options.updateIntervalSeconds)}`,
    `última ${formatClock(snapshot.collectedAt)}`,
    `v${options.version}`,
  ].join(" · ");
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
