// Implementación del adaptador para Anthropic (Messages API con uso de herramientas).
// La clave se resuelve desde el entorno (ANTHROPIC_API_KEY); nunca se lee ni se
// registra aquí.
import Anthropic from "@anthropic-ai/sdk"
import {
  ErrorLLM,
  type AdaptadorLLM,
  type Bloque,
  type DefinicionHerramienta,
  type Mensaje,
  type RespuestaLLM,
} from "./adapter"

type Esfuerzo = "low" | "medium" | "high" | "xhigh" | "max"
type Parametros = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type BloqueParam = Anthropic.Beta.Messages.BetaContentBlockParam

/** Modelos que aceptan el respaldo del lado del servidor cuando una petición es declinada. */
const CON_RESPALDO = /^claude-(opus-5-5|sonnet-5-5|fable-5)/

export type OpcionesAnthropic = { modelo: string; esfuerzo: Esfuerzo; maxTokens: number; timeoutMs: number }

function aBloqueParam(b: Bloque): BloqueParam {
  switch (b.tipo) {
    case "texto":
      return { type: "text", text: b.texto }
    case "uso_herramienta":
      return { type: "tool_use", id: b.id, name: b.nombre, input: b.argumentos }
    case "resultado_herramienta":
      return { type: "tool_result", tool_use_id: b.id, content: b.contenido, is_error: b.esError }
    case "opaco":
      return b.datos as BloqueParam // vuelve tal como lo entregó el proveedor
  }
}

export class AdaptadorAnthropic implements AdaptadorLLM {
  readonly proveedor = "anthropic"
  readonly modelo: string
  private readonly cliente: Anthropic

  constructor(private readonly opciones: OpcionesAnthropic) {
    this.modelo = opciones.modelo
    this.cliente = new Anthropic({ timeout: opciones.timeoutMs, maxRetries: 1 })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: { sistema: string }): Promise<RespuestaLLM> {
    const parametros: Parametros = {
      model: this.modelo,
      max_tokens: this.opciones.maxTokens,
      // El prompt y las herramientas no cambian entre llamadas: se cachean.
      system: [{ type: "text", text: opciones.sistema, cache_control: { type: "ephemeral" } }],
      tools: herramientas.map((h) => ({
        name: h.nombre,
        description: h.descripcion,
        input_schema: { ...h.esquemaJson, type: "object" as const },
      })),
      messages: mensajes.map((m) => ({
        role: m.rol === "usuario" ? ("user" as const) : ("assistant" as const),
        content: m.bloques.map(aBloqueParam),
      })),
      output_config: { effort: this.opciones.esfuerzo },
    }
    if (CON_RESPALDO.test(this.modelo)) {
      parametros.betas = ["server-side-fallback-2026-07-01"]
      parametros.fallbacks = "default"
    }

    try {
      const r = await this.cliente.beta.messages.create(parametros)
      const bloques: Bloque[] = r.content.map((b): Bloque => {
        if (b.type === "text") return { tipo: "texto", texto: b.text }
        if (b.type === "tool_use") return { tipo: "uso_herramienta", id: b.id, nombre: b.name, argumentos: b.input }
        return { tipo: "opaco", datos: b }
      })
      const motivo: RespuestaLLM["motivo"] =
        r.stop_reason === "tool_use" ? "herramientas" : r.stop_reason === "max_tokens" ? "limite" : r.stop_reason === "refusal" ? "rechazo" : "fin"
      const entrada = r.usage.input_tokens + (r.usage.cache_creation_input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0)
      return { bloques, motivo, uso: { entrada, salida: r.usage.output_tokens } }
    } catch (e) {
      throw traducir(e)
    }
  }
}

/** De lo más específico a lo más general, con las clases tipadas del SDK. */
function traducir(e: unknown): ErrorLLM {
  if (e instanceof Anthropic.AuthenticationError) return new ErrorLLM("El proveedor del modelo rechazó la credencial configurada en el servidor.")
  if (e instanceof Anthropic.PermissionDeniedError) return new ErrorLLM("La credencial del servidor no tiene permiso para usar este modelo.")
  if (e instanceof Anthropic.RateLimitError) return new ErrorLLM("El proveedor del modelo está limitando las peticiones. Intenta de nuevo en un minuto.")
  if (e instanceof Anthropic.BadRequestError) return new ErrorLLM("El proveedor del modelo rechazó la petición por inválida. Revisa el modelo configurado.")
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ErrorLLM("El modelo tardó demasiado en responder. Intenta de nuevo.")
  if (e instanceof Anthropic.APIConnectionError) return new ErrorLLM("No hubo conexión con el proveedor del modelo.")
  if (e instanceof Anthropic.APIError) return new ErrorLLM(`El proveedor del modelo respondió con un error (${e.status ?? "sin código"}).`)
  return new ErrorLLM("Error inesperado al consultar el modelo.")
}
