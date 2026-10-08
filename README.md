# nulldec-api-proxy

> ## El secreto compartido vive en TRES sitios
>
> Los tres tienen que llevar el mismo valor, y el límite de tasa del borde
> **falla en cerrado** si falta cualquiera: `api.nulldec.com` devolvería 429 a
> todo.
>
> | Dónde | Cómo se pone | Quién lo lee |
> |---|---|---|
> | Worker | `npx wrangler secret put PROXY_SHARED_SECRET` | lo manda como `x-nd-proxy` y como `p_secret` |
> | Edge Functions | secreto del proyecto Supabase | valida `x-nd-proxy` (`_shared/rate-limit.ts`) |
> | Vault | `select vault.create_secret(...)` | valida `p_secret` (`private.secreto_del_borde()`) |
>
> Los tres están puestos desde el **2026-09-21**. Comprobado ese día: la
> función acepta el secreto bueno y rechaza uno equivocado.
>
> Para verificarlo en cualquier momento, sin que el valor se vea:
>
> ```sql
> select private.secreto_del_borde() is not null as secreto_en_vault,
>        public.rate_limit_check_borde('vault:autocomprobacion', 1000, 60,
>                                      coalesce(private.secreto_del_borde(), 'x'))
>          as la_funcion_acepta;
> ```
>
> Si rotas el secreto, cámbialo en los tres a la vez. Detalle en
> `nulldec-context/deuda_tecnica.md` §5.47.

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

- Toda respuesta que genera el propio Worker lleva las mismas cabeceras CORS que
  las de las Edge Functions (`CORS_HEADERS`) y el cuerpo `{error, code}` de la
  API: 429 `rate_limited`, 504 `upstream_timeout` (Supabase sin cabeceras en
  `UPSTREAM_TIMEOUT_MS`, 120 s), 502 `upstream_unavailable` (el `fetch` lanza) y
  500 `internal_error` (cualquier otra excepción). Sin CORS, la consola ve
  cualquiera de ellas como un fallo de red opaco.
- Los handshakes WebSocket (`Upgrade: websocket`, Realtime en
  `/realtime/v1/websocket`) se reenvían igual y se devuelve la respuesta de
  Supabase sin tocar, sin plazo y sin envoltorio JSON.

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

## registry.nulldec.com (NullDec Node, 10 §6.3)

`registry/` es un Worker aparte (`nulldec-registry`): un registro de solo lectura delante de GHCR para
las imágenes privadas del nodo. No toca el Worker de `api.nulldec.com` ni su `wrangler.toml`.

- `docker login registry.nulldec.com -u nodo --password-stdin` con la credencial `ndo_` del nodo. El
  Worker pregunta al backend (`POST /functions/v1/nodos/registro/token`) qué repos y digests puede
  servir a ese nodo y firma un token de 5 minutos. La `ndo_` no se guarda ni se registra.
- Solo sirve manifiestos por digest (nunca por etiqueta) de versiones no retiradas, y las capas por
  redirección a GHCR, sin pasarlas por el Worker.

Despliegue (tarea del propietario, una vez):

1. DNS: `registry.nulldec.com` como dominio personalizado del Worker (lo declara `registry/wrangler.toml`).
2. Secretos: `wrangler secret put REGISTRY_JWT_SECRET` (32 bytes aleatorios), `GHCR_USER` y
   `GHCR_TOKEN` (un token de GitHub con solo `read:packages`), desde `registry/`.
3. `cd registry && npx wrangler deploy`.
4. Con el interruptor `nodo_registro` apagado, el backend responde 404 y el Worker niega todo.
