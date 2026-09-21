/**
 * Resolución de la IP del cliente cuando hay un relé delante de Cloudflare.
 *
 * ⚠ ESTE FICHERO ESTÁ DUPLICADO, BYTE A BYTE, EN OTRO REPOSITORIO:
 *   nulldec-api-proxy/src/rele.ts   ←→   nulldec-infra/shared/rele.ts
 *
 * No es pereza: son dos repositorios git distintos y no hay forma de
 * compartir un módulo entre ellos sin publicar un paquete, que para 200
 * líneas es peor remedio que la enfermedad. Los dos Workers que hay detrás
 * del relé (`api.nulldec.com` e `ingest.nulldec.com`) tienen que aplicar
 * EXACTAMENTE la misma regla: si uno acepta una cabecera que el otro rechaza,
 * el atacante usará el que acepte.
 *
 * **Al tocar este fichero, copiarlo al otro repositorio y comprobar con
 * `md5sum` que coinciden.** Cada repo tiene su propia copia de las pruebas,
 * así que las dos suites tienen que seguir en verde por separado.
 *
 * ── Por qué existe este fichero ──
 *
 * Los ISP españoles bloquean por IP de DESTINO rangos enteros de Cloudflare
 * durante los partidos de fútbol (órdenes judiciales de LaLiga). Como
 * `api.nulldec.com`, `ingest.nulldec.com` y las consolas viven todos en IPs de
 * Cloudflare, durante esas ventanas NullDec entero desaparece para cualquiera
 * que salga por un ISP español. La solución es un relé propio en Hetzner
 * (Alemania, fuera de cualquier lista) que termina TLS y re-origina la
 * petición hacia Cloudflare:
 *
 *     usuario ES → LB Hetzner → vps-N (nginx) → *-cf.nulldec.com → Worker
 *
 * ── Lo que ese relé ROMPE, y que este fichero repara ──
 *
 * Hoy la IP del cliente NO es un dato que viaje en la petición: es algo que
 * Cloudflare OBSERVA al recibir el paquete y escribe en `cf-connecting-ip`,
 * sobrescribiendo lo que trajera el cliente. Por eso es infalsificable, y por
 * eso todo el sistema se apoya en ella sin pensarlo.
 *
 * Con el relé delante, Cloudflare ya no ve al cliente: ve al VPS. La IP real
 * tiene que VIAJAR en una cabecera, y en ese instante pasa de ser algo
 * observado a algo declarado — es decir, falsificable por cualquiera que
 * alcance el Worker. Y cualquiera puede: `api-cf.nulldec.com` tiene que ser
 * público y naranja para que el relé lo alcance, y un subdominio con sufijo
 * `-cf` se adivina a la primera.
 *
 * Lo que consigue quien la falsifica, si esto no estuviera:
 *
 *   1. Los 9 límites de tasa dejan de existir. La clave es `rl:<cubo>:<ip>`
 *      (ver `index.ts`), así que una IP distinta por petición es un cubo nuevo
 *      por petición. Eso incluye `aws-tenant-deploy-decoy`, que crea recursos
 *      de AWS facturables de verdad en nuestra cuenta.
 *   2. Se puede ESCRIBIR en el corpus. `source_ip` de `raw_signals` alimenta
 *      `iocs`, `actor_profiles` y el feed STIX que se distribuye a los MSP.
 *      Falsificarla permite meter la IP de un tercero inocente como atacante
 *      confirmada (y que nuestros clientes la bloqueen), o atribuir la propia
 *      actividad a otro y desaparecer de la atribución — que es justamente el
 *      producto.
 *
 * ── La regla, y su propiedad más importante ──
 *
 * La cabecera de IP solo se cree si viene acompañada del secreto del relé.
 * Si no está, si no coincide, o si la IP no tiene forma de IP, se usa
 * `cf-connecting-ip` — es decir, EXACTAMENTE el comportamiento de siempre.
 *
 * Eso es lo que hace que quitar el relé dentro de 1-2 años (cuando haya IP
 * dedicada de Cloudflare) sea **solo un cambio de DNS**: sin relé no llega la
 * cabecera, no valida, y este código cae solo al camino de hoy. No hay que
 * desplegar ni un Worker para volver atrás.
 *
 * ── Esto NO es la única defensa, y es deliberado ──
 *
 * En Cloudflare hay además una regla WAF que rechaza en el borde cualquier
 * petición a los hostnames `-cf` que no venga de las IPs de los VPS del relé.
 * Las dos capas son independientes a propósito: el secreto cubre el caso de
 * que la regla WAF se borre o se despliegue mal, y la regla WAF cubre el caso
 * de que el secreto se filtre (un VPS comprometido, un volcado de logs).
 * Ninguna de las dos sustituye a la otra — no quitar una "porque ya está la
 * otra".
 */

export interface EntornoRele {
  /**
   * Compartido con nginx en los VPS del relé. Opcional a propósito: mientras
   * no exista el relé, el Worker funciona exactamente igual que antes. Su
   * ausencia no es un error, es el estado anterior a la migración (y el
   * posterior a desmontarla).
   */
  RELAY_SECRET?: string;
}

/** La IP real del cliente, tal y como la vio nginx en el VPS. */
export const CABECERA_IP = "x-nd-relay-ip";

/** La prueba de que esa IP la puso el relé y no quien llama. */
export const CABECERA_SECRETO = "x-nd-relay";

/**
 * Las dos cabeceras anteriores, para poder borrarlas de un tirón.
 *
 * **Borrarlas no es higiene, es cerrar una fuga real.** Este Worker reenvía
 * con `new Request(url, request)`, que COPIA todas las cabeceras: sin esto, el
 * secreto del relé viajaría hasta Supabase en cada petición. Y el Worker de
 * ingesta hace `headers: Object.fromEntries(request.headers)` para guardar el
 * sobre de la señal, así que el secreto acabaría ESCRITO en la columna
 * `headers` de `raw_signals` — en claro, en la base de datos, con retención.
 */
export const CABECERAS_DEL_RELE = [CABECERA_IP, CABECERA_SECRETO] as const;

/**
 * Comparación en tiempo constante.
 *
 * Una fuga por tiempos contra un Worker a través de internet no es un ataque
 * realista, pero el resto del código de NullDec compara secretos así
 * (`_shared` del backend tiene su propia versión) y un secreto comparado con
 * `===` es exactamente el detalle que alguien copia al siguiente sitio donde
 * sí importa.
 *
 * La diferencia de longitud se mezcla en el acumulador en vez de devolver
 * antes: salir temprano por longitud es justo lo que se intenta evitar.
 */
export function igualesEnTiempoConstante(a: string, b: string): boolean {
  const codificador = new TextEncoder();
  const ba = codificador.encode(a);
  const bb = codificador.encode(b);

  let diferencia = ba.length ^ bb.length;
  for (let i = 0; i < ba.length; i++) {
    diferencia |= ba[i] ^ (bb[i] ?? 0);
  }
  return diferencia === 0;
}

/**
 * ¿Tiene forma de IPv4?
 *
 * Se rechazan los ceros a la izquierda ("010.1.1.1") a propósito: hay
 * bibliotecas y sistemas operativos que los interpretan como octal, así que
 * la misma cadena puede significar dos direcciones distintas según quién la
 * lea. Una IP que no significa lo mismo en los dos extremos no sirve como
 * dato de atribución.
 */
export function esIPv4(valor: string): boolean {
  const partes = valor.split(".");
  if (partes.length !== 4) return false;

  return partes.every((parte) => {
    if (!/^\d{1,3}$/.test(parte)) return false;
    if (parte.length > 1 && parte[0] === "0") return false;
    return Number(parte) <= 255;
  });
}

/**
 * ¿Tiene forma de IPv6?
 *
 * Cubre la forma completa, la abreviada con "::" (una sola vez, como manda el
 * RFC 4291) y la mixta con IPv4 al final (`::ffff:203.0.113.9`), que es la
 * que aparece cuando un cliente IPv4 llega por un socket IPv6 — o sea, un
 * caso real, no un ejercicio.
 *
 * Se valida aunque el origen sea nginx y no el atacante: esto no defiende
 * contra quien llama (para eso está el secreto), defiende contra un fallo del
 * propio relé. `source_ip` acaba en una columna `inet` de Postgres, y un valor
 * con forma inválida no da un dato malo: da un INSERT que revienta y una
 * activación perdida para siempre.
 */
export function esIPv6(valor: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(valor)) return false;
  // "::" puede aparecer como mucho una vez (RFC 4291 §2.2).
  if (valor.split("::").length - 1 > 1) return false;

  let restante = valor;

  // Cola en forma de IPv4: en vez de arrastrar dos reglas en paralelo, se
  // convierte a los dos grupos hexadecimales que representa y se sigue
  // validando un IPv6 puro. `lastIndexOf` devuelve -1 si no hay ":", y
  // entonces `slice(0, 0)` deja solo los dos grupos convertidos: por eso un
  // "1.2.3.4" pelado acaba con 2 grupos y se rechaza, que es lo correcto.
  const ultimoDosPuntos = restante.lastIndexOf(":");
  const cola = restante.slice(ultimoDosPuntos + 1);
  if (cola.includes(".")) {
    if (!esIPv4(cola)) return false;
    const [a, b, c, d] = cola.split(".").map(Number);
    const grupo = (alto: number, bajo: number) => (((alto << 8) | bajo) >>> 0).toString(16);
    restante = restante.slice(0, ultimoDosPuntos + 1) + `${grupo(a, b)}:${grupo(c, d)}`;
  }

  const abreviado = restante.split("::").length - 1 === 1;
  const [izquierda, derecha] = abreviado ? restante.split("::") : [restante, ""];

  const trocear = (trozo: string): string[] => (trozo === "" ? [] : trozo.split(":"));
  const grupos = [...trocear(izquierda), ...trocear(derecha)];
  if (!grupos.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g))) return false;

  // Sin "::" tienen que estar los 8 grupos exactos. Con "::", el hueco
  // representa al menos un grupo de ceros, así que como mucho puede haber 7
  // escritos.
  return abreviado ? grupos.length <= 7 : grupos.length === 8;
}

/** ¿Tiene forma de dirección IP, de cualquiera de las dos familias? */
export function esIP(valor: string): boolean {
  return esIPv4(valor) || esIPv6(valor);
}

/**
 * Qué ha pasado al resolver la IP. Los dos primeros son normales; los cuatro
 * siguientes significan que **la IP del cliente se está perdiendo ahora
 * mismo** y nadie más va a avisar.
 */
export type DiagnosticoRele =
  /** Nadie dice venir del relé. Es el camino de siempre. */
  | "sin-rele"
  /** Cabecera del relé validada: se usa la IP real. */
  | "ok"
  /** Llega la cabecera pero este Worker no tiene `RELAY_SECRET`. */
  | "secreto-ausente"
  /** Llega con secreto y NO coincide: los VPS y el Worker han divergido. */
  | "secreto-invalido"
  /** Secreto correcto pero la IP no tiene forma de IP: fallo del relé. */
  | "ip-invalida"
  /** El `Host` es un gemelo `-cf` y no llega cabecera: cadena rota. */
  | "gemelo-sin-cabecera";

export interface ResolucionIp {
  /** La IP que debe usar el Worker. `null` si no hay ninguna. */
  ip: string | null;
  diagnostico: DiagnosticoRele;
}

/**
 * Sufijo de los hostnames gemelos que viven en Cloudflare.
 *
 * Sirve para detectar el estado intermedio peligroso SIN tener que
 * configurar en el Worker las IPs de los VPS — que sería otro sitio más que
 * mantener sincronizado, y justo la clase de duplicado que se pudre.
 *
 * Cómo funciona: nginx reescribe `Host` al gemelo antes de reenviar, así que
 * después de la migración toda petición legítima llega con `Host:
 * api-cf.nulldec.com`. Si llega con ese Host y SIN la cabecera del relé, solo
 * puede ser una de dos cosas, y las dos son graves:
 *
 *   a) nginx está reenviando sin poner la cabecera (relé mal configurado), o
 *   b) alguien ha alcanzado el gemelo directamente, o sea que falta la regla
 *      WAF que debería impedirlo.
 *
 * Y lo que importa para que esto sea usable: durante la ventana del paso 5 de
 * la migración (secreto puesto, DNS aún sin mover) el `Host` sigue siendo el
 * público, así que esto NO avisa. Sin esa propiedad el aviso sería ruido
 * durante días y se acabaría ignorando, que es como mueren los avisos.
 */
export const SUFIJO_GEMELO = "-cf.nulldec.com";

/**
 * La IP del cliente que debe usar el Worker: la del relé si está probada, y
 * si no la que observó Cloudflare. Devuelve además qué ha pasado, para que
 * quien llame pueda registrarlo.
 *
 * `ip` es `null` cuando no hay ninguna (no debería pasar en producción, pero
 * `cf-connecting-ip` es `string | null` y tragárselo aquí con un `?? ""`
 * convertiría "no sé quién es" en una clave de límite de tasa compartida por
 * todo el mundo).
 */
export function resolverIpDelCliente(request: Request, env: EntornoRele): ResolucionIp {
  const deCloudflare = request.headers.get("cf-connecting-ip");
  const declarada = request.headers.get(CABECERA_IP);

  if (declarada === null) {
    // Sin cabecera. Normal... salvo que el Host ya sea el gemelo, en cuyo
    // caso la cadena del relé está rota. Ver SUFIJO_GEMELO.
    let host = "";
    try {
      host = new URL(request.url).hostname;
    } catch {
      // Una URL que no se puede analizar no debe tumbar la resolución de la
      // IP: se pierde el diagnóstico, no la petición.
    }
    return {
      ip: deCloudflare,
      diagnostico: host.endsWith(SUFIJO_GEMELO) ? "gemelo-sin-cabecera" : "sin-rele",
    };
  }

  // Sin secreto configurado en el Worker no hay forma de comprobar nada, así
  // que la cabecera no vale.
  if (!env.RELAY_SECRET) return { ip: deCloudflare, diagnostico: "secreto-ausente" };

  const presentado = request.headers.get(CABECERA_SECRETO);
  if (presentado === null || !igualesEnTiempoConstante(presentado, env.RELAY_SECRET)) {
    return { ip: deCloudflare, diagnostico: "secreto-invalido" };
  }

  // Secreto correcto pero IP con forma inválida: se descarta la cabecera y se
  // sigue con la de Cloudflare. Preferir un dato peor (la IP del VPS) a un
  // dato roto que tumbe el INSERT.
  if (!esIP(declarada)) return { ip: deCloudflare, diagnostico: "ip-invalida" };

  return { ip: declarada, diagnostico: "ok" };
}

/**
 * La IP a secas, para quien no necesite el diagnóstico.
 *
 * ⚠ Quien la use NO registra nada. En los dos Workers de producción se llama
 * a `resolverIpDelCliente` + `registrarDiagnostico`, porque el estado
 * intermedio no se manifiesta de ninguna otra forma: todo sigue respondiendo
 * 200 mientras la IP del cliente se pierde.
 */
export function ipDelCliente(request: Request, env: EntornoRele): string | null {
  return resolverIpDelCliente(request, env).ip;
}

// ── El aviso ─────────────────────────────────────────────────────────────────

/** Qué decir y qué hacer, por diagnóstico. */
const AVISOS: Record<string, string> = {
  "secreto-ausente":
    "llega la cabecera del relé pero este Worker NO tiene RELAY_SECRET. " +
    "La IP del cliente se está PERDIENDO: todo el tráfico comparte el cubo " +
    "de límite de tasa y source_ip es la IP del VPS. " +
    "Arréglalo con `wrangler secret put RELAY_SECRET` " +
    "(paso 5 de MIGRACION_CLOUDFLARE/APLICAR.md).",
  "secreto-invalido":
    "la cabecera del relé llega con un secreto que NO coincide. " +
    "La IP del cliente se está PERDIENDO. El secreto de los VPS y el del " +
    "Worker han divergido — comprueba que sea el mismo en los DOS VPS y en " +
    "los DOS Workers (si solo falla parte del tráfico, es un VPS de los dos).",
  "ip-invalida":
    "el relé se ha autenticado bien pero manda una IP con forma inválida. " +
    "Es un fallo del propio relé: revisa que nginx use $remote_addr y no " +
    "$proxy_protocol_addr en X-ND-Relay-IP.",
  "gemelo-sin-cabecera":
    "petición al hostname gemelo -cf SIN cabecera del relé. " +
    "O nginx reenvía sin ponerla, o alguien ha alcanzado el gemelo " +
    "directamente — lo segundo significa que falta la regla WAF que lo impide.",
};

/**
 * Cada cuánto se repite un aviso del mismo tipo, por isolate.
 *
 * No es por ahorrar: sin silencio, el estado intermedio escribe una línea por
 * PETICIÓN. Un aviso que aparece diez mil veces no se lee — se filtra, y
 * entonces deja de existir. Con el contador de ocurrencias no se pierde el
 * volumen real.
 */
export const SILENCIO_MS = 60_000;

const avisos = new Map<string, { ultimo: number; callados: number }>();

/** Solo para las pruebas: vacía el estado del silenciador. */
export function reiniciarAvisos(): void {
  avisos.clear();
}

/**
 * Registra el diagnóstico si merece la pena.
 *
 * `ok` y `sin-rele` no escriben nada — son el 100% del tráfico sano y
 * registrarlos haría inútil el registro.
 *
 * **Nunca se escribe el secreto, ni un prefijo suyo, ni su longitud.** Estos
 * mensajes van a la observabilidad de Cloudflare, que no es el sitio donde
 * dejar pistas de un secreto que autentica la identidad del cliente.
 *
 * `ahora` se inyecta para poder probar el silenciador sin esperar un minuto.
 */
export function registrarDiagnostico(
  resolucion: ResolucionIp,
  request: Request,
  ahora: number = Date.now(),
): void {
  const texto = AVISOS[resolucion.diagnostico];
  if (!texto) return; // "ok" y "sin-rele"

  const estado = avisos.get(resolucion.diagnostico);

  if (estado && ahora - estado.ultimo < SILENCIO_MS) {
    estado.callados++;
    return;
  }

  const callados = estado?.callados ?? 0;
  avisos.set(resolucion.diagnostico, { ultimo: ahora, callados: 0 });

  let host = "";
  try {
    host = new URL(request.url).hostname;
  } catch {
    host = "(url ilegible)";
  }

  const repeticiones = callados > 0 ? ` [+${callados} más en los últimos ${SILENCIO_MS / 1000} s]` : "";
  console.error(`RELÉ [${resolucion.diagnostico}] ${host}: ${texto}${repeticiones}`);
}

/**
 * Quita las cabeceras del relé de un juego de cabeceras salientes.
 *
 * Se llama SIEMPRE, validara o no el secreto: si validó, ya se ha extraído lo
 * que hacía falta y el secreto no tiene por qué seguir viajando; si no validó,
 * las cabeceras son basura que alguien inyectó y tampoco deben propagarse —
 * sin esto, cualquiera podría escribir `x-nd-relay-ip` en el volcado de
 * cabeceras que el Worker de ingesta guarda en `raw_signals`.
 */
export function limpiarCabecerasDeRele(headers: Headers): void {
  for (const nombre of CABECERAS_DEL_RELE) headers.delete(nombre);
}

/**
 * Versión para objetos planos, que es la forma en la que el Worker de ingesta
 * vuelca las cabeceras antes de mandarlas al backend.
 *
 * Compara en minúsculas porque `Object.fromEntries(request.headers)` ya
 * entrega las claves en minúsculas, pero un volcado construido de otra manera
 * podría no hacerlo, y una fuga del secreto no puede depender de eso.
 */
export function sinCabecerasDeRele(
  cabeceras: Record<string, string>,
): Record<string, string> {
  const prohibidas = new Set<string>(CABECERAS_DEL_RELE);
  return Object.fromEntries(
    Object.entries(cabeceras).filter(([clave]) => !prohibidas.has(clave.toLowerCase())),
  );
}
