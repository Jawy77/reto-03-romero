// Registro de herramientas: les da el nombre que ve el modelo (<archivo>_<export>),
// publica su esquema JSON y valida los argumentos con zod antes de ejecutar.
import { z } from "zod"
import * as oc from "./oc"
import { fallo, type Contexto, type Herramienta } from "./tipos"

export type HerramientaRegistrada = {
  nombre: string
  descripcion: string
  esquemaJson: Record<string, unknown>
  /** Valida los argumentos crudos del modelo y ejecuta. Nunca lanza. */
  ejecutar(argumentos: unknown, ctx: Contexto): Promise<string>
}

function registrar<S extends z.ZodRawShape>(archivo: string, nombre: string, h: Herramienta<S>): HerramientaRegistrada {
  const esquema = z.object(h.args)
  return {
    nombre: `${archivo}_${nombre}`,
    descripcion: h.description,
    esquemaJson: z.toJSONSchema(esquema) as Record<string, unknown>,
    async ejecutar(argumentos, ctx) {
      const validados = esquema.safeParse(argumentos)
      if (!validados.success) {
        const detalle = validados.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
        return fallo(`Argumentos inválidos para ${archivo}_${nombre}: ${detalle}`)
      }
      try {
        return await h.execute(validados.data, ctx)
      } catch (e) {
        return fallo(`Error inesperado en ${archivo}_${nombre}: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
  }
}

export const herramientas: HerramientaRegistrada[] = [
  registrar("oc", "leer_paquete", oc.leer_paquete),
  registrar("oc", "validar", oc.validar),
  registrar("oc", "construir_payload", oc.construir_payload),
  registrar("oc", "generar_evidencia", oc.generar_evidencia),
  registrar("oc", "crear", oc.crear),
]

export function buscarHerramienta(nombre: string): HerramientaRegistrada | undefined {
  return herramientas.find((h) => h.nombre === nombre)
}
