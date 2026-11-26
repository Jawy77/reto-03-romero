// Interfaz propia del proveedor de lenguaje. El ciclo del agente solo conoce
// estos tipos: cambiar de proveedor es escribir otra clase que los cumpla.

export type BloqueTexto = { tipo: "texto"; texto: string }
export type BloqueUso = { tipo: "uso_herramienta"; id: string; nombre: string; argumentos: unknown }
export type BloqueResultado = { tipo: "resultado_herramienta"; id: string; contenido: string; esError: boolean }
/** Bloque propio del proveedor (por ejemplo razonamiento) que debe volver intacto. */
export type BloqueOpaco = { tipo: "opaco"; datos: unknown }

export type Bloque = BloqueTexto | BloqueUso | BloqueResultado | BloqueOpaco

export type Mensaje = { rol: "usuario" | "asistente"; bloques: Bloque[] }

export type DefinicionHerramienta = {
  nombre: string
  descripcion: string
  esquemaJson: Record<string, unknown>
}

export type RespuestaLLM = {
  bloques: Bloque[]
  /** Por qué terminó: respuesta final, quiere herramientas, se cortó o declinó. */
  motivo: "fin" | "herramientas" | "limite" | "rechazo"
  uso: { entrada: number; salida: number }
}

export interface AdaptadorLLM {
  readonly proveedor: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: { sistema: string }): Promise<RespuestaLLM>
}

/** Error del proveedor ya traducido a un mensaje que se puede mostrar en el chat. */
export class ErrorLLM extends Error {
  constructor(mensaje: string) {
    super(mensaje)
    this.name = "ErrorLLM"
  }
}

export const esUso = (b: Bloque): b is BloqueUso => b.tipo === "uso_herramienta"
export const esTexto = (b: Bloque): b is BloqueTexto => b.tipo === "texto"
export const esResultado = (b: Bloque): b is BloqueResultado => b.tipo === "resultado_herramienta"
