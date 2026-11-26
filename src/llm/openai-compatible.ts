// Adaptador para proveedores con API compatible con Chat Completions (Kimi de
// Moonshot AI y similares). Es la segunda implementación real de AdaptadorLLM:
// el ciclo del agente no cambió una línea para incorporarla.
// La clave llega por variable de entorno y solo viaja en la cabecera Authorization.
import { z } from "zod"
import {
  ErrorLLM,
  type AdaptadorLLM,
  type Bloque,
  type DefinicionHerramienta,
  type Mensaje,
  type RespuestaLLM,
} from "./adapter"

export type OpcionesCompatibles = {
  proveedor: string
  modelo: string
  baseUrl: string
  apiKey: string
  maxTokens: number
  timeoutMs: number
}

const RespuestaSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).partial().optional(),
})

const ModelosSchema = z.object({ data: z.array(z.object({ id: z.string() })) })

type MensajeApi =
  | { role: "system" | "user"; content: string }
  | { role: "tool"; tool_call_id: string; content: string }
  | {
      role: "assistant"
      content: string | null
      reasoning_content?: string
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
    }

/** Razonamiento del proveedor: se guarda opaco y se devuelve intacto en el turno siguiente. */
type Razonamiento = { reasoning_content: string }
const esRazonamiento = (datos: unknown): datos is Razonamiento =>
  typeof datos === "object" && datos !== null && typeof (datos as Razonamiento).reasoning_content === "string"

function aMensajesApi(sistema: string, mensajes: Mensaje[]): MensajeApi[] {
  const salida: MensajeApi[] = [{ role: "system", content: sistema }]
  for (const m of mensajes) {
    if (m.rol === "usuario") {
      for (const b of m.bloques) {
        if (b.tipo === "resultado_herramienta") salida.push({ role: "tool", tool_call_id: b.id, content: b.contenido })
        if (b.tipo === "texto") salida.push({ role: "user", content: b.texto })
      }
      continue
    }
    const texto = m.bloques.flatMap((b) => (b.tipo === "texto" ? [b.texto] : [])).join("\n")
    const llamadas = m.bloques.flatMap((b) =>
      b.tipo === "uso_herramienta" ? [{ id: b.id, type: "function" as const, function: { name: b.nombre, arguments: JSON.stringify(b.argumentos ?? {}) } }] : [],
    )
    const razonamiento = m.bloques.flatMap((b) => (b.tipo === "opaco" && esRazonamiento(b.datos) ? [b.datos.reasoning_content] : []))[0]
    salida.push({
      role: "assistant",
      content: texto || null,
      ...(razonamiento ? { reasoning_content: razonamiento } : {}),
      ...(llamadas.length ? { tool_calls: llamadas } : {}),
    })
  }
  return salida
}

/** Los argumentos llegan como texto JSON; si vienen mal formados, zod los rechazará después. */
function argumentosDe(crudo: string): unknown {
  try {
    return JSON.parse(crudo || "{}")
  } catch {
    return { argumentos_ilegibles: crudo.slice(0, 200) }
  }
}

export class AdaptadorOpenAICompatible implements AdaptadorLLM {
  readonly proveedor: string
  readonly modelo: string

  constructor(private readonly opciones: OpcionesCompatibles) {
    this.proveedor = opciones.proveedor
    this.modelo = opciones.modelo
  }

  private async pedir(ruta: string, cuerpo?: unknown): Promise<unknown> {
    let respuesta: Response
    try {
      respuesta = await fetch(`${this.opciones.baseUrl.replace(/\/+$/, "")}${ruta}`, {
        method: cuerpo ? "POST" : "GET",
        headers: { Authorization: `Bearer ${this.opciones.apiKey}`, "Content-Type": "application/json" },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(this.opciones.timeoutMs),
      })
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") throw new ErrorLLM("El modelo tardó demasiado en responder. Intenta de nuevo.")
      throw new ErrorLLM("No hubo conexión con el proveedor del modelo.")
    }
    if (respuesta.status === 401 || respuesta.status === 403) throw new ErrorLLM("El proveedor del modelo rechazó la credencial configurada en el servidor.")
    if (respuesta.status === 429) throw new ErrorLLM("El proveedor del modelo está limitando las peticiones o la cuenta no tiene saldo. Intenta de nuevo en un minuto.")
    if (respuesta.status === 400 || respuesta.status === 404) throw new ErrorLLM(`El proveedor del modelo rechazó la petición (${respuesta.status}). Revisa el modelo configurado.`)
    if (!respuesta.ok) throw new ErrorLLM(`El proveedor del modelo respondió con un error (${respuesta.status}).`)
    return respuesta.json()
  }

  /** Para el arranque: qué modelos ofrece la cuenta. Nunca lanza. */
  async listarModelos(): Promise<string[]> {
    try {
      return ModelosSchema.parse(await this.pedir("/models")).data.map((m) => m.id)
    } catch {
      return []
    }
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: { sistema: string }): Promise<RespuestaLLM> {
    const crudo = await this.pedir("/chat/completions", {
      model: this.modelo,
      max_tokens: this.opciones.maxTokens,
      messages: aMensajesApi(opciones.sistema, mensajes),
      tools: herramientas.map((h) => ({ type: "function", function: { name: h.nombre, description: h.descripcion, parameters: h.esquemaJson } })),
      tool_choice: "auto",
    })
    const validada = RespuestaSchema.safeParse(crudo)
    if (!validada.success) throw new ErrorLLM("El proveedor del modelo devolvió una respuesta con un formato inesperado.")
    const eleccion = validada.data.choices[0]
    if (!eleccion) throw new ErrorLLM("El proveedor del modelo no devolvió ninguna respuesta.")

    const bloques: Bloque[] = []
    if (eleccion.message.reasoning_content) bloques.push({ tipo: "opaco", datos: { reasoning_content: eleccion.message.reasoning_content } })
    if (eleccion.message.content) bloques.push({ tipo: "texto", texto: eleccion.message.content })
    for (const llamada of eleccion.message.tool_calls ?? []) {
      bloques.push({ tipo: "uso_herramienta", id: llamada.id, nombre: llamada.function.name, argumentos: argumentosDe(llamada.function.arguments) })
    }
    const hayLlamadas = (eleccion.message.tool_calls?.length ?? 0) > 0
    const motivo: RespuestaLLM["motivo"] = hayLlamadas
      ? "herramientas"
      : eleccion.finish_reason === "length"
        ? "limite"
        : eleccion.finish_reason === "content_filter"
          ? "rechazo"
          : "fin"
    return { bloques, motivo, uso: { entrada: validada.data.usage?.prompt_tokens ?? 0, salida: validada.data.usage?.completion_tokens ?? 0 } }
  }
}
