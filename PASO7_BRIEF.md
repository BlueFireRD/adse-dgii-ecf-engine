# Paso 7+ — Módulo RECEPTOR (servidor que la DGII llamará) — BRIEF

## Contexto
LEE PRIMERO: `/home/user/workspace/dgii-engine/PASO7_RECEPTOR_SPEC.md` (contrato completo de cada endpoint, formatos ARECF/ACECF, códigos de estado).

Del Paso 7 en adelante, ADSE (RNC 133470616) actúa como **RECEPTOR**: la DGII simula ser emisor y llama a NUESTROS endpoints HTTPS. El motor ya tiene una API Express en `src/api.ts` orientada a EMISIÓN. Hay que **AÑADIR** los endpoints RECEPTORES sin romper lo existente (no tocar las rutas actuales /generate /sign /validate /submit /aprobacion). Standalone e integrable al CRM Lovable después.

## Objetivo
Crear un nuevo router/módulo `src/receptor.ts` (montado en `src/api.ts`) que exponga los servicios web del receptor según el estándar DGII, con las sub-rutas `fe/...` EXACTAS:

### Endpoints a implementar

1. **GET `/fe/autenticacion/api/semilla`**
   - Genera y devuelve un XML semilla único: `<SemillaModel><valor>UUID-o-aleatorio</valor><fecha>ISO8601</fecha></SemillaModel>`.
   - Guarda el `valor` emitido (en memoria, Map con expiración ~5 min) para validarlo luego.
   - `Content-Type: application/xml`.

2. **POST `/fe/autenticacion/api/validacioncertificado`**
   - `multipart/form-data`, campo `xml` = semilla firmada (XMLDSig) por el cliente.
   - Verifica que: (a) el XML contiene una `<Signature>` válida (usar xml-crypto para verificar la firma con el certificado embebido en el KeyInfo/X509Certificate del propio XML), (b) el `valor` de la semilla fue emitido por nosotros y no expiró.
   - Si válido: emite un **JWT propio** (HS256 con secreto de entorno `RECEPTOR_JWT_SECRET`, default dev), payload `{ rnc, iat, exp(1h) }`. Responde JSON `{ "token": "<jwt>", "expira": "<ISO>" }`.
   - Si inválido: HTTP 401 `{ "error": "..." }`. NO auto-bloquear de más: verificar firma de verdad y dejar pasar lo válido.
   - Usa una librería JWT (`jsonwebtoken`) — instálala.

3. **POST `/fe/Recepcion/api/ecf`**  (el corazón del Paso 9)
   - Headers: `Authorization: Bearer <jwt>` (validar con el mismo secreto; si falta/!válido → 401). `multipart/form-data`, campo `xml` = un e-CF firmado que la DGII nos "emite".
   - Procesar:
     a. Parsear el e-CF (xml). Extraer `TipoeCF`, `eNCF`, `RNCEmisor`, `RNCComprador`.
     b. Validar contra el XSD correspondiente (`schemaPathForEcf(tipo)` ya existe en validator.ts). Validar la firma XMLDSig del e-CF (xml-crypto verify).
     c. Determinar el Estado del acuse:
        - `Estado=0` (Recibido) si: estructura XSD OK, firma OK, y `RNCComprador` == 133470616 (ADSE).
        - `Estado=1` (No Recibido) con `CodigoMotivoNoRecibido`:
          - `1` si falla XSD (Error de especificación)
          - `2` si falla la firma (Error de Firma Digital)
          - `3` si el eNCF ya fue recibido antes en esta sesión (Envío duplicado) — lleva un Set en memoria de eNCF ya acusados
          - `4` si `RNCComprador` != 133470616 (RNC Comprador no corresponde)
     d. Construir el **ARECF** (ver formato exacto en la SPEC y el XSD `schemas/ARECF-v.1.0.xsd`), con `RNCEmisor` = el del e-CF recibido, `RNCComprador` = 133470616, `eNCF` = el recibido, `Estado`, `CodigoMotivoNoRecibido` (vacío si Estado=0), `FechaHoraAcuseRecibo` = ahora en `dd-MM-yyyy HH:mm:ss`.
     e. **FIRMAR el ARECF** con el certificado de ADSE usando `signXml()` de `src/signer.ts` + `getKey()` (igual patrón que api.ts: P12 vía env, si no hay → ephemeral; pero para acuse real se usará el P12). La firma es enveloped sobre la raíz `<ARECF>`.
     f. Responder **síncronamente** el ARECF firmado: `Content-Type: application/xml`, HTTP 200. (El acuse DEBE ser síncrono.)
   - IMPORTANTE: incluso cuando Estado=1, la RESPUESTA HTTP es 200 con el ARECF (el "no recibido" va dentro del XML, no como error HTTP). Solo usar 401/400 para fallos de autenticación o petición malformada (sin campo xml).

4. **POST `/fe/AprobacionComercial/api/ecf`**  (Paso 11)
   - Headers: `Authorization: Bearer <jwt>`, `multipart/form-data` campo `xml` = un ACECF firmado entrante.
   - Validar contra `schemaPathForAcecf()` + verificar firma. 
   - Responder JSON simple: éxito HTTP 200 `{ "codigo": "OK", "estado": "Aprobacion Comercial Aceptada", "mensaje": [] }`; si falla validación/firma HTTP 400 `{ "codigo": "Error", "estado": "<detalle>", "mensaje": ["<motivo>"] }`.

5. (Opcional, dejar stub listo) **POST `/fe/recepcionfc/api/ecf`** para RFCE de consumo <250k: validar contra `schemaPathForRfce()` y devolver ARECF firmado igual que recepción (Estado 0/1). Implementar igual que (3) pero con el schema RFCE.

## Requisitos técnicos
- Crear `src/receptor.ts` exportando `export const receptorRouter: express.Router` (o una función `mountReceptor(app)`). Montar en `src/api.ts` con `app.use(receptorRouter)` SIN alterar las rutas existentes.
- Multipart: usar `multer` (memoryStorage) para leer el campo `xml`. Instálalo: `npm i multer && npm i -D @types/multer`. También `npm i jsonwebtoken && npm i -D @types/jsonwebtoken`.
- Verificación de firma XMLDSig: reutiliza/added helper en `src/signer.ts` si conviene (ya usa xml-crypto para firmar; añade `verifyXml(xml): boolean` que valide la firma enveloped con el X509 del propio documento). Si la verificación estricta es compleja, implementa una verificación que compruebe presencia y consistencia básica de la firma y DEJA un TODO claro — pero intenta verificación real con xml-crypto primero.
- Crear builder `src/arecfBuilder.ts` con `buildArecf({rncEmisor, rncComprador, encf, estado, motivo?}): string` que arme el XML ARECF (sin firma) listo para `signXml()`.
- Añadir a validator.ts `schemaPathForArecf()` → `schemas/ARECF-v.1.0.xsd` (ya creado y validado con xmllint).
- Estado en memoria (Set de eNCF acusados, Map de semillas emitidas) — está bien para certificación; deja comentario de que en el CRM iría a BD.
- NO commitear cert.p12 ni secretos. P12 password `<TU_PASSWORD_P12>` solo vía env (`P12_PASSWORD`), en memoria. Default JWT secret solo para dev.
- El motor NO debe auto-bloquear de más: validar de verdad y responder los Estados/Códigos correctos; dejar que la DGII vea verdictos reales.

## Verificación
1. `npm run build` compila limpio (sin errores TS). No romper validate-all (debe seguir 69/69).
2. Añade un script `npm run serve` ya existe (ts-node src/api.ts). Arranca el server en un puerto y prueba con curl LOCAL:
   - GET semilla → devuelve XML semilla.
   - POST recepcion con un e-CF de ejemplo (puedes generar uno con el propio motor: usa un XML ya firmado de `getPaso4Cases()` → buildEcf → signXml, dirigido a RNCComprador 133470616) → devuelve ARECF firmado con Estado=0; valida ese ARECF contra el XSD con xmllint (debe validar) y verifica que la firma esté presente.
   - POST recepcion con RNCComprador distinto → ARECF Estado=1 motivo=4.
   - POST recepcion del MISMO eNCF dos veces → 2da vez Estado=1 motivo=3.
   - POST aprobacioncomercial con un ACECF de ejemplo → JSON OK.
   - Endpoints protegidos sin Bearer → 401.
3. Reporta los resultados de cada prueba curl (status + fragmento de respuesta), confirma que el ARECF firmado valida contra el XSD, y haz un commit LOCAL: "Paso 7: módulo receptor (semilla/auth, recepción e-CF→ARECF firmado, aprobación comercial)".

## Notas
- Repo git local SIN remoto. Commit local únicamente.
- Working dir: /home/user/workspace/dgii-engine.
- Esto prepara los Pasos 8-11; en el Paso 7 del portal solo se registran las URLs base (que luego expondremos por un host público/túnel — eso se decide con el usuario más adelante, no es parte de este build).
