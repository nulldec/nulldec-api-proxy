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

**Por eso el primer despliegue desde aquí no fue un `wrangler deploy` normal.**
Las variables de entorno (`SUPABASE_HOST`, `SUPABASE_ANON_KEY`) y el dominio
personalizado `api.nulldec.com` se configuraron a mano en el panel de Cloudflare,
nunca desde un `wrangler.toml` — porque no había ninguno. **Ese estado se
confirmó contra la API de Cloudflare el 2026-08-13** y quedó declarado campo a
campo en `wrangler.toml`, con la procedencia de cada valor anotada ahí mismo.

De esa confirmación salió un dato que nadie esperaba: la `compatibility_date`
desplegada era **2026-07-01**, no la fecha del primer despliegue (2026-07-22),
que era lo que este repo había supuesto al nacer. Desplegar con la fecha
equivocada habría sido un cambio de runtime colado dentro de un despliegue cuyo
objetivo era otro.

Desde entonces el `wrangler.toml` es la fuente de verdad y un `npm run deploy`
normal es seguro. Lo único que sigue viviendo fuera del repo es el **valor** del
secreto `SUPABASE_ANON_KEY` — y su *existencia* sí está exigida desde el
fichero (`[secrets] required`), así que un despliegue sin él falla en vez de
publicar un Worker que autenticaría con `undefined`.

## Qué hace

- Aplica un límite de tasa por IP a un conjunto de rutas restringidas
  (`RESTRICTED_PATHS` en `src/index.ts`) llamando a la función `rate_limit_check`
  de Supabase antes de dejar pasar la petición. Lo que no esté en esa lista cae
  en un techo por defecto (600/60 s): acotado por defecto, abierto por decisión
  explícita.
- **Sirve `/v1/*` reescribiéndolo a `/functions/v1/*`**, conviviendo con la forma
  antigua, que sigue funcionando igual. Es una regla de prefijo pura: el Worker
  no conoce recursos ni verbos, y por eso no puede desincronizarse de un contrato
  que no conoce. Ambas formas comparten cubo de límite, así que migrar una ruta a
  `/v1/` no duplica su límite efectivo.
- Reenvía el resto del tráfico (y las peticiones que superan el límite)
  reescribiendo solo `hostname`, `protocol` y ese prefijo, hacia el proyecto de
  Supabase (`env.SUPABASE_HOST`).
- Si la llamada a `rate_limit_check` falla (la RPC no responde o no da `ok`), la
  petición **se deja pasar** — falla en abierto, a propósito: la autenticación
  real de esos endpoints es el secreto o la firma que llevan, no este límite.
  Ojo: eso significa que un fallo del límite **no se ve como error** en el
  tráfico, solo en los `console.error` — por eso la observabilidad está
  declarada como encendida en `wrangler.toml`.

**Las peticiones `OPTIONS` no pasan por ningún límite** (ni el específico ni el
por defecto). Es preexistente y de riesgo bajo —cada Edge Function responde al
preflight en su primera línea, sin tocar la base de datos— pero desde que existe
el techo por defecto es el único camino sin medir que queda. Pendiente de
decidir en la fase 2.

## Desarrollo

```powershell
npm install
npm run dev
```

## Despliegue

Este Worker está delante de **toda** la API. Para cambios que no sean triviales,
usa el despliegue en dos tiempos, que permite inspeccionar la versión antes de
que vea tráfico real:

```powershell
npm run upload    # sube la versión SIN servirla; producción no se entera
# comprobar aquí los bindings de la versión subida (que el secreto sigue ahí)
npm run promote   # la promueve a tráfico real
```

`wrangler versions deploy` **no toca los disparadores** (rutas y dominios
personalizados): eso solo lo hace `wrangler triggers deploy`. Es decir, promover
una versión no puede desvincular `api.nulldec.com`, que era el peor escenario.

Para un cambio trivial, `npm run deploy` hace las dos cosas de una vez.

### Reversión

Desde el historial de despliegues de Cloudflare, o promoviendo la versión
anterior por id. Conviene anotar el id de la versión buena **antes** de
desplegar.

### Autenticación

`wrangler` necesita sesión propia (`npx wrangler login`); no basta con tener
acceso al panel en el navegador.
