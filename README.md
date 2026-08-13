# nulldec-api-proxy

## De dónde sale este repositorio

Este Worker de Cloudflare **es** `api.nulldec.com`: todo el tráfico de la API pasa
por él, y aplica los límites de tasa del borde antes de reenviar cada petición al
proyecto de Supabase. Está en producción desde el **2026-07-22**, pero hasta hoy
**no tenía repositorio**: su única copia era el bundle desplegado en Cloudflare,
construido desde un `src/index.ts` que no vivía en ningún control de versiones.

La fuente de este repo se **reconstruyó el 2026-08-13** leyendo ese bundle
desplegado (`workers_get_worker_code`) y traduciéndolo de vuelta a TypeScript:
quitando los envoltorios que añade el empaquetador (`__defProp`, `__name`) y
devolviendo los tipos, sin cambiar ninguna línea de lógica. Se verificó la
equivalencia comparando un `wrangler deploy --dry-run` de este repo contra el
bundle original — punto por punto, no solo byte a byte, porque una versión
distinta del empaquetador nunca produce el mismo bundle exacto. Detalle completo
de esa comprobación en `nulldec-context/deuda_tecnica.md` §2.4 y en el informe de
la tarea que creó este repo.

**Por eso el primer despliegue desde aquí no es un `wrangler deploy` normal.**
Las variables de entorno (`SUPABASE_HOST`, `SUPABASE_ANON_KEY`) y el dominio
personalizado `api.nulldec.com` se configuraron a mano en el panel de Cloudflare,
nunca desde un `wrangler.toml` — porque no había ninguno. Antes de desplegar desde
este repo por primera vez hay que confirmar en el panel qué variables tiene el
Worker y con qué valores, y si `api.nulldec.com` está enlazado como Custom Domain
o como Route, y declararlo explícitamente en `wrangler.toml`. Ver el aviso dentro
de ese fichero.

## Qué hace

- Aplica un límite de tasa por IP a un conjunto de rutas restringidas
  (`RESTRICTED_PATHS` en `src/index.ts`) llamando a la función `rate_limit_check`
  de Supabase antes de dejar pasar la petición.
- Reenvía el resto del tráfico (y las peticiones que superan el límite)
  reescribiendo solo `hostname` y `protocol` de la URL, hacia el proyecto de
  Supabase (`env.SUPABASE_HOST`).
- Si la llamada a `rate_limit_check` falla (la RPC no responde o no da `ok`), la
  petición **se deja pasar** — falla en abierto, a propósito: la autenticación
  real de esos endpoints es el secreto o la firma que llevan, no este límite.

## Desarrollo

```powershell
npm install
npm run dev
```

## Despliegue

**No desplegar sin haber completado la sección "De dónde sale este repositorio"
de arriba.** Una vez confirmadas las variables y el dominio en `wrangler.toml`:

```powershell
npm run deploy
```
