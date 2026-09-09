/**
 * nulldec-api-proxy — el Worker de Cloudflare que ES api.nulldec.com.
 *
 * Todo el tráfico de la API pasa por aquí: aplica los límites de tasa del
 * borde a las rutas restringidas y reenvía el resto (reescribiendo
 * `hostname`, `protocol` y, si aplica, el prefijo `/v1/`) al proyecto de
 * Supabase.
 *
 * Esta fuente se reconstruyó el 2026-08-13 a partir del bundle desplegado
 * en Cloudflare (ver README.md de este repo para el porqué). La tarea 6
 * verificó la reconstrucción byte a byte contra el bundle real; la tarea 7
 * cambió el emparejador de rutas restringidas (por sufijo → por método +
 * patrón). Esta tarea (8) añade la reescritura `/v1/*` → `/functions/v1/*`:
 * el Worker sigue sin conocer recursos ni verbos — es una única regla de
 * prefijo, no un router — para que no pueda desincronizarse de un contrato
 * que no conoce (spec §3). `/functions/v1/*` sigue funcionando exactamente
 * igual que antes de esta tarea.
 */

export interface Env {
  SUPABASE_HOST: string;
  SUPABASE_ANON_KEY: string;
  /**
   * Secreto compartido con las Edge Functions, que autoriza la cabecera
   * `x-nd-real-ip` que este Worker inyecta. Ver `cabecerasHaciaSupabase`.
   *
   * Se pone con `npx wrangler secret put PROXY_SHARED_SECRET`, nunca en
   * `wrangler.toml` ni en git: quien lo tenga puede decidir en qué cubo de
   * límite cae, que es exactamente lo que la cabecera viene a controlar.
   *
   * OPCIONAL a propósito. Sin él, el Worker no manda `x-nd-proxy`, la Edge
   * Function no se cree el `x-real-ip` y cae a `cf-connecting-ip` — el
   * comportamiento de antes. Eso permite desplegar backend primero y Worker
   * después sin ninguna ventana rara, que es el orden que pide el arreglo.
   */
  PROXY_SHARED_SECRET?: string;
}

export interface LimiteRuta {
  // Hoy TODAS las entradas declaran "*" a propósito. El campo existe porque el
  // spec §6 lo pide y porque la fase 2 lo necesitará de verdad (distinguir un
  // `GET /v1/decoys` de un `POST /v1/decoys` sobre el mismo patrón), pero
  // estrechar una entrada a un método concreto RELAJA el control que hoy está
  // vivo: el emparejador anterior a la fase 1 casaba por sufijo, sin mirar el
  // método, así que cualquier verbo caía en el cubo estricto. Poner
  // `method: "POST"` deja el resto de verbos fuera de ese cubo, y con el techo
  // por defecto pasan de 5/hora a 600/minuto sin que nadie lo note. Estrechar
  // cada entrada es una decisión de la fase 2, ruta a ruta y a propósito, no un
  // efecto colateral de reescribir el emparejador.
  method: string | "*";
  pattern: string; // admite segmentos ":param", p.ej. "/v1/decoys/:id/test"
  // El bucket (nombre del cubo del límite) se declara aparte del patrón y
  // NO se deriva de él a propósito: si algún día se renombra una ruta, el
  // límite no debe reiniciarse en silencio por haber cambiado de clave.
  // Estos 9 nombres son los que tienen contadores vivos en producción —
  // no cambiarlos aunque cambie `pattern`.
  bucket: string;
  limit: number;
  windowSeconds: number;
}

// Techo por defecto para lo no listado explícitamente abajo. Antes de esta
// tarea, lo que no aparecía en RESTRICTED_PATHS no tenía límite ninguno.
// Misma inversión que se hizo en la base de datos en la fase 0: acotado por
// defecto, abierto por decisión explícita (añadiendo una entrada más
// estricta a RESTRICTED_PATHS).
export const DEFAULT_BUCKET = "default";
export const DEFAULT_LIMIT = 600;
export const DEFAULT_WINDOW_SECONDS = 60;

/**
 * ...pero el techo NO es universal, y esa acotación es el arreglo, no un
 * descuido.
 *
 * Este Worker no es «la API»: es `api.nulldec.com`, y reenvía el proyecto de
 * Supabase ENTERO sin condición sobre el pathname. Por aquí pasan `/rest/v1`
 * (PostgREST) y `/auth/v1` (GoTrue) — las dos consolas apuntan ahí su cliente
 * de supabase-js— además de `/realtime/v1`, `/storage/v1`… Un techo aplicado a
 * todo el pathname metería un `rate_limit_check` secuencial (un viaje de ida y
 * vuelta MÁS una escritura en Postgres) delante de cada lectura de PostgREST de
 * la consola: justo lo contrario de la ronda de optimización del 2026-08-05.
 *
 * La restricción de la fase 1 es que ninguna ruta cambie de comportamiento. El
 * techo se aplica por tanto solo a la superficie de API (`/v1/…` y su forma
 * antigua `/functions/v1/…`), que es donde la fase 2 va a colgar los recursos
 * REST; todo lo demás se reenvía sin límite de borde, exactamente como antes de
 * la fase 1. Las 9 entradas explícitas de RESTRICTED_PATHS siguen aplicándose
 * igual, estén donde estén.
 *
 * Si `/rest/v1` merece un techo propio es una decisión aparte —con su propio
 * cubo, su propio límite y una medida del coste añadido por petición— y no se
 * toma aquí.
 */
export function tieneTechoPorDefecto(pathname: string): boolean {
  return pathname.startsWith("/v1/") || pathname.startsWith("/functions/v1/");
}

// Las NUEVE entradas declaran `method: "*"`. Ver el comentario de `method` en
// `LimiteRuta`: es la semántica idéntica a la desplegada antes de la fase 1
// (donde se casaba por sufijo, sin mirar el método), y estrechar cualquiera de
// ellas es trabajo de la fase 2, no de aquí.
export const RESTRICTED_PATHS: LimiteRuta[] = [
  // Categoría A — crean recursos reales de pago, en nuestra cuenta o en
  // la del propio cliente. Las más estrictas de todas.
  { method: "*", pattern: "/v1/aws-tenant-deploy-decoy", bucket: "aws-tenant-deploy", limit: 20, windowSeconds: 3600 },
  { method: "*", pattern: "/v1/azure-tenant-deploy-decoy", bucket: "azure-tenant-deploy", limit: 5, windowSeconds: 3600 },
  { method: "*", pattern: "/v1/github-actions-issue-decoy", bucket: "gh-actions-issue", limit: 60, windowSeconds: 3600 },
  // Categoría C — exponen datos sensibles o permiten generar claves.
  //
  // list-network-identifiers acepta GET y POST (verificado en el propio
  // handler): un método fijo la habría relajado incluso antes de saber lo
  // anterior.
  { method: "*", pattern: "/v1/list-network-identifiers", bucket: "list-net-ids", limit: 3, windowSeconds: 60 },
  // ── Las claves SIEM ──
  // `pathMatchesPattern` exige mismo numero de segmentos, asi que
  // `/v1/manage-siem-keys` (2) NO casaba `/v1/keys/siem` (3). Al migrar el
  // recurso `keys` a `/v1/` en la fase 2.2e, la generacion de claves SIEM se
  // quedo sin cubo propio y cayo al techo por defecto: de 10/hora a 600/60 s, o
  // sea 3.600 veces mas margen para emitir credenciales de maquina. Nadie lo
  // noto porque fallar en abierto es justo lo que hace este Worker cuando no
  // encuentra regla. Se arreglo declarando las DOS formas contra un unico cubo.
  //
  // El 2026-09-03 se borro `manage-siem-keys` del backend —la consola llevaba
  // en `/v1/keys/siem` y no le quedaba ni un llamante— y con ella se va su
  // linea de aqui, tal y como decia este comentario que habria que hacer. Queda
  // una sola entrada. El nombre del cubo NO cambia: `rl:manage-siem-keys:<ip>`
  // son contadores vivos en produccion y renombrarlo los pondria a cero para
  // todo el mundo durante una ventana entera, sin dejar rastro.
  { method: "*", pattern: "/v1/keys/siem", bucket: "manage-siem-keys", limit: 10, windowSeconds: 3600 },

  // ── El alta de agentes por token de organizacion ──
  // Mismo criterio que la linea de arriba, y con mas alcance: una clave SIEM
  // deja leer; un token de enrolamiento da de alta AGENTES en la organizacion
  // entera, y sirve para todas las maquinas que quepan en su `max_uses`. Es la
  // credencial mas amplia que emite el producto.
  //
  // Sin esta regla caia al techo por defecto (600/60 s), que es exactamente el
  // agujero que la migracion de `keys` abrio con las claves SIEM y que nadie
  // noto durante una fase entera: este Worker falla en ABIERTO cuando no
  // encuentra patron, asi que una ruta nueva sin linea aqui no da error, da
  // barra libre.
  //
  // Tres segmentos, y el `*` NO es descuido: el `GET` de la misma ruta lista
  // los tokens y no cuesta nada, pero un cubo por verbo obligaria a repetir la
  // entrada y la asimetria entre leer y emitir ya la impone el backend
  // (`mfa: true` solo en el POST). 10/hora es de sobra para una campana de
  // despliegue, que es el caso real.
  { method: "*", pattern: "/v1/keys/agent/enrollment", bucket: "agent-enrollment", limit: 10, windowSeconds: 3600 },

  // ── Las dos rutas de la documentacion privada (2026-09-04) ──
  //
  // Sin entrada propia caerian al techo por defecto (600/60 s). No es que
  // 600 sea absurdo aqui; es que las dos cosas que pasan por estas rutas
  // merecen limites DISTINTOS, y con un solo cubo compartido la que se abusa
  // estrangula a la otra.
  //
  // `/v1/docs/ticket` emite una CREDENCIAL de entrada. Se pide una por clic en
  // "Documentacion", asi que 60/hora es holgado para una persona y ridiculo
  // para un bucle. Ademas `emitir_docs_ticket()` aplica su propio tope de 5
  // vales vivos por persona, que es la barrera de verdad: esto es el techo de
  // borde que evita que el bucle llegue siquiera a la base.
  //
  // `/v1/docs/sesion` la llama el SERVIDOR de docs, no un navegador, y una vez
  // por entrada. El limite alto es deliberado: el cubo es por IP, y todas las
  // peticiones legitimas salen de las MISMAS IPs (los datacenters de
  // Cloudflare Pages), asi que un techo estrecho aqui lo agotaria el trafico
  // bueno de toda la clientela junta y dejaria a nadie entrar en la
  // documentacion. Quien no tenga el secreto compartido recibe 401 de todas
  // formas.
  { method: "*", pattern: "/v1/docs/ticket", bucket: "docs-ticket", limit: 60, windowSeconds: 3600 },
  { method: "*", pattern: "/v1/docs/sesion", bucket: "docs-sesion", limit: 600, windowSeconds: 60 },

  // ── El envio de prueba de canales ──
  // Manda correo (Resend), Telegram y Slack DE VERDAD, a los destinos que la
  // organizacion tenga puestos. Mismo razonamiento que `/v1/contact-sales` de
  // mas abajo: sin techo, la unica barrera contra usar nuestra
  // infraestructura para floodear un buzon o un canal de Slack es que a nadie
  // se le ocurra.
  //
  // La diferencia con `contact-sales` es que aqui hace falta sesion, asi que
  // el atacante ya es un cliente identificado y auditado. Por eso 20/hora y no
  // 5: comprobar que un canal recien configurado funciona es algo que se hace
  // varias veces seguidas, y estrangularlo devolveria a la situacion que la
  // prueba existe para evitar — enterarse de que Slack no llega el dia del
  // primer ataque de verdad.
  { method: "*", pattern: "/v1/preferences/test", bucket: "preferences-test", limit: 20, windowSeconds: 3600 },
  { method: "*", pattern: "/v1/verify-turnstile", bucket: "verify-turnstile", limit: 20, windowSeconds: 3600 },
  // Envía correo real (Resend) a sales@nulldec.com — sin este límite, la
  // única barrera contra flood del buzón de ventas sería Turnstile, que un
  // humano decidido puede seguir resolviendo a mano una y otra vez. Una
  // consulta legítima es una acción puntual, no repetida — 5/hora es
  // generoso para eso y corta cualquier intento de saturar el buzón.
  { method: "*", pattern: "/v1/contact-sales", bucket: "contact-sales", limit: 5, windowSeconds: 3600 },
  // Categoría B — puntos de entrada públicos, ya con secreto o firma,
  // pero conviene un techo aparte por si el secreto se filtrara.
  //
  // handle-aws-signal no tiene límite ESPECÍFICO a propósito: quien la
  // llama siempre es la propia infraestructura de AWS (EventBridge),
  // nunca el atacante directamente — un cubo estricto por IP distinguiría
  // "AWS" de "todo lo demás", no "abuso" de "tráfico normal". Lo que la
  // protege de verdad es el secreto compartido y la Capa 1.
  // Sí cae, eso sí, bajo el techo por defecto (600/60 s por IP), porque
  // vive en `/v1/…`: no está exenta de límite, está exenta de uno propio.
  { method: "*", pattern: "/v1/handle-network-signal", bucket: "handle-network-signal", limit: 120, windowSeconds: 60 },
  // Alta interacción — list-interactive-credentials, que era la ruta más
  // sensible de todo el sistema (exponía en claro las credenciales de
  // todos los clientes si el secreto global se filtraba), se eliminó del
  // paso 3 de esta tarea: devuelve 404 desde la fase 0 y el 2026-08-11, así
  // que ya no hay nada que limitar ahí. Queda handle-interactive-signal,
  // sin ese riesgo de exposición masiva, con su propio límite.
  { method: "*", pattern: "/v1/handle-interactive-signal", bucket: "handle-interactive-signal", limit: 60, windowSeconds: 60 },

  // ── Superficie del Agente NullDec (añadida 2026-08-18) ──
  //
  // Las tres estaban en el techo por defecto (600/60 s), y dos de ellas no
  // deberían: son públicas (verify_jwt=false) y una de ellas CREA FILAS.
  //
  // agent-enroll: autenticado por un token que viaja dentro del paquete MSI
  // que se reparte por toda la organización — hay que asumir que se filtra.
  // El tope de usos del propio token es la barrera de "cuántas máquinas";
  // esto es la barrera de "cuánto se puede machacar Postgres".
  //
  // El número tiene en cuenta el NAT: en un despliegue por Intune las 500
  // máquinas de una sede salen por la MISMA IP pública, así que un límite
  // demasiado estrecho rompería un despliegue legítimo. 120/min deja pasar
  // una tanda de 120 máquinas por minuto —más rápido de lo que Intune
  // entrega— y baja el techo de abuso de 36.000 a 7.200 altas por hora.
  { method: "*", pattern: "/v1/agent-enroll", bucket: "agent-enroll", limit: 120, windowSeconds: 60 },

  // handle-agent-signal es un endpoint de INGESTA, hermano de
  // handle-network-signal (120/60) y handle-interactive-signal (60/60), y era
  // el único de los tres sin límite propio. Se le pone el mismo que a
  // handle-network-signal: son el mismo tipo de tráfico —una activación
  // reportada desde la red del cliente— y no hay motivo para que difieran.
  { method: "*", pattern: "/v1/handle-agent-signal", bucket: "handle-agent-signal", limit: 120, windowSeconds: 60 },

  // ── passkeys: TRES entradas, UN cubo ──
  //
  // Tres porque `pathMatchesPattern` casa estricto por número de segmentos, y
  // el recurso tiene tres formas: `/v1/passkeys` (2), `/v1/passkeys/:id` (3) y
  // `/v1/passkeys/:accion/:fase` (4, que cubre las cuatro rutas POST de
  // registro y step-up). Una sola entrada dejaría las otras dos en el techo
  // por defecto — que es exactamente cómo `manage-siem-keys` perdió su límite
  // al migrar de `/v1/manage-siem-keys` a `/v1/keys/siem`.
  //
  // Un cubo porque el límite debe ser del RECURSO, no de cada forma de
  // llamarlo: si no, pedir opciones y verificar tendrían 120 cada uno.
  //
  // 120/min y no menos por el NAT: una oficina entera sale por una IP, y
  // dejar fuera a una sede de una consola de SEGURIDAD es peor fallo que el
  // que este techo evita. Aun así baja el abuso de 36.000/hora a 7.200.
  //
  // ⚠️ Es un instrumento romo, y conviene saberlo: el Worker solo ve la IP,
  // pero estas rutas exigen sesión autenticada con segundo factor, así que el
  // abuso realista viene de UNA sesión comprometida — y contra eso lo que
  // sirve es un límite por usuario, que solo puede aplicarse dentro de la
  // función. Esto acota el daño; no lo previene.
  //
  // Lo que de verdad sujetaba el crecimiento de `webauthn_retos` es la purga
  // horaria (migración 20260829180102), no este techo.
  { method: "*", pattern: "/v1/passkeys", bucket: "passkeys", limit: 120, windowSeconds: 60 },
  { method: "*", pattern: "/v1/passkeys/:id", bucket: "passkeys", limit: 120, windowSeconds: 60 },
  { method: "*", pattern: "/v1/passkeys/:accion/:fase", bucket: "passkeys", limit: 120, windowSeconds: 60 },
];

/**
 * Compara una ruta contra un patrón que admite segmentos ":param" (comodín
 * de un único segmento) y acepta las dos formas de prefijo que conviven
 * durante la migración: "/functions/v1/<fn>" (forma antigua, la que sigue
 * usando parte del tráfico existente) y "/v1/<fn>" (forma nueva). Todos los
 * patrones de RESTRICTED_PATHS se escriben en la forma "/v1/…"; esta función
 * normaliza el prefijo antes de comparar, así que casan ambas formas sin
 * duplicar entradas.
 */
export function pathMatchesPattern(pathname: string, pattern: string): boolean {
  const normalized = pathname.startsWith("/functions/v1/")
    ? "/v1/" + pathname.slice("/functions/v1/".length)
    : pathname;

  const pathSegments = normalized.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  if (pathSegments.length !== patternSegments.length) return false;

  return patternSegments.every((seg, i) => seg.startsWith(":") || seg === pathSegments[i]);
}

/**
 * `entradas` es un parámetro con valor por defecto para poder probar el
 * MECANISMO (la discriminación por método) con una fixture propia, llamando a
 * esta misma función en vez de reimplementar su condición en la prueba. Una
 * prueba que reimplementa lo que dice probar pasa aunque la función no haga
 * nada: comprobado — borrar la comprobación del método de aquí dejaba la suite
 * entera en verde. Todos los puntos de llamada reales omiten el argumento y
 * siguen usando RESTRICTED_PATHS.
 */
export function matchRestrictedPath(
  method: string,
  pathname: string,
  entradas: LimiteRuta[] = RESTRICTED_PATHS,
): LimiteRuta | undefined {
  return entradas.find(
    (r) => (r.method === "*" || r.method === method) && pathMatchesPattern(pathname, r.pattern),
  );
}

/**
 * Colapsa barras repetidas. **Solo para DECIDIR el límite, nunca para lo que se
 * reenvía.**
 *
 * Cloudflare entrega el pathname sin colapsar las barras, y esa forma llega a
 * la función real: verificado contra producción, `api.nulldec.com//functions/v1/
 * <lo-que-sea>` devuelve el `NOT_FOUND` del router de funciones de Supabase, no
 * un error del borde. Sin colapsarlas aquí, `//functions/v1/contact-sales` no
 * casa su entrada estricta (3 segmentos contra 2) NI la superficie de API
 * (`startsWith("/v1/")` falla por la barra de más), así que se saltaba el cubo
 * de 5/hora Y el techo por defecto: cero límite, con una sola tecla de más.
 * Alcanzaba a `aws-tenant-deploy-decoy` y `azure-tenant-deploy-decoy`, que
 * crean recursos de pago reales.
 *
 * Se normaliza en la dirección segura: casar de MÁS, nunca de menos. Que dos
 * formas distintas de escribir la misma ruta compartan cubo es exactamente lo
 * que se quiere; que una de ellas no tenga cubo, no.
 *
 * **Lo que se reenvía sigue siendo el pathname original, sin tocar.** El
 * Worker no decide qué es la misma ruta para Supabase — eso es del router de
 * funciones, y normalizar la URL saliente sería cambiar el destino de una
 * petición, no su límite. Aquí se normaliza una COPIA para tomar una decisión,
 * y se tira. Si alguien "simplifica" esto reasignando `url.pathname`, cambia el
 * comportamiento de reenvío de la fase 1, que es justo lo que la fase 1 se
 * compromete a no tocar.
 */
export function normalizarParaLimite(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/");
}

/**
 * Reescribe el prefijo `/v1/` a `/functions/v1/` antes de reenviar. Es toda
 * la regla de enrutado que conoce el Worker: no sabe qué recursos ni verbos
 * hay detrás de cada ruta, solo reconoce un prefijo. Es justo lo que impide
 * que el Worker se desincronice de un contrato que no conoce (spec §3) — si
 * esta función alguna vez necesita saber de un recurso concreto, es la señal
 * de que esa lógica se está colando donde no debe.
 *
 * `/functions/v1/*` no se toca — sigue funcionando exactamente igual que
 * antes de esta regla, ambos prefijos conviven.
 *
 * Solo se reescribe cuando `/v1/` es el propio prefijo del pathname
 * (barra final incluida): `/v1` a secas (sin barra) no casa y pasa igual,
 * y un `/v1/` que aparezca más adelante en la ruta — p.ej.
 * `/functions/v1/algo/v1/otro` — tampoco, porque no es una sustitución
 * global sobre el string, es una regla de prefijo.
 */
export function reescribirPrefijoV1(pathname: string): string {
  if (!pathname.startsWith("/v1/")) return pathname;
  return "/functions/v1/" + pathname.slice("/v1/".length);
}

async function checkAndIncrement(
  env: Env,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    // ── `rate_limit_check_borde`, no `rate_limit_check` ──
    //
    // La de tres argumentos tenía `execute` para `anon`, y como quien llama
    // elige la clave del cubo, cualquiera con la clave anónima —que va en el
    // bundle del navegador— podía agotar el cubo de una IP ajena y dejarla sin
    // servicio en toda la API. Comprobado contra producción el 2026-09-08 con
    // una clave inventada: `true`, `true`, `false`.
    //
    // La versión del borde exige el secreto compartido que este Worker ya
    // tiene, y a la de antes se le retiró el `execute` de `anon`. No se usó una
    // clave de servicio a propósito: se salta la RLS de todas las tablas, y un
    // arreglo no debería ampliar lo que este componente puede hacer.
    const res = await fetch(`https://${env.SUPABASE_HOST}/rest/v1/rpc/rate_limit_check_borde`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: env.SUPABASE_ANON_KEY,
        authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        p_key: key,
        p_limit: limit,
        p_window_seconds: windowSeconds,
        p_secret: env.PROXY_SHARED_SECRET ?? "",
      }),
    });
    if (!res.ok) {
      // Falla en abierto a propósito: la autenticación real de estas rutas
      // es el secreto/JWT, no el límite de tasa, así que un hipo de la base
      // de datos no debe convertirse en un corte de tráfico legítimo.
      console.error("rate_limit_check falló:", res.status, await res.text());
      return true;
    }
    return await res.json();
  } catch (err) {
    // El mismo fallo en abierto, pero para el caso que el `!res.ok` no
    // cubre: `fetch` LANZA (DNS, TLS, corte de red contra Supabase) o el
    // cuerpo no es JSON parseable. Sin este catch, la promesa rechazaba y
    // el Worker devolvía un 1101/500 a una petición perfectamente legítima
    // — es decir, un fallo de la base de datos SÍ cortaba el tráfico, justo
    // lo que el `return true` de arriba existe para evitar. Es la misma
    // decisión, no una nueva.
    console.error("rate_limit_check lanzó:", err);
    return true;
  }
}

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Sin esto, cuando el límite se alcanza desde la consola (varias
      // de las rutas restringidas se llaman desde el navegador), el
      // navegador bloquea la respuesta por CORS antes de que el código
      // de la consola pueda mostrar el mensaje real — se vería como un
      // fallo de red genérico, no como "límite excedido".
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type, apikey, x-client-info",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      // Sin exponer esta cabecera, la consola recibe el 429 pero no puede
      // leer `retry-after` (el CORS por defecto solo deja leer un puñado
      // de cabeceras "seguras", y esta no es una de ellas) — solo puede
      // decir "límite excedido" a secas, sin poder decir cuánto esperar.
      "access-control-expose-headers": "retry-after",
      ...extraHeaders,
    },
  });
}

/**
 * Las cabeceras con las que se reenvía la petición a Supabase.
 *
 * ── El problema que resuelve (medido el 2026-09-07) ──
 *
 * `cf-connecting-ip` NO sobrevive a este salto. El Cloudflare que Supabase
 * tiene delante la SOBRESCRIBE con el par de conexión, y en el camino
 * `navegador → api.nulldec.com → Supabase` ese par es este Worker. Así que las
 * Edge Functions veían siempre la misma IP —un rango de Cloudflare— y sus
 * límites de tasa, que creen ser por cliente, eran GLOBALES.
 *
 * Una sola petición pública a `/v1/sso/resolver` dejó las dos filas a 0,9 s:
 *
 *     rl:default:160.79.106.128               ← lo que ve este Worker
 *     rl:fn:sso-resolver:2a06:98c0:3600::103  ← lo que veía la Edge Function
 *
 * El efecto: ~1-2 req/s GLOBALES para el login SSO de toda la plataforma, y
 * 6/min para la previsualización de invitaciones. Falla hacia limitar de más
 * —no hay puerta abierta— pero desde una máquina cualquiera se deja sin SSO a
 * todos los clientes a la vez.
 *
 * ── Por qué va con secreto y no a pelo ──
 *
 * `x-real-ip` la puede poner cualquiera que llame directo a `<ref>.supabase.co`
 * saltándose este Worker, y ahí está el relé de OpenCanary haciéndolo a diario.
 * Aceptarla sin verificar convertiría TODOS los límites en decorativos:
 * bastaría mandar una IP distinta en cada petición para tener un cubo nuevo
 * cada vez. Es literalmente el agujero que `_shared/rate-limit.ts` vino a
 * cerrar. El secreto es lo que distingue «esta IP la puso el borde» de «esta
 * IP la puso quien llama».
 *
 * ── Por qué `x-nd-real-ip` y no `x-real-ip` ni `x-forwarded-for` ──
 *
 * La primera versión usaba `x-real-ip`, y NO FUNCIONÓ. Medido en producción el
 * 2026-09-08: el Worker escribía la IP del cliente y la Edge Function recibía
 * `2a06:98c0:3600::103` —el propio Worker—, exactamente el valor que ya traía
 * `cf-connecting-ip`. `x-real-ip` es una cabecera GESTIONADA por el borde de
 * Supabase, que la reescribe con el par de conexión igual que hace con
 * `cf-connecting-ip`. Se ve en sus propios registros de borde: `x_real_ip` es
 * uno de los pocos campos de cabecera que anotan, junto a `cf_connecting_ip`,
 * y los dos valían lo mismo.
 *
 * De ahí el prefijo `x-nd-`: es el que ya usan las cabeceras propias del
 * proyecto que SÍ llegan (`x-ingest-secret`, `x-network-shared-secret`,
 * `x-api-key`), y nadie por el camino tiene opinión sobre ellas.
 *
 * `x-forwarded-for` se descarta por otro motivo, y sigue descartada: es una
 * lista de saltos a la que el Cloudflare de Supabase añade el suyo, así que el
 * extremo del que hay que leer depende de por dónde entró la petición.
 */
export function cabecerasHaciaSupabase(request: Request, env: Env, clientIp: string): Headers {
  const cabeceras = new Headers(request.headers);
  // Se BORRAN primero, siempre. Sin esto, quien llame a `api.nulldec.com` con
  // su propio `x-nd-proxy` y su propia `x-nd-real-ip` tendría el par completo
  // intacto si el Worker no tiene secreto configurado — y con el secreto
  // correcto adivinado, elegiría su cubo. Se limpian y solo las repone este
  // Worker.
  //
  // `x-real-ip` se borra también, aunque ya no se use: la reescribe el borde de
  // Supabase de todas formas, y dejar pasar un valor de quien llama en una
  // cabecera con ese nombre solo invita a que alguien vuelva a fiarse de ella.
  cabeceras.delete("x-nd-real-ip");
  cabeceras.delete("x-nd-proxy");
  cabeceras.delete("x-real-ip");
  if (env.PROXY_SHARED_SECRET && clientIp !== "unknown") {
    cabeceras.set("x-nd-real-ip", clientIp);
    cabeceras.set("x-nd-proxy", env.PROXY_SHARED_SECRET);
  }
  return cabeceras;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const clientIp = request.headers.get("cf-connecting-ip") ?? "unknown";

    if (request.method !== "OPTIONS") {
      // Barras colapsadas SOLO para decidir — ver `normalizarParaLimite`. La
      // URL que se reenvía más abajo parte de `request.url` intacto.
      const pathParaLimite = normalizarParaLimite(url.pathname);

      const restricted = matchRestrictedPath(request.method, pathParaLimite);
      // Sin entrada explícita, solo hay límite si la ruta está en la
      // superficie de API — ver `tieneTechoPorDefecto`. Fuera de ella
      // (`/rest/v1`, `/auth/v1`, …) no se llama a la RPC siquiera: el coste
      // del límite es una escritura en Postgres por petición y no se paga
      // en el camino que la consola usa para leer.
      const aplica = restricted !== undefined || tieneTechoPorDefecto(pathParaLimite);

      if (aplica) {
        const bucket = restricted?.bucket ?? DEFAULT_BUCKET;
        const limit = restricted?.limit ?? DEFAULT_LIMIT;
        const windowSeconds = restricted?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;

        const key = `rl:${bucket}:${clientIp}`;
        const allowed = await checkAndIncrement(env, key, limit, windowSeconds);
        if (!allowed) {
          return jsonResponse(
            { error: "límite de peticiones excedido para esta operación" },
            429,
            { "retry-after": String(windowSeconds) },
          );
        }
      }
    }

    const upstream = new URL(request.url);
    upstream.hostname = env.SUPABASE_HOST;
    upstream.protocol = "https:";
    // Orden decidido a propósito: el límite de tasa de arriba ya evaluó
    // `url.pathname` SIN reescribir, y da igual — `pathMatchesPattern`
    // normaliza `/functions/v1/` y `/v1/` como la misma ruta antes de
    // comparar (ver su comentario), así que este paso podría ir antes o
    // después del límite sin cambiar el resultado. Se reescribe aquí, al
    // construir la URL de destino, porque es donde ya se tocan `hostname`
    // y `protocol` — una sola parada para las mutaciones de la URL
    // saliente. `search` y `hash` no se tocan, así que sobreviven tal cual.
    upstream.pathname = reescribirPrefijoV1(upstream.pathname);
    // ── Por qué en DOS pasos y no con un init completo ──
    //
    // La forma obvia —`new Request(url, { method, headers, body: request.body })`—
    // lanza `duplex option is required when sending a body` en undici (que es
    // donde corren las pruebas) aunque el runtime de Workers no lo pida.
    // Depender de esa diferencia entre entornos es tener una prueba que no
    // ejerce lo que se despliega.
    //
    // Con dos pasos, el cuerpo viaja como el de OTRA Request y no como un
    // flujo suelto, así que ningún runtime pide `duplex`: el primero clona la
    // petición hacia el destino nuevo (método, cuerpo y todo lo demás), y el
    // segundo solo sustituye las cabeceras.
    const haciaSupabase = new Request(upstream.toString(), request);
    const proxied = new Request(haciaSupabase, {
      headers: cabecerasHaciaSupabase(request, env, clientIp),
    });
    return fetch(proxied);
  },
};
