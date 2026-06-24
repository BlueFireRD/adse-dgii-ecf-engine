# Paso 5 — Módulo de Representación Impresa (RI / PDF) — BRIEF

## Objetivo
Construir un módulo TypeScript **dentro del motor existente** (`/home/user/workspace/dgii-engine/`) que genere **11 PDFs de Representación Impresa** (uno por cada tipo/slot que pide el portal de la DGII en el Paso 5: Pruebas de Simulación Representación Impresa), cada uno con un **código QR escaneable** del Timbre Electrónico, usando **datos REALES ya aceptados del Paso 4**.

Estándar legal: **Ley 32-23**, **Norma 06-2018** (formato de Representación Impresa de e-CF, República Dominicana).

El módulo debe ser **standalone e integrable al CRM Lovable más adelante** (función exportada limpia, sin estado global, sin side-effects fuera de escribir los PDFs).

## Fuentes de datos (NO inventar nada — todo ya existe)
1. **`src/dataset.ts` → `getPaso4Cases(): Paso4Case[]`** — devuelve los 25 documentos del Paso 4 ya normalizados y re-keyed al eNCF enviado. Cada `Paso4Case.ecf` es un `CaseData` (objeto `{[campo]: string}`) con campos del emisor, comprador, ítems indexados `[n]`, y totales. Los campos vacíos "#e" ya fueron eliminados por `normalize()`. Importar y usar esta función — NO releer dataset.json a mano.
2. **`out/paso4_qr.json`** — array de 25 objetos `{orden, tipo, eNCF, montoTotal, totalITBIS, fechaEmision, fechaFirma, codigoSeguridad, qrURL}`. El campo **`qrURL` ya es la URL final del Timbre** (con FechaFirma codificada %20). USAR `qrURL` TAL CUAL para generar el QR — ya está resuelta y validada. Match con el caso por `eNCF`.

## Los 11 PDFs requeridos (slot del portal → eNCF)
Generar SOLO estos 11 (los otros 14 del Paso 4 no se piden como RI):

| # | Slot portal | Tipo descrito (col P, en palabras) | eNCF |
|---|---|---|---|
| 1 | tipo 31 | Crédito Fiscal | E310000000014 |
| 2 | tipo 32 ≥RD$250mil | Factura de Consumo | E320000000022 |
| 3 | tipo 33 | Nota de Débito | E330000000003 |
| 4 | tipo 34 | Nota de Crédito | E340000000021 |
| 5 | tipo 41 | Compras | E410000000010 |
| 6 | tipo 43 | Gastos Menores | E430000000015 |
| 7 | tipo 44 | Regímenes Especiales | E440000000016 |
| 8 | tipo 45 | Gubernamental | E450000000013 |
| 9 | tipo 46 | Exportaciones | E460000000013 |
| 10 | tipo 47 | Pagos al Exterior | E470000000012 |
| 11 | tipo 32 <RD$250mil | Factura de Consumo Electrónica | E320000000024 |

Nombre escrito de cada tipo (constante en el código):
- 31 → "CRÉDITO FISCAL"
- 32 → "FACTURA DE CONSUMO ELECTRÓNICA"
- 33 → "NOTA DE DÉBITO ELECTRÓNICA"
- 34 → "NOTA DE CRÉDITO ELECTRÓNICA"
- 41 → "COMPRAS"
- 43 → "GASTOS MENORES"
- 44 → "REGÍMENES ESPECIALES"
- 45 → "GUBERNAMENTAL"
- 46 → "EXPORTACIONES"
- 47 → "PAGOS AL EXTERIOR"

Nombrar los archivos: `out/ri/RI_<tipo>_<eNCF>.pdf` (p.ej. `RI_31_E310000000014.pdf`, y para los dos tipo 32 usar `RI_32grande_E320000000022.pdf` y `RI_32consumo_E320000000024.pdf`).

## Campos obligatorios en CADA RI (Ley 32-23 / Norma 06-2018)
**Encabezado / Emisor:**
- Razón Social Emisor: `RazonSocialEmisor` (= "DOCUMENTOS ELECTRONICOS DE 02")
- RNC Emisor: `RNCEmisor` (= 133470616)
- Dirección Emisor: `DireccionEmisor` (= "AVE. ISABEL AGUIAR NO. 269, ZONA INDUSTRIAL DE HERRERA")
- Teléfonos si existen (`TelefonoEmisor[1]`, `[2]`)
- Título grande: **el tipo en palabras** (de la tabla arriba)
- eNCF (número de comprobante)
- Fecha de Emisión (`FechaEmision`)
- Fecha de Vencimiento de Secuencia (`FechaVencimientoSecuencia`) si existe

**Comprador (OMITIR todo el bloque comprador SOLO para tipo 32 consumo <250k = E320000000024):**
- RNC/Cédula Comprador: `RNCComprador`
- Razón Social Comprador: `RazonSocialComprador`
- Dirección Comprador: `DireccionComprador` si existe

**Detalle de ítems** (iterar `NumeroLinea[n]` mientras exista `NombreItem[n]`):
- # Línea, Nombre (`NombreItem[n]`), Cantidad (`CantidadItem[n]`), Precio Unitario (`PrecioUnitarioItem[n]`), Monto (`MontoItem[n]`)
- Descripción (`DescripcionItem[n]`) si existe

**Totales (pie):**
- Monto Gravado / Monto Exento si existen (`MontoGravadoTotal`, `MontoExento`)
- Total ITBIS: usar `totalITBIS` del paso4_qr.json (puede venir vacío → mostrar 0.00 o omitir si vacío)
- **Monto Total** (`MontoTotal` / `montoTotal`) — destacado
- Formatear todos los montos con separador de miles y 2 decimales (formato RD: 1,234,567.89)

**Sello / Validación (obligatorio):**
- **Código de Seguridad** (6 caracteres): `codigoSeguridad` del paso4_qr.json
- **Fecha de Firma**: `fechaFirma` del paso4_qr.json
- **Código QR escaneable** del Timbre Electrónico, ubicado **abajo a la izquierda**, generado desde `qrURL`. Tamaño mínimo ~100-120px para que sea escaneable.
- Leyenda obligatoria (al pie, junto al QR): **"Representación Impresa de un Comprobante Fiscal Electrónico"**

## Requisitos técnicos
- Usar librerías Node: **`pdfkit`** (PDF) + **`qrcode`** (genera el PNG/buffer del QR a partir de la URL). Instalar: `npm i pdfkit qrcode && npm i -D @types/pdfkit @types/qrcode`. (Versiones estables actuales.)
- Codificación UTF-8 correcta para acentos y la Ñ (pdfkit fuente Helvetica soporta latin-1; verificar que "RÉGIMEN", "CRÉDITO", etc. salgan bien — si hay problemas, registrar/usar una fuente que soporte los acentos).
- Diseño profesional, una factura por página A4, márgenes razonables. **El texto NO debe cortarse, desbordar ni quedar partido.** Tablas de ítems con columnas alineadas.
- El QR debe contener exactamente la `qrURL` (sin modificar) para que al escanear lleve al ConsultaTimbre de la DGII.
- Tamaño total de los 11 PDFs **< 10 MB** (QR a resolución moderada, sin imágenes pesadas).
- Crear archivo nuevo `src/riBuilder.ts` con función exportada p.ej. `export async function buildRI(ecf: CaseData, qr: QrRow, outPath: string): Promise<void>` y un runner `src/buildRIs.ts` (o script npm `build-ri`) que recorra los 11 eNCF, los empareje con `getPaso4Cases()` + `paso4_qr.json`, y escriba los 11 PDFs en `out/ri/`.
- Añadir script npm `"build-ri": "ts-node src/buildRIs.ts"`.
- NO commitear cert.p12 ni secretos. NO loguear contraseñas. Esto es solo generación de PDF, no requiere el certificado.

## Entregable y verificación
1. Compilar limpio (`npm run build` sin errores TS).
2. Ejecutar `npm run build-ri` → genera los 11 PDFs en `out/ri/`.
3. Reportar: lista de los 11 archivos con su tamaño, tamaño total, y confirmar que el bloque comprador se omite SOLO en E320000000024.
4. Dejar el QR generado verificable (la URL incrustada debe ser idéntica a `qrURL`).
5. Hacer commit local en el repo git con mensaje "Paso 5: módulo Representación Impresa (11 RIs con QR)".

## Notas
- Repo git local SIN remoto. Hacer commit local únicamente.
- El motor ya compila y valida 69/69. No romper nada existente; solo AÑADIR el módulo RI.
