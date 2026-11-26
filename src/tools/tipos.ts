// Contrato de herramientas (PRD 6.2): un objeto con description, args y execute.
import type { z } from "zod"

export type Contexto = {
  /** Raíz del proyecto. Las rutas se resuelven desde aquí, nunca absolutas. */
  directory: string
  sessionId: string
}

export type Herramienta<S extends z.ZodRawShape> = {
  description: string
  args: S
  /** Devuelve un JSON serializado { ok: true, data } o { ok: false, error }. Nunca lanza. */
  execute(args: z.infer<z.ZodObject<S>>, ctx: Contexto): Promise<string>
}

/** Solo ayuda a TypeScript a inferir los argumentos; devuelve el mismo objeto. */
export function definir<S extends z.ZodRawShape>(herramienta: Herramienta<S>): Herramienta<S> {
  return herramienta
}

export function exito(data: unknown): string {
  return JSON.stringify({ ok: true, data })
}

export function fallo(error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error, ...extra })
}
