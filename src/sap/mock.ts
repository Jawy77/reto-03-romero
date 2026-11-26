// SAP simulado sobre archivos en out/sap/. Asigna números secuenciales desde
// 4500000001 y guarda una orden por línea en ordenes.jsonl.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { OrdenCompra } from "../dominio/esquemas"
import { cargarMaestros } from "../dominio/lectura"
import { normalizarNit } from "../dominio/texto"
import type { SapAdapter } from "./adapter"

const PRIMER_NUMERO = 4500000001

type Registro = { numero_oc: string; fecha: string; orden: OrdenCompra }

export class SapMock implements SapAdapter {
  private readonly carpeta: string
  private readonly archivo: string

  constructor(private readonly directorio: string) {
    this.carpeta = join(directorio, "out", "sap")
    this.archivo = join(this.carpeta, "ordenes.jsonl")
  }

  private leerRegistros(): Registro[] {
    if (!existsSync(this.archivo)) return []
    return readFileSync(this.archivo, "utf8")
      .split("\n")
      .filter((linea) => linea.trim().length > 0)
      .map((linea) => JSON.parse(linea) as Registro)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const maestros = cargarMaestros(this.directorio)
    if (!maestros.ok) return null
    const hallado = maestros.valor.proveedores.find((p) => normalizarNit(p.nit) === normalizarNit(nit))
    return hallado ? { codigo_sap: hallado.codigo_sap, activo: hallado.activo } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    mkdirSync(this.carpeta, { recursive: true })
    const numero_oc = String(PRIMER_NUMERO + this.leerRegistros().length)
    const fecha = new Date().toISOString()
    const registro: Registro = { numero_oc, fecha, orden }
    appendFileSync(this.archivo, `${JSON.stringify(registro)}\n`, "utf8")
    return { numero_oc, fecha }
  }

  /** Devuelve también la fecha: en SAP real saldría de consultar la orden hallada. */
  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string; fecha: string } | null> {
    const hallado = this.leerRegistros().find((r) => r.orden.referencia.solicitud_id === solicitud_id)
    return hallado ? { numero_oc: hallado.numero_oc, fecha: hallado.fecha } : null
  }
}
