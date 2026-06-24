# DGII e-CF Rejections to Fix (live certecf verdicts, 2026-06-23)

The engine now works end-to-end: signing, auth, transport, filename, async trackId polling all PASS. DGII accepted 16/25 (all 4 RFCE + 12 e-CF). 9 e-CF were rejected for **content/business-rule** reasons (NOT signature/schema/transport). Fix the XML builders so all 21 e-CF pass in ONE clean pass.

## CRITICAL: DGII auto-resets on ANY rejection
The DGII portal shows "Las pruebas de datos de eCF han sido reiniciadas debido a que se han rechazado comprobantes" — **every rejected comprobante resets the accepted e-CF counter to the docs sent before the first failure.** So we MUST send all 21 e-CF with ZERO rejections in a single pass, in correct dependency order. Partial acceptance does not accumulate. (RFCE counter is separate and already at 4/4.)

## The 21 e-CF (excludes the 4 RFCE consumo ENCFs E32...011/012/013/015)
12 currently ACCEPTED (do not break these): E320000000006, E320000000005, E310000000004, E410000000001, E430000000007, E430000000012, E440000000013, E450000000001, E450000000010, E460000000009, E470000000001, E470000000009.

9 REJECTED — fix these:

### Group A — Reference ordering (codes 614). NOT a builder bug; a SEND-ORDER bug.
- E330000000001 (t33, nota de crédito): `[614] El eNCF modificado no ha sido emitido. El eNCF E320000000006 especificado en NCFModificado ... no es válido.`
- E340000000013 (t34, nota de débito): `[614] El eNCF modificado no ha sido emitido.`
- E340000000018 (t34, nota de débito): `[614] El eNCF modificado no ha sido emitido.`
FIX: these reference a prior invoice via `NCFModificado`. They must be sent AFTER their referenced e-CF is ACCEPTED by DGII. Determine each doc's `NCFModificado` value from the dataset, build a dependency order, and send referenced invoices first, then poll until Aceptado, THEN send the notes. Implement this ordering in the batch sender (src/sendAll.ts). Also VERIFY the builder is emitting the `InformacionDeReferencia` / `NCFModificado` (+ `FechaNCFModificado`, `CodigoModificacion`, `RazonModificacion`) correctly per the t33/t34 XSD — but the 614 is fundamentally an ordering dependency.

### Group B — Item sub-tables for discount/surcharge/quantity (codes 2020/2030/2150). Builder bug in DetallesItems.
- E310000000002 (t31): `[2150] El campo TablaSubcantidad de la sección DetallesItems de la línea 1 no es válido`
- E310000000009 (t31): `[2020] El campo TablaSubDescuento ... línea 1 no es válido; El campo DescuentoMonto ... línea 1 no es válido`
- E410000000007 (t41): `[2030] El campo TablaSubRecargo ... línea 1 no es válido; El campo RecargoMonto ... línea 1 no es válido`
- E440000000011 (t44): `[2020] El campo TablaSubDescuento ... línea 1 no es válido; El campo DescuentoMonto ... línea 1 no es válido`
- E460000000010 (t46): `[2020] El campo TablaSubDescuento ... línea 1 no es válido; El campo DescuentoMonto ... línea 1 no es válido`
FIX: In DetallesItems for the failing line, the engine is emitting (or omitting) the item-level sub-quantity / sub-discount / sub-recargo group incorrectly. Inspect the dataset fields driving these (e.g. TablaSubcantidad/SubcantidadItem, TablaSubDescuento/SubDescuentoMonto/SubDescuentoPorcentaje, TablaSubRecargo/SubRecargoMonto, and the item-level DescuentoMonto/RecargoMonto). Likely causes: (a) the indexed sub-fields aren't being mapped into the nested repeating sub-group with the exact XSD element names/order; (b) DescuentoMonto/RecargoMonto at item level doesn't reconcile with the sub-table sum; (c) emitting an empty/zero sub-table when it should be omitted, or vice versa. Use the e-CF XSDs (the DetallesItems/Item complexType with its Sub* tables) as the authority for structure, and reconcile monetary sums. xmllint passing is necessary but NOT sufficient — these are business rules beyond XSD; match the dataset's intended values exactly.

### Group C — Totals vs detail reconciliation (code 0 with descriptive message). Builder/totals bug.
- E310000000003 (t31): `OtrosImpuestosAdicionales para el Tipo de Impuesto 002 ... y 004 del área ImpuestosAdicionales de la sección Totales no coincide con el detalle de la factura.`
FIX: The `OtrosImpuestosAdicionales` amounts in Totales/ImpuestosAdicionales (for tax types 002 and 004) must equal the sum of the corresponding per-item additional taxes in the detail. Recompute the Totales additional-tax subtotals from the item lines so they reconcile, OR emit exactly the dataset-provided values consistently in both places.

## How to verify
- Real cert is staged by the MAIN agent only at run time (env P12_PATH + P12_PASSWORD); this subagent does NOT have the password. So you CANNOT submit live yourself.
- Your job: fix the builders + implement send-ordering, keep `npm run validate-all` at 29/29 local XSD PASS, and make the generated XML for the 9 failing ENCFs structurally + arithmetically correct per the error messages and the dataset. Add targeted unit checks where helpful (e.g. assert item DescuentoMonto == sum of sub-discounts; assert Totales OtrosImpuestosAdicionales == sum of item additional taxes).
- Write the fixes, commit, and report exactly what changed per group. The main agent will re-run the live batch with the real cert in correct order.

## Dataset
/home/user/workspace/dgii-engine/dataset.json (arrays ECF[25], RFCE[4]). Inspect the 9 failing cases' raw fields to see what sub-tables / additional taxes they carry.
