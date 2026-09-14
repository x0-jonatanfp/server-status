<div align="center">

# server-status

**Bot de Discord que publica el estado de un servidor: métricas, temperaturas,
servicios systemd, webs y latencias, en un solo mensaje que se edita.**

</div>

---

## Qué hace

- Publica **un único mensaje** por canal y lo **edita** en cada ciclo (no borra ni
  reenvía, así no se pierden reacciones ni hilos).
- Recoge CPU, RAM, disco y uptime con `systeminformation`.
- Lee **temperaturas reales** de CPU, GPU, NVMe, placa y discos SATA: por
  `/sys/class/hwmon` (sin privilegios) y `smartctl` para los SATA.
- Comprueba las **unidades systemd** y las **webs** que le digas, por HTTP.
- Muestra el estado y la latencia del propio bot, y el resumen de fail2ban.
- Envía **alertas por umbral** (CPU, memoria, disco, ping y temperatura) con
  cooldown, a un canal aparte.
- Incluye `/unban` para desbanear una IP de todas las cárceles de fail2ban.

Todo lo que muestra sale de la configuración: no hay hosts, servicios ni canales
en el código.

## Requisitos

- Node 22 o superior
- Linux con systemd
- Opcional: `lm-sensors` y `smartmontools` para las temperaturas, y `fail2ban`
  para el comando de desbaneo

## Instalación

Este repositorio **no incluye** ninguna aplicación de Discord: cada uno usa la
suya. Para montarlo:

1. **Crea la aplicación y el bot** en el
   [portal de desarrolladores](https://discord.com/developers/applications):
   *New Application* → pestaña **Bot** → *Reset Token* → copia el token.
2. **Invita el bot** a tu servidor con los permisos `Send Messages` y
   `Embed Links` (y `Manage Messages` si quieres que limpie mensajes viejos).
3. **Clona e instala**:

   ```bash
   git clone <tu-repo> server-status
   cd server-status
   pnpm install
   ```

4. **Configura**:

   ```bash
   cp .env.example .env && chmod 600 .env
   cp inventory.yaml.example inventory.yaml
   ```

   En `.env` rellena `DISCORD_TOKEN` y `STATUS_CHANNEL_IDS` (uno o varios canales
   separados por comas, para publicar el mismo estado en varios servidores). En
   `inventory.yaml` pon tus webs, tus unidades systemd y tus sensores.

   El `.env` lleva el token y no se versiona; `inventory.yaml` describe tu
   máquina y tampoco.

5. **Arranca**:

   ```bash
   pnpm dev      # desarrollo, con recarga
   pnpm build    # bundle de produccion en dist/
   pnpm start
   ```

## Comandos

| Comando | Qué hace | Permisos |
|---|---|---|
| `/status` | Estado completo, como respuesta efímera | rol configurado |
| `/set_channel [canal]` | Fija el canal de publicación y publica ya | Administrador |
| `/update` | Fuerza una actualización inmediata | Administrador |
| `/botstatus` | Estado del bot: ciclo, latencia y última publicación | Administrador |
| `/unban <ip>` | Desbanea la IP de todas las cárceles de fail2ban | rol configurado |
| `/help-unban` | Ayuda del sistema de autodesbaneo | rol configurado |

`/set_channel` deja ese canal como el único destino. Para publicar en varios a la
vez, la lista va en `STATUS_CHANNEL_IDS`.

## Configuración

- **`.env`** — token, canales, roles, intervalo, timeouts y rutas. Está
  documentado entero en `.env.example`.
- **`inventory.yaml`** — qué se monitoriza: webs, servicios agrupados, sensores
  con sus umbrales, qué bloques se muestran y los umbrales de alerta. Está
  comentado en `inventory.yaml.example`.

Un `.env` o un `inventory.yaml` mal puestos **abortan el arranque** diciendo qué
clave falla, en vez de arrancar a medias.

## Arquitectura

Hexagonal (puertos y adaptadores):

```
src/
├── domain/           entidades, puertos y lógica pura (sin sistema ni Discord)
├── application/      casos de uso: recolectar, publicar, evaluar alertas
├── infrastructure/   adaptadores: systeminformation, hwmon, smartctl, systemd,
│                     HTTP, fail2ban, Discord y persistencia
└── index.ts          composition root: cablea puertos con adaptadores
```

`domain/` no importa nada de `infrastructure/`, y `application/` solo depende de
`domain/`. Eso es lo que permite testear los ciclos con dobles en vez de tocar el
sistema.

## Desarrollo

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm lint        # eslint
pnpm build       # esbuild -> dist/index.js
```

## Despliegue

El repositorio trae `deploy/server-status.service` (systemd de sistema) y un
`Makefile`:

```bash
make check      # typecheck, tests y lint
make deploy     # build + rsync a /srv/services/server-status + restart
make logs       # journalctl del servicio
```

El bundle de esbuild es autocontenido: `dist/index.js` no necesita
`node_modules` en destino. Ajusta las rutas del `Makefile` y del `.service` a tu
máquina.

## Licencia

MIT
