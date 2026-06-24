# Paso 7+ — Servicios Web del RECEPTOR (lo que ADSE debe EXPONER)

## Cambio de rol (CRÍTICO)
En Pasos 2–6 ADSE actuó como **EMISOR** (firmaba y enviaba a la DGII).
Del Paso 7 en adelante ADSE actúa como **RECEPTOR**: la DGII **simula ser el emisor** y **llama a TUS endpoints**. Tu sistema debe **exponer** servicios web REST públicos y responder correctamente.

Flujo de los pasos del portal:
- **Paso 7 — URL Servicios Prueba:** registras en el portal las URLs base de tus servicios (host público, ambiente CerteCF). Casillas: Recepción, Aprobación Comercial, Autenticación (semilla/validación), y posiblemente Recepción RFCE.
- **Paso 8 — Inicio Prueba Recepción e-CF:** descargas el certificado raíz de la DGII e inicias la prueba.
- **Paso 9 — Recepción e-CF:** la DGII te ENVÍA e-CF a tu endpoint de recepción; debes responder con un **Acuse de Recibo (ARECF)** firmado y síncrono.
- **Paso 10 — Inicio Prueba Recepción Aprobación Comercial.**
- **Paso 11 — Recepción Aprobación Comercial:** la DGII te envía/valida tu manejo de Aprobaciones Comerciales (ACECF).

## Endpoints que ADSE debe exponer
Patrón de ruta DGII: `https://{TU_HOST}/{ambiente}/fe/{Servicio}/api/...`
(ambiente = `CerteCF` en certificación; algunos integradores usan `/ecf/{rnc}/fe/...` en producción). Lo importante es que las **sub-rutas `fe/...`** coincidan con el estándar; el host/prefijo lo defines tú y lo registras en el Paso 7.

### 1. Autenticación (tu propio servicio — NO el de la DGII)
La DGII exige que el receptor tenga su PROPIO servicio de autenticación (no se puede reusar el de la DGII). Dos recursos:

- **GET `/fe/autenticacion/api/semilla`**
  - Sin parámetros. `accept: application/json` (o xml).
  - Respuesta: un XML **semilla** con un valor y timestamp, p.ej.:
    ```xml
    <SemillaModel><valor>cadena-aleatoria-unica</valor><fecha>2026-06-23T20:00:00</fecha></SemillaModel>
    ```
- **POST `/fe/autenticacion/api/validacioncertificado`**
  - `Content-Type: multipart/form-data`, campo **`xml`** = la semilla FIRMADA por el cliente (la DGII) con su certificado.
  - Validar la firma XMLDSig de la semilla; si es válida, emitir un **token JWT (Bearer)** propio.
  - Respuesta JSON: `{ "token": "<jwt>", "expira": "2026-06-23T21:00:00" }`
  - Ese token se exige luego como `Authorization: Bearer <jwt>` en `/fe/Recepcion/...` y `/fe/AprobacionComercial/...`.

### 2. Recepción de e-CF  →  responder ACUSE DE RECIBO (ARECF) firmado
- **POST `/fe/Recepcion/api/ecf`**
  - Headers: `accept: */*`, `Authorization: Bearer <token>`, `Content-Type: multipart/form-data`.
  - Body: campo **`xml`** = un e-CF firmado (el documento que la DGII te "emite").
  - El servidor debe: parsear el e-CF, validar (estructura XSD + firma), y responder **síncronamente** con un **ARECF firmado digitalmente** (con el certificado de ADSE).

  **Formato ARECF (Acuse de Recibo) — raíz `<ARECF>`:**
  ```xml
  <ARECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <DetalleAcusedeRecibo>
      <Version>1.0</Version>
      <RNCEmisor>132109122</RNCEmisor>     <!-- RNC del que EMITE el e-CF (la DGII en pruebas) -->
      <RNCComprador>133470616</RNCComprador> <!-- RNC de ADSE (el receptor) -->
      <eNCF>E310000000001</eNCF>
      <Estado>0</Estado>                   <!-- 0 = e-CF Recibido ; 1 = e-CF No Recibido -->
      <CodigoMotivoNoRecibido/>            <!-- solo si Estado=1: 1..4 (ver abajo) -->
      <FechaHoraAcuseRecibo>23-06-2026 20:05:13</FechaHoraAcuseRecibo>
    </DetalleAcusedeRecibo>
    <Signature xmlns="http://www.w3.org/2000/09/xmldsig#">...</Signature>
  </ARECF>
  ```
  **EstadoAcuseRecibo:** `0` = e-CF Recibido, `1` = e-CF No Recibido.
  **CodigoMotivoNoRecibido (solo si Estado=1):**
  - `1` Error de especificación (no cumple el XSD/formato)
  - `2` Error de Firma Digital
  - `3` Envío duplicado
  - `4` RNC Comprador no corresponde (el e-CF no está dirigido a ADSE)

  El acuse de recibo **DEBE ser síncrono** (respuesta inmediata en el mismo POST). Confirmado por las FAQ técnicas de la DGII.

### 3. Recepción de Aprobación / Rechazo Comercial (ACECF)
- **POST `/fe/AprobacionComercial/api/ecf`**
  - Headers: `accept: */*`, `Authorization: Bearer <token>`, `Content-Type: multipart/form-data`, campo **`xml`** = un ACECF firmado.
  - El servidor recibe la Aprobación/Rechazo Comercial y responde con un estado simple:
    - Éxito: `{ "codigo": "OK", "estado": "Aprobacion Comercial Aceptada", "mensaje": [] }` (HTTP 200)
    - Error: `{ "codigo": "Error", "estado": "...", "mensaje": ["detalle"] }` (HTTP 400)
  - NOTA: la respuesta del RECEPTOR a una ACECF entrante es solo OK/Error (no implica validación de la DGII).

  **Formato ACECF que se intercambia (raíz `<ACECF>`):**
  ```xml
  <ACECF>
    <DetalleAprobacionComercial>
      <Version>1.0</Version>
      <RNCEmisor>...</RNCEmisor>
      <eNCF>E31...</eNCF>
      <FechaEmision>dd-MM-yyyy</FechaEmision>
      <MontoTotal>0.00</MontoTotal>
      <RNCComprador>133470616</RNCComprador>
      <Estado>1</Estado>                    <!-- 1 = Aprobado/Aceptado ; 2 = Rechazado -->
      <DetalleMotivoRechazo/>               <!-- opcional, si Estado=2 -->
      <FechaHoraAprobacionComercial>dd-MM-yyyy HH:mm:ss</FechaHoraAprobacionComercial>
    </DetalleAprobacionComercial>
    <Signature .../>
  </ACECF>
  ```

### 4. (Opcional) Recepción RFCE
Algunos integradores exponen también `/fe/recepcionfc/api/ecf` para resúmenes de consumo <250k. El portal del Paso 7 puede o no pedir esta casilla. Dejarlo preparado.

## Reglas técnicas clave
- **Todas las respuestas firmadas (ARECF) usan el certificado de ADSE** (mismo .p12, password `<TU_PASSWORD_P12>`, en memoria, nunca commiteado).
- **Síncrono:** el ARECF se devuelve en la misma petición HTTP de recepción.
- **Formato de archivo / nombre:** los XML siguen el estándar de nombre `RNCEmisor+eNCF.xml`, pero al recibir solo se lee el campo `xml` del multipart.
- **Fecha/hora:** formato `dd-MM-yyyy HH:mm:ss`.
- **El motor NO debe auto-bloquear:** validar y, si algo falla, responder con el Estado/Codigo correcto (no lanzar 500 silencioso). Dejar que la DGII vea verdictos reales.
- **HTTPS público:** el host debe ser accesible por la DGII desde internet con certificado TLS válido. Para certificación se puede usar un túnel/hosting temporal; para producción, infraestructura propia o del CRM.

## Fuentes
- Informe Técnico e-CF v1.0 (DGII): https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Informe%20y%20Descripci%C3%B3n%20T%C3%A9cnica/Informe%20T%C3%A9cnico%20e-CF%20v1.0.pdf
- Descripción Técnica de Facturación Electrónica (endpoints fe/Recepcion, fe/AprobacionComercial, fe/Autenticacion): https://es.scribd.com/document/630673956/Descripcion-tecnica-de-facturacion-electronica
- Formato Aprobación Comercial v1.0 + ACECF XSD: https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Documentacin%20sobre%20eCF/Formatos%20XML/Formato%20Aprobaci%C3%B3n%20Comercial%20v1.0.pdf
- ARECF v1.0 (Acuse de Recibo): portal DGII "Documentación Técnica (XSD)".
- Implementación de referencia receptor (semilla/validacioncertificado/recepcion): https://github.com/victors1681/dgii-ecf
- Comunidad DGII (endpoints y respuestas reales): https://ayuda.dgii.gov.do/
