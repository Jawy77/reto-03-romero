// Pruebas de las reglas de control con variaciones que los 6 fixtures no cubren:
// proveedor inactivo, tope excedido, subárea ajena, aritmética, fechas y negaciones.
//
//   bun test
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { esConfirmacion, extraerCaso } from "../src/agent/confirmacion"
import { validar } from "../src/dominio/controles"
import type { Maestros, Paquete } from "../src/dominio/esquemas"
import { cargarMaestros, contieneAprobacion, leerPaquete } from "../src/dominio/lectura"
import { normalizarNit, parseMonto, textoBreve } from "../src/dominio/texto"

const RAIZ = join(import.meta.dir, "..")

function maestros(): Maestros {
  const m = cargarMaestros(RAIZ)
  if (!m.ok) throw new Error(m.error)
  return m.valor
}

/** Paquete del caso feliz (sol-001), con los cambios que cada prueba necesite. */
function paquete(cambios: (p: Paquete) => void = () => {}): Paquete {
  const leido = leerPaquete(RAIZ, "sol-001")
  if (!leido.ok) throw new Error(leido.error)
  const copia = structuredClone(leido.valor.paquete)
  cambios(copia)
  return copia
}

const codigos = (hallazgos: Array<{ codigo: string }>) => hallazgos.map((h) => h.codigo)

describe("reglas de control", () => {
  test("el caso feliz es apto y no pide nada", () => {
    const v = validar(paquete(), maestros())
    expect(v.apta).toBe(true)
    expect(v.confirmaciones).toHaveLength(0)
    expect(v.reglas).toHaveLength(10)
  })

  test("RC1 bloquea un proveedor inactivo", () => {
    const v = validar(paquete((p) => Object.assign(p.solicitud, { proveedor_nit: "901777888", proveedor_nombre: "Consultores Ágiles S.A.S." })), maestros())
    expect(codigos(v.bloqueos)).toContain("PROVEEDOR_INACTIVO")
  })

  test("RC1 acepta el NIT con puntos y dígito de verificación", () => {
    const v = validar(paquete((p) => (p.solicitud.proveedor_nit = "900.555.111-2")), maestros())
    expect(v.apta).toBe(true)
  })

  test("RC2 bloquea cuando no hay aprobación o no dice Aprobado", () => {
    expect(codigos(validar(paquete((p) => (p.aprobacion = null)), maestros()).bloqueos)).toContain("APROBACION_AUSENTE")
    const sinAprobar = paquete((p) => {
      if (p.aprobacion) p.aprobacion.aprobado = false
    })
    expect(codigos(validar(sinAprobar, maestros()).bloqueos)).toContain("APROBACION_SIN_APROBADO")
  })

  test("RC3 bloquea cuando el valor supera el tope del aprobador", () => {
    const caro = paquete((p) => Object.assign(p.solicitud, { cantidad: 1000, valor_total: 95_000_000 }))
    const v = validar(caro, maestros())
    expect(codigos(v.bloqueos)).toContain("TOPE_EXCEDIDO")
    expect(v.bloqueos.find((b) => b.codigo === "TOPE_EXCEDIDO")?.accion_sugerida).toContain("dgarcia@periferia-ficticia.com")
  })

  test("RC4 bloquea una subárea que no es del centro de costo", () => {
    const v = validar(paquete((p) => (p.solicitud.subarea = "Marketing")), maestros())
    expect(codigos(v.bloqueos)).toContain("SUBAREA_FUERA_DEL_CENTRO")
  })

  test("RC5 tolera hasta 2 % y pide confirmación si falta la cotización", () => {
    const dentro = paquete((p) => {
      if (p.cotizacion) p.cotizacion.total = 11_600_000 // 1,75 %
    })
    expect(validar(dentro, maestros()).confirmaciones).toHaveLength(0)
    expect(codigos(validar(paquete((p) => (p.cotizacion = null)), maestros()).confirmaciones)).toContain("SIN_COTIZACION")
  })

  test("RC6 y RC7 derivan del proveedor: IVA con confirmación, pago solo informado", () => {
    const sinDatos = paquete((p) => {
      delete p.solicitud.indicador_iva
      delete p.solicitud.condiciones_pago
    })
    const v = validar(sinDatos, maestros())
    expect(v.apta).toBe(true)
    expect(codigos(v.confirmaciones)).toEqual(["IVA_DERIVADO"])
    expect(v.derivados.indicador_iva?.valor).toBe("C1")
    expect(v.derivados.condiciones_pago?.valor).toBe("Z030")
  })

  test("RC8 marca retroactiva solo si la factura es anterior a la solicitud", () => {
    const antes = validar(paquete((p) => (p.factura = { numero: "F-1", fecha: "2026-08-01", total: 11_400_000 })), maestros())
    expect(antes.retroactiva).toBe(true)
    const despues = validar(paquete((p) => (p.factura = { numero: "F-1", fecha: "2026-08-25", total: 11_400_000 })), maestros())
    expect(despues.retroactiva).toBe(false)
  })

  test("RC9 pide confirmación si la aprobación es anterior a la solicitud", () => {
    const v = validar(paquete((p) => {
      if (p.aprobacion) p.aprobacion.fecha = "2026-08-19T10:00:00-05:00"
    }), maestros())
    expect(codigos(v.confirmaciones)).toContain("APROBACION_ANTERIOR")
  })

  test("RC10 bloquea cuando cantidad por valor unitario no da el total", () => {
    const v = validar(paquete((p) => (p.solicitud.valor_total = 11_500_000)), maestros())
    expect(codigos(v.bloqueos)).toContain("ARITMETICA_INCONSISTENTE")
  })
})

describe("lectura y normalización", () => {
  test("NIT y montos en formato colombiano", () => {
    expect(normalizarNit("900.555.111-2")).toBe("900555111")
    expect(parseMonto("COP 11.400.000")).toBe(11_400_000)
    expect(parseMonto("sin número")).toBeNull()
  })

  test("el texto breve respeta el límite de 40 caracteres de SAP", () => {
    const breve = textoBreve("Renovación licencias antivirus corporativo 120 puestos, vigencia 12 meses")
    expect(breve.length).toBeLessThanOrEqual(40)
    expect(breve.endsWith(" de")).toBe(false)
  })

  test("una negación no cuenta como aprobación", () => {
    expect(contieneAprobacion("Aprobado, proceder.")).toBe(true)
    expect(contieneAprobacion("No aprobado por ahora.")).toBe(false)
    expect(contieneAprobacion("Queda rechazado.")).toBe(false)
  })

  test("un caso fuera de fixtures no se lee", () => {
    expect(leerPaquete(RAIZ, "../maestros").ok).toBe(false)
    expect(leerPaquete(RAIZ, "sol-999").ok).toBe(false)
  })
})

describe("confirmación humana", () => {
  test("solo una confirmación explícita autoriza", () => {
    expect(esConfirmacion("Confirmo")).toBe(true)
    expect(esConfirmacion("Sí, adelante")).toBe(true)
    expect(esConfirmacion("no la crees hasta que yo lo confirme")).toBe(false)
    expect(esConfirmacion("todavía no, espera")).toBe(false)
    expect(esConfirmacion("¿qué pasa si confirmo?")).toBe(false) // una pregunta no es una confirmación
  })

  test("reconoce el caso en sus distintas formas", () => {
    expect(extraerCaso('Procesa la solicitud "sol-004"')).toBe("sol-004")
    expect(extraerCaso("revisa SOL-2026-005")).toBe("sol-005")
    expect(extraerCaso("hola")).toBeNull()
  })
})
