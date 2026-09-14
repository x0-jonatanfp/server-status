/**
 * Composition root.
 *
 * Es el unico sitio donde se construyen adaptadores y se cablean con los puertos
 * del dominio. Aqui se ve de un vistazo de que esta hecho el servicio:
 *
 *   collect-status   -> metrics, temperatures, services, websites, fail2ban
 *   publish-status   -> status-renderer, status-publisher, state-store
 *   check-alerts     -> thresholds del inventario, notificador de Discord
 *
 * Nada de esto vive en los casos de uso: ellos solo ven interfaces.
 */
import { pathToFileURL } from "node:url";

import { collectStatus } from "./application/collect-status.ts";
import { AlertChecker } from "./application/check-alerts.ts";
import { StatusLoop } from "./application/publish-status.ts";
import type { CommandContext } from "./infrastructure/discord/commands/index.ts";
import {
  connect,
  createBotStatusPort,
  createDiscordClient,
  createShutdown,
  handleInteraction,
  registerCommands,
} from "./infrastructure/discord/client.ts";
import {
  createChannelResolver,
  createDiscordAlertNotifier,
  createDiscordPublisher,
} from "./infrastructure/discord/publisher.ts";
import { createStatusRenderer } from "./infrastructure/discord/status-view.ts";
import { createFail2banClient } from "./infrastructure/fail2ban/client.ts";
import { createWebsiteProbePort } from "./infrastructure/http/website-probe.ts";
import { createSystemMetricsPort } from "./infrastructure/metrics/system-information.ts";
import { createTemperaturePort } from "./infrastructure/metrics/temperatures.ts";
import { createLogger } from "./infrastructure/logging/logger.ts";
import { JsonStateStore } from "./infrastructure/persistence/state-store.ts";
import { createServiceStatusPort } from "./infrastructure/systemd/service-status.ts";
import { loadAppConfig } from "./infrastructure/config/env.ts";
import { loadInventory } from "./infrastructure/config/inventory.ts";
import { ConfigError } from "./infrastructure/config/validation.ts";
import { VERSION } from "./infrastructure/config/version.ts";

export async function main(): Promise<void> {
  let app;
  let inventory;
  try {
    app = loadAppConfig();
    inventory = loadInventory(app.inventoryPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Todavia no hay logger util: la configuracion es justo lo que ha fallado.
      console.error(`configuracion invalida: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ logFile: app.logFile, level: app.logLevel });
  logger.info(`arrancando ${app.botDisplayName} v${VERSION}`);

  // --- Adaptadores (todos los toca el sistema, la red o Discord) -------------

  const store = new JsonStateStore({ path: app.statePath, logger });
  const client = createDiscordClient();
  const resolver = createChannelResolver(client);

  const metrics = createSystemMetricsPort({ diskMount: app.diskMount });
  const temperatures = createTemperaturePort({ sensors: inventory.temperatures });
  const services = createServiceStatusPort({ groups: inventory.services });
  const websites = createWebsiteProbePort({
    websites: inventory.websites,
    timeoutMs: app.httpTimeoutMs,
  });
  const fail2ban = createFail2banClient({
    sudoPath: app.sudoPath,
    clientPath: app.fail2banClientPath,
  });
  const botStatus = createBotStatusPort(client);

  const renderer = createStatusRenderer({
    display: inventory.display,
    thresholds: inventory.alerts.thresholds,
    hostLabel: app.hostLabel,
    updateIntervalSeconds: app.updateIntervalSeconds,
    version: VERSION,
  });
  const publisher = createDiscordPublisher(resolver, logger);

  // --- Casos de uso ---------------------------------------------------------

  // Los canales salen del .env; si se ha usado /set_channel, ese manda y queda
  // como unico destino.
  const overrideChannelId = await store.getStatusChannelId();
  const channelIds =
    overrideChannelId !== null ? [overrideChannelId] : app.statusChannelIds;

  const collect = () =>
    collectStatus({ metrics, temperatures, services, websites, fail2ban, botStatus });

  const alertChecker = new AlertChecker({ settings: inventory.alerts });

  const scheduler = new StatusLoop({
    updateIntervalSeconds: app.updateIntervalSeconds,
    channelIds,
    collect,
    renderer,
    publisher,
    store,
    logger,
    alertChecker,
    notifier: createDiscordAlertNotifier({
      resolver,
      alertChannelId: app.alertChannelId,
      logger,
    }),
  });

  const context: CommandContext = {
    config: app,
    inventory,
    scheduler,
    store,
    collect,
    render: (snapshot) => renderer.render(snapshot),
    unban: (ip) => fail2ban.unban(ip),
    gatewayPingMs: () => (client.isReady() ? Math.max(0, client.ws.ping) : null),
    version: VERSION,
    startedAt: new Date(),
    logger,
  };

  client.on("interactionCreate", (interaction) => {
    void handleInteraction(interaction, context, logger);
  });

  const shutdown = createShutdown({
    stopLoop: () => scheduler.stop(),
    destroyClient: () => {
      client.destroy();
    },
    logger,
    exit: (code) => process.exit(code),
  });
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await connect({
      client,
      config: app,
      logger,
      onReady: async (ready) => {
        await registerCommands(ready, app.guildId, logger);
        scheduler.start();
      },
    });
  } catch (error) {
    logger.error(
      `no se ha podido conectar con Discord: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

// Solo arranca cuando se ejecuta como programa, no al importarlo desde los tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
