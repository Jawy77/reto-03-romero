// Ciclo del agente: prompt → modelo → llamadas a herramientas → respuesta.
// Aquí viven los topes (iteraciones y tokens), el registro de cada llamada y la
// regla de confirmación humana. No conoce HTTP ni al proveedor del modelo.
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { ErrorLLM, esTexto, esUso, type AdaptadorLLM, type BloqueResultado, type BloqueUso, type Mensaje } from "../llm/adapter"
import { buscarHerramienta, herramientas } from "../tools/registro"
import { esConfirmacion, esNegativa } from "./confirmacion"

export type LlamadaVisible = { nombre: string; argumentos: unknown; ok: boolean; resultado: unknown; ms: number }

export type EntradaHistorial =
  | { rol: "usuario"; texto: string; ts: string }
  | { rol: "asistente"; texto: string; ts: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean }

export type Sesion = {
  id: string
  mensajes: Mensaje[]
  historial: EntradaHistorial[]
  tokens: number
  turno: number
  /** Casos que esperan confirmación humana y el turno en que se pidió. */
  pendientes: Map<string, number>
  ocupada: boolean
}

export type ResultadoTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean; tokensSesion: number }

export type Dependencias = {
  llm: AdaptadorLLM
  sistema: string
  directorio: string
  maxIteraciones: number
  maxTokensSesion: number
  /** Devuelve false cuando el presupuesto global de tokens se agotó. */
  consumirPresupuesto(tokens: number): boolean
}

export function nuevaSesion(id: string): Sesion {
  return { id, mensajes: [], historial: [], tokens: 0, turno: 0, pendientes: new Map(), ocupada: false }
}

function registrar(directorio: string, entrada: Record<string, unknown>): void {
  const carpeta = join(directorio, "out")
  mkdirSync(carpeta, { recursive: true })
  appendFileSync(join(carpeta, "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...entrada })}\n`, "utf8")
}

type Cuerpo = { ok?: boolean; codigo?: string; data?: { apta?: boolean; confirmaciones?: unknown[] } }

function casoDe(argumentos: unknown): string | null {
  const caso = (argumentos as { caso?: unknown } | null)?.caso
  return typeof caso === "string" ? caso : null
}

export async function ejecutarTurno(sesion: Sesion, mensaje: string, deps: Dependencias): Promise<ResultadoTurno> {
  sesion.turno += 1
  const ahora = () => new Date().toISOString()
  sesion.mensajes.push({ rol: "usuario", bloques: [{ tipo: "texto", texto: mensaje }] })
  sesion.historial.push({ rol: "usuario", texto: mensaje, ts: ahora() })

  // CA3: confirmado=true solo vale para casos que quedaron pendientes en un turno
  // anterior y solo si este mensaje de la analista confirma. Lo decide el código.
  if (esNegativa(mensaje)) sesion.pendientes.clear()
  const autorizados = new Set(esConfirmacion(mensaje) ? [...sesion.pendientes].filter(([, turno]) => turno < sesion.turno).map(([caso]) => caso) : [])

  const toolCalls: LlamadaVisible[] = []
  const definiciones = herramientas.map((h) => ({ nombre: h.nombre, descripcion: h.descripcion, esquemaJson: h.esquemaJson }))
  let reply = ""

  const ejecutar = async (uso: BloqueUso): Promise<BloqueResultado> => {
    const caso = casoDe(uso.argumentos)
    let argumentos = uso.argumentos
    let nota: string | null = null
    if (uso.nombre === "oc_crear" && (argumentos as { confirmado?: unknown }).confirmado === true && !(caso && autorizados.has(caso))) {
      argumentos = { ...(argumentos as Record<string, unknown>), confirmado: false }
      nota = "confirmado=true fue ignorado: la analista no lo confirmó en su último mensaje."
    }
    const inicio = performance.now()
    const herramienta = buscarHerramienta(uso.nombre)
    const crudo = herramienta
      ? await herramienta.ejecutar(argumentos, { directory: deps.directorio, sessionId: sesion.id })
      : JSON.stringify({ ok: false, error: `La herramienta ${uso.nombre} no existe.` })
    const ms = Math.round(performance.now() - inicio)
    const cuerpo = JSON.parse(crudo) as Cuerpo
    const ok = cuerpo.ok === true

    if (caso) {
      const pideConfirmar =
        (uso.nombre === "oc_crear" && cuerpo.codigo === "REQUIERE_CONFIRMACION") ||
        (uso.nombre === "oc_validar" && cuerpo.data?.apta === true && (cuerpo.data.confirmaciones?.length ?? 0) > 0)
      if (pideConfirmar && !sesion.pendientes.has(caso)) sesion.pendientes.set(caso, sesion.turno)
      if (uso.nombre === "oc_crear" && ok) sesion.pendientes.delete(caso)
    }

    toolCalls.push({ nombre: uso.nombre, argumentos, ok, resultado: nota ? { ...cuerpo, nota } : cuerpo, ms })
    registrar(deps.directorio, { sessionId: sesion.id, turno: sesion.turno, herramienta: uso.nombre, argumentos, ok, codigo: cuerpo.codigo ?? null, ms })
    return { tipo: "resultado_herramienta", id: uso.id, contenido: nota ? JSON.stringify({ ...cuerpo, nota }) : crudo, esError: !ok }
  }

  try {
    let iteracion = 0
    for (; iteracion < deps.maxIteraciones; iteracion++) {
      if (sesion.tokens >= deps.maxTokensSesion) {
        reply = "Esta sesión alcanzó su tope de tokens. Abre una sesión nueva para continuar."
        break
      }
      const respuesta = await deps.llm.enviar(sesion.mensajes, definiciones, { sistema: deps.sistema })
      const consumidos = respuesta.uso.entrada + respuesta.uso.salida
      sesion.tokens += consumidos
      const hayPresupuesto = deps.consumirPresupuesto(consumidos)
      sesion.mensajes.push({ rol: "asistente", bloques: respuesta.bloques.length ? respuesta.bloques : [{ tipo: "texto", texto: "(sin respuesta)" }] })

      const usos = respuesta.bloques.filter(esUso)
      const texto = respuesta.bloques.filter(esTexto).map((b) => b.texto).join("\n").trim()
      if (respuesta.motivo === "rechazo") {
        reply = "El modelo declinó responder a esta petición. Reformúlala o procesa el caso por su nombre."
        break
      }
      if (usos.length === 0) {
        reply = texto || "No obtuve una respuesta del modelo."
        break
      }
      const resultados: BloqueResultado[] = []
      for (const uso of usos) resultados.push(await ejecutar(uso))
      sesion.mensajes.push({ rol: "usuario", bloques: resultados })
      if (!hayPresupuesto) {
        reply = "El servicio alcanzó su tope diario de tokens. Intenta de nuevo mañana."
        break
      }
    }
    if (iteracion >= deps.maxIteraciones) {
      // CA1: al llegar al tope se responde con lo que hay y lo que falta.
      const hechas = toolCalls.map((t) => `${t.nombre} (${t.ok ? "ok" : "falló"})`).join(", ") || "ninguna"
      reply = `Alcancé el tope de ${deps.maxIteraciones} pasos en este turno sin terminar. Ejecuté: ${hechas}. Falta cerrar el proceso: dime cómo quieres continuar.`
    }
  } catch (e) {
    // CA5: el error se muestra en el chat y la sesión sigue viva.
    reply = e instanceof ErrorLLM ? e.message : "Ocurrió un error interno al procesar el mensaje. La sesión sigue activa: intenta de nuevo."
    registrar(deps.directorio, { sessionId: sesion.id, turno: sesion.turno, error: e instanceof Error ? e.name : "desconocido" })
  }

  // La conversación siempre termina en un mensaje del asistente, también tras un corte o un error.
  if (sesion.mensajes.at(-1)?.rol !== "asistente" || sesion.mensajes.at(-1)?.bloques.some(esUso)) {
    sesion.mensajes.push({ rol: "asistente", bloques: [{ tipo: "texto", texto: reply }] })
  }

  const pidioEsteTurno = [...sesion.pendientes.values()].some((turno) => turno === sesion.turno)
  // Una pregunta final solo cuenta como confirmación si se preparó una orden y no se creó en este turno.
  const preparo = toolCalls.some((t) => t.nombre === "oc_construir_payload" && t.ok)
  const creo = toolCalls.some((t) => t.nombre === "oc_crear" && t.ok)
  const cierraPreguntando = preparo && !creo && /\?\s*$/.test(reply)
  const needsConfirmation = pidioEsteTurno || cierraPreguntando
  sesion.historial.push({ rol: "asistente", texto: reply, ts: ahora(), toolCalls, needsConfirmation })
  return { reply, toolCalls, needsConfirmation, tokensSesion: sesion.tokens }
}
