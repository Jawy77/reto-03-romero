// Contrato del sistema de registro (PRD 7.4). Las herramientas dependen de esta
// interfaz, no de una implementación: el día que exista conexión real a SAP se
// escribe otra clase que la cumpla y el resto del agente no cambia.
import type { OrdenCompra } from "../dominio/esquemas"

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
