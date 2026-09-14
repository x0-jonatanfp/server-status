/**
 * Mensaje de estado.
 *
 * Se construye en dos pasos: `renderStatusView` produce bloques de texto puros
 * (faciles de testear y de leer en un snapshot) y `toComponents` los mete en un
 * `Container` de Components V2 con el color de acento del estado global.
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

import type { DisplayConfig, MetricKey, MetricThreshold } from "../config.ts";
import type { StatusSnapshot } from "../collectors/index.ts";
import {
  formatBytes,
  formatCelsius,
  formatClock,
  formatInterval,
  formatMilliseconds,
  formatPercent,
  formatUptime,
  NOT_AVAILABLE,
  progressBar,
} from "./format.ts";
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
} from "./thresholds.ts";

/** Limite de caracteres de un `TextDisplay` en Discord. */
export const MAX_TEXT_DISPLAY_CHARS = 4000;

/** Limite de componentes por mensaje en Discord. */
export const MAX_COMPONENTS = 40;

export interface StatusViewOptions {
  display: DisplayConfig;
  /** Umbrales de recursos y de latencia (`alerts.thresholds` del inventario). */
  thresholds: Record<MetricKey, MetricThreshold>;
  hostLabel?: string | null;
  updateIntervalSeconds: number;
  version: string;
}

export interface StatusView {
  /** Bloques de texto, ya en el orden del mensaje. */
  blocks: string[];
  level: Level;
  accentColor: number;
}

export function renderStatusView(
  snapshot: StatusSnapshot,
  options: StatusViewOptions,
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
  options: StatusViewOptions,
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
    os?.distro ?? NOT_AVAILABLE,
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

function renderResources(snapshot: StatusSnapshot, options: StatusViewOptions): Section {
  const { display, thresholds } = options;
  const blocks = display.progressBarBlocks;

  const cpuLevel = levelFromThreshold(snapshot.system.cpuPercent, thresholds.cpu_percent);
  const memoryLevel = levelFromThreshold(snapshot.system.memory?.percent ?? null, thresholds.memory_percent);
  const diskLevel = levelFromThreshold(snapshot.system.disk?.percent ?? null, thresholds.disk_percent);

  const lines = [
    `🧠 CPU ${formatPercent(snapshot.system.cpuPercent)} ${progressBar(snapshot.system.cpuPercent, blocks)}${anomalyMark(cpuLevel)}`,
    `💾 RAM ${formatPercent(snapshot.system.memory?.percent ?? null)} ${progressBar(snapshot.system.memory?.percent ?? null, blocks)} ${formatBytes(snapshot.system.memory?.usedBytes ?? null)} / ${formatBytes(snapshot.system.memory?.totalBytes ?? null)}${anomalyMark(memoryLevel)}`,
    `💽 Disco ${formatPercent(snapshot.system.disk?.percent ?? null)} ${progressBar(snapshot.system.disk?.percent ?? null, blocks)} ${formatBytes(snapshot.system.disk?.usedBytes ?? null)} / ${formatBytes(snapshot.system.disk?.totalBytes ?? null)}${anomalyMark(diskLevel)}`,
  ];

  return {
    text: ["⚙️ RECURSOS", ...lines].join("\n"),
    levels: [cpuLevel, memoryLevel, diskLevel],
  };
}

/** Marca de una lectura: lo que esta bien no se marca. */
function anomalyMark(level: Level): string {
  return level === "ok" ? "" : ` ${levelMark(level)}`;
}

function renderTemperatures(snapshot: StatusSnapshot): Section {
  const readings = snapshot.temperatures;
  const levels = readings.map((reading) =>
    levelFromTemperature(reading.celsius, reading.warn, reading.crit),
  );

  if (readings.length === 0) return { text: null, levels };

  const parts = readings.map((reading, index) => {
    const level = levels[index] ?? "ok";
    return `${reading.name}${anomalyMark(level)} ${formatCelsius(reading.celsius)}`;
  });

  return { text: ["🌡️ TEMPERATURAS", parts.join(" · ")].join("\n"), levels };
}

function renderServices(snapshot: StatusSnapshot, display: DisplayConfig): Section {
  const groups = snapshot.services;
  if (groups.length === 0) return { text: null, levels: [] };

  const units = groups.flatMap((group) => group.units);
  if (units.length === 0) return { text: null, levels: [] };

  const levels = units.map((unit) => levelFromServiceState(unit.state));
  const running = levels.filter((level) => level === "ok").length;

  const lines: string[] = [];
  if (display.showGroups) {
    for (const group of groups) {
      const parts = group.units.map((unit) => `${stateMark(unit.state)} ${unit.unit}`);
      lines.push(`${group.group} ${parts.join(" ")}`);
    }
  } else {
    lines.push(units.map((unit) => `${stateMark(unit.state)} ${unit.unit}`).join(" "));
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

function renderNetwork(snapshot: StatusSnapshot, options: StatusViewOptions): string | null {
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
    const breakdown = jails
      .map((jail) => `${jail.name} ${jail.banned ?? "?"}`)
      .join(" · ");
    lines.push(
      `🔒 Fail2ban: ${fail2ban.totalBanned} IPs baneadas${breakdown === "" ? "" : ` · ${breakdown}`}`,
    );
  }

  if (lines.length === 0) return null;
  const header = options.display.showPing ? "📡 RED" : null;
  return header ? [header, ...lines].join("\n") : lines.join("\n");
}

function renderFooter(snapshot: StatusSnapshot, options: StatusViewOptions): string {
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
