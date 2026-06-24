# Paso 4 — Pruebas de Simulación e-CF (módulo a construir)

## Contexto
El motor DGII (Node/TS) ya pasó Paso 2 (Pruebas de Datos: 21/21 e-CF + 4/4 RFCE + 4/4 consumo)
y Paso 3 (11/11 Aprobaciones Comerciales ACECF). Ahora vamos por **Paso 4: Pruebas de Simulación e-CF**.

Paso 4 es funcionalmente similar al Paso 2 (genera, firma, envía e-CF + RFCE + consumo en orden),
PERO con dos diferencias críticas:
1. **Secuencias NUEVAS** — ninguna secuencia puede reutilizarse de Paso 2. Ya están calculadas.
2. **Representación Impresa obligatoria** — por cada e-CF hay que generar el dato del **código QR
   (Timbre Electrónico)** para usarlo en Paso 5 (envío de RI en PDF) y Paso 6 (validación RI).

## Dataset Paso 4 (FUENTE DE VERDAD)
`/home/user/workspace/paso4_plan.json` — 25 filas, cada una:
```
{ "orden", "tipo", "nuevo_encf", "origen_paso2", "fecha", "rnc_comprador",
  "monto_total", "itbis", "doc_class", "qr" }
```
- `nuevo_encf` = la secuencia NUEVA a emitir en Paso 4.
- `origen_paso2` = la fila del Paso 2 de la que se copian los datos operacionales (montos, ítems, etc.).
- Los datos completos de cada documento (ítems, impuestos, etc.) se toman del registro `origen_paso2`
  en `dataset.json` (secciones ECF y RFCE), pero emitiendo con el `nuevo_encf`.
- `qr` ya trae la URL del Timbre con placeholders `{COD_SEG}` y `{FECHA_FIRMA}`.

## Reglas de secuencias (ya resueltas, NO recalcular)
Las nuevas secuencias por tipo (verificadas contra Paso 2):
- 31: 010,011,012,013 · 32(e-CF≥250k): 016,017 · 33: 002 · 34: 019,020
- 41: 008,009 · 43: 013,014 · 44: 014,015 · 45: 011,012 · 46: 011,012 · 47: 010,011
- 32(consumo RFCE <250k): 018,019,020,021

## Generación de QR (Timbre Electrónico) — por tipo
Tres formatos (de la doc oficial DGII):
- **e-CF normales (31,33,34,41,44,45,46,47 y 32≥250k):**
  `https://ecf.dgii.gov.do/testecf/ConsultaTimbre?RncEmisor=..&RncComprador=..&ENCF=..&FechaEmision=dd-mm-aaaa&MontoTotal=..&FechaFirma=dd-MM-aaaa%20HH:mm:ss&CodigoSeguridad=XXXXXX`
- **Tipo 43 (Gastos Menores):** igual pero SIN `RncComprador`.
- **Consumo <250k (tipo 32 RFCE):**
  `https://fc.dgii.gov.do/testecf/ConsultaTimbreFC?RncEmisor=..&ENCF=..&MontoTotal=..&CodigoSeguridad=XXXXXX`
  (SIN RncComprador, SIN FechaFirma)
- `CodigoSeguridad` = primeros 6 chars del SignatureValue (ya existe `extractSecurityCode` en signer.ts).
- `FechaFirma` = la fecha/hora real de la firma (dd-MM-yyyy HH:mm:ss), espacio codificado como %20.
- El espacio en FechaFirma se codifica %20; el & ya es separador.

## Orden de envío oficial DGII (CRÍTICO — Paso 2 lo confirmó)
1. Primero: e-CF tipos 31, 32≥250k, 41, 43, 44, 45, 46, 47 (vía servicio recepción, async trackId).
2. Segundo: los 4 Resúmenes RFCE (tipo 32 consumo, vía recepcionFC).
3. Tercero: las 4 Facturas de Consumo completas <250k (carga MANUAL en portal — el motor las firma y guarda en consumo_xml/).
4. Cuarto: las notas (tipos 33 débito, 34 crédito) AL FINAL.
Enviar notas antes causa reset. DGII RESETEA todos los datos de prueba ante CUALQUIER rechazo.

## Binding de código de seguridad (RFCE) — lección Paso 2
Para cada factura de consumo <250k: firmar la factura COMPLETA primero, extraer first-6 del SignatureValue,
inyectar ese código como `CodigoSeguridadeCF` en el Resumen RFCE (`buildRfce(data, code)`), y guardar
ESA MISMA factura firmada para la carga manual. RSA-SHA256 es determinista, los códigos coinciden.

## Lo que hay que construir
1. `src/dataset.ts`: función `getPaso4Cases()` que lee `paso4_plan.json` y arma cada documento
   combinando datos de `origen_paso2` (en dataset.json) con el `nuevo_encf` y demás campos del plan.
2. `src/qrBuilder.ts` (NUEVO): función que, dada la fila + fechaFirma real + codigoSeguridad,
   produce la URL del Timbre según el tipo. Reemplaza {COD_SEG} y {FECHA_FIRMA} en el campo qr.
3. `src/orderedRunPaso4.ts` (NUEVO, basado en orderedRun.ts): genera/firma/valida/envía las 25
   en el orden oficial, con el binding de código para los RFCE, guardando consumo en consumo_xml_paso4/.
   Debe escribir un archivo `out/paso4_qr.json` y `out/paso4_qr.csv` con: orden, tipo, eNCF, montoTotal,
   totalITBIS, fechaEmision, fechaFirma, codigoSeguridad, qrURL — uno por documento (para Pasos 5-6).
4. Validación XSD offline de los 25 (extender validate-all o un comando paso4).
5. NO enviar en vivo todavía — el envío en vivo lo coordina el agente padre con el usuario (necesita password).
   Solo dejar todo listo, build limpio, y validate-all pasando para los 25 Paso 4.

## Comandos
- Build: `npm run build`
- Validar: `npm run validate-all` (debe seguir pasando)
- El envío en vivo se hará luego con: P12_PATH, P12_PASSWORD, DGII_ENV=certecf

## Importante
- NO commitear cert.p12 ni passwords. cert.p12 está gitignored.
- Reutilizar al máximo la infraestructura existente (xmlBuilder, rfceBuilder, signer, validator, dgiiClient).
- Entregar resumen de: archivos creados/modificados, resultado de build, resultado de validate-all,
  y cómo correr el envío en vivo del Paso 4.
