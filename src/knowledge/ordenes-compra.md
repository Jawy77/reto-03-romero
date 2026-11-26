# Conocimiento del proceso: órdenes de compra

## El paquete

Cada compra llega a administración por correo con tres piezas: la solicitud (un Excel), la cotización del proveedor y el correo de aprobación del líder del área. En algunos casos llega además la factura, lo que indica que la compra ya se hizo.

Los casos disponibles están en `fixtures/reto-03/solicitudes/` y se nombran `sol-001` a `sol-006`. Si la analista dice "SOL-2026-004" o "la solicitud 4", el caso es `sol-004`.

## Reglas de control

Un **bloqueo** impide crear la orden. Una **confirmación** la permite solo si la analista lo confirma. Un **derivado** es un valor que se completó desde un maestro y solo se informa.

| Regla | Qué verifica | Tipo |
|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo | Bloqueo |
| RC2 | Hay aprobación, dice "Aprobado" y viene de un aprobador del centro de costo | Bloqueo |
| RC3 | El valor total no supera el tope de ese aprobador | Bloqueo |
| RC4 | La subárea pertenece al centro de costo | Bloqueo |
| RC5 | Cotización y solicitud difieren 2 % o menos; también aplica si no hay cotización | Confirmación |
| RC6 | Sin indicador de IVA en la solicitud, se toma el del proveedor | Confirmación y derivado |
| RC7 | Sin condiciones de pago en la solicitud, se toman las del proveedor | Derivado |
| RC8 | La factura es anterior a la solicitud: orden retroactiva | Confirmación |
| RC9 | La aprobación es anterior a la solicitud | Confirmación |
| RC10 | Cantidad por valor unitario es igual al valor total | Bloqueo |

## Criterios que conviene explicar a la analista

- **Valor de la orden.** La orden se crea por el valor de la solicitud, que es el que aprobó el líder. Si la cotización trae otro valor, confirmar significa aceptar el de la solicitud; si el correcto es el de la cotización, hay que devolver la solicitud para que la corrijan y la vuelvan a aprobar.
- **Aprobador sin autoridad.** Un líder solo puede aprobar gastos de su propio centro de costo y hasta su tope. Si aprueba el líder de otra área, la orden se bloquea aunque el correo diga "Aprobado".
- **Órdenes retroactivas.** Si la factura ya existe, la orden solo formaliza una compra hecha. Se puede crear con confirmación, pero queda marcada como retroactiva en el log de control porque la dirección quiere medir cuántas hay.
- **Texto breve.** SAP admite 40 caracteres en la descripción de la posición; la descripción completa queda en la trazabilidad.
- **Idempotencia.** Una solicitud genera una sola orden. Si se pide crearla de nuevo, se devuelve el número que ya existe.

## Archivos que genera el proceso

- `out/<caso>/trazabilidad.json`: de dónde salió cada valor de la orden.
- `out/<caso>/aprobacion.txt`: evidencia del correo de aprobación con su huella sha256.
- `out/sap/ordenes.jsonl`: órdenes creadas en el SAP simulado.
- `out/control.csv`: una fila por intento, para Contabilidad y Auditoría.
