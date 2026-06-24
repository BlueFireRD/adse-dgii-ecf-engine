# Paso 3 — Aprobación Comercial (ACECF) module brief

## Goal
Extend the existing DGII engine in `/home/user/workspace/dgii-engine/` to GENERATE, SIGN, VALIDATE, and SEND
Aprobación Comercial documents (ACECF) for Paso 3 of certification. Must integrate cleanly so the whole engine
can later be embedded in the CRM. Follow the EXACT same patterns already used for e-CF and RFCE.

## ACECF XML format (root `<ACECF>`)
Schema already saved at `schemas/ACECF-v.1.0.xsd`. Structure:
```
<ACECF>
  <DetalleAprobacionComercial>
    <Version>1.0</Version>
    <RNCEmisor>...</RNCEmisor>            <!-- RNC of the e-CF EMITTER (the other party) -->
    <eNCF>E310000000001</eNCF>            <!-- the e-CF being approved -->
    <FechaEmision>01-04-2020</FechaEmision>   <!-- dd-MM-yyyy, MUST match the original e-CF -->
    <MontoTotal>95597.70</MontoTotal>     <!-- MUST match original e-CF MontoTotal, 2 decimals -->
    <RNCComprador>...</RNCComprador>      <!-- RNC of the BUYER/receptor giving approval (=ADSE here) -->
    <Estado>1</Estado>                    <!-- 1 = e-CF Aceptado, 2 = e-CF Rechazado -->
    <DetalleMotivoRechazo>...</DetalleMotivoRechazo>  <!-- ONLY if Estado=2; OMIT the tag entirely if Estado=1 -->
    <FechaHoraAprobacionComercial>20-02-2026 22:22:32</FechaHoraAprobacionComercial> <!-- dd-MM-yyyy HH:mm:ss -->
  </DetalleAprobacionComercial>
  <Signature .../>  <!-- enveloped XMLDSIG, same signer as e-CF -->
</ACECF>
```
CRITICAL XML rules (same as e-CF, already proven):
- No empty tags. Omit `DetalleMotivoRechazo` entirely when Estado=1.
- UTF-8 no BOM, no xml declaration after signing (signer strips it), single-line / inter-element whitespace
  stripped BEFORE signing (the signer already does this via compactXml).
- `MontoTotal` must be a decimal with exactly 2 fraction digits matching `Decimal18D2Validation`.
- `FechaEmision` regex dd-MM-yyyy; `FechaHoraAprobacionComercial` regex dd-MM-yyyy HH:mm:ss.

## Signing
Reuse `signXml(xml, key)` from `src/signer.ts` UNCHANGED. It already does exc-c14n, SHA-256, RSA-SHA256,
enveloped, Signature appended as last child of root, X509 leaf in KeyInfo. ACECF signs identically to e-CF.

## DGII endpoint (certecf) — ADD to `src/dgiiClient.ts` ENDPOINTS
```
aprobacionComercial: 'https://ecf.dgii.gov.do/CerteCF/AprobacionComercial/api/AprobacionComercial'
```
NOTE the casing: `CerteCF` and `AprobacionComercial` (capitalized) per the DGII community Paso 3 thread.
POST multipart/form-data, field name `xml`, type text/xml, header `Authorization: bearer <token>`,
filename `{RNCEmisor}{eNCF}.xml` (reuse `dgiiFilename`). The auth/semilla flow is IDENTICAL (reuse `authenticate`).
Response: JSON like the RFCE sync response `{codigo, estado, mensajes:[{codigo,valor}], encf}`. It is SYNCHRONOUS
(like RFCE) — NOT async/trackId. So `sendAprobacion` returns the verdict directly; no consultaResultado polling.
Add `export async function sendAprobacion(signedXml, encf, key)` mirroring `sendRfce`.

## Dataset
The Paso 3 set is a SEPARATE Excel the user will download ("DESCARGAR APROBACIONES COMERCIALES"). Until it is
provided, build a `src/acecfBuilder.ts` that accepts an `AcecfCase` object with fields:
{ RNCEmisor, eNCF, FechaEmision, MontoTotal, RNCComprador, Estado, DetalleMotivoRechazo?, FechaHoraAprobacionComercial? }
If FechaHoraAprobacionComercial is missing, synthesize it as the current time in dd-MM-yyyy HH:mm:ss.
Also add a loader `getAcecfCases()` in dataset.ts that, FOR NOW, derives candidate approvals from the existing
e-CF dataset (one ACECF per accepted e-CF: map RNCEmisor/eNCF/FechaEmision/MontoTotal/RNCComprador straight from
each e-CF case, Estado=1). This lets us smoke-test generation+signing+XSD offline before the real set arrives.
Make the real Excel easy to wire: a TODO comment showing where to plug a parsed Paso-3 sheet.

## Builder approach
Do NOT reuse the generic XSD-walker (buildShared) unless trivial — ACECF is tiny and flat. A direct
string-template builder is clearer and safer (like rfceBuilder but simpler). Escape values with the existing
`escapeXml`. Emit fields in EXACT schema order. Omit DetalleMotivoRechazo when Estado=1.

## Validator
Add `schemaPathForAcecf()` to `src/validator.ts` returning `schemas/ACECF-v.1.0.xsd`, and ensure
`validateXml(xml, schemaPathForAcecf(), encf)` works (xmllint). Add ACECF to `npm run validate-all`.

## API + CLI (for CRM integration)
- HTTP API (`src/api.ts`): add `POST /aprobacion` that takes an AcecfCase (or {encf} to look up), builds+signs+
  optionally validates, and returns the signed XML. Add `POST /submit-aprobacion` that signs and sends to DGII,
  returning the verdict. Keep response shapes consistent with existing endpoints.
- CLI (`src/cli.ts`): add subcommands `gen-aprobacion`, `validate-aprobacion`, `send-aprobacion`.

## Live send script for Paso 3
Create `src/sendAprobaciones.ts` mirroring the structure of `src/orderedRun.ts`:
- authenticate once,
- for each ACECF case: build -> sign -> sendAprobacion -> log verdict (Aceptado/Rechazado + mensajes),
- write results to `out/_aprobacion_results.json`,
- print a SUMMARY `Aprobaciones accepted: X/Y`.
Env: P12_PATH, P12_PASSWORD, DGII_ENV=certecf. Do NOT hardcode the password.

## Testing you MUST do (offline, no password needed beyond local sign test)
1. `npm run build` clean (fix any TS types; the project compiles with tsc -p tsconfig.json).
2. Generate ACECF for a few sample e-CF, sign with the cert, and confirm `validateXml(..., schemaPathForAcecf())`
   returns valid for ALL generated ACECF. The cert is staged by the parent at runtime; for your offline test,
   stage it yourself: `CB=$(find /home/user/workspace -name cert_base64.txt|head -1); base64 -d "$CB" > cert.p12`
   then export P12_PATH=$PWD/cert.p12 P12_PASSWORD='<TU_PASSWORD_P12>' DGII_ENV=certecf. DELETE cert.p12 when done.
3. Confirm DetalleMotivoRechazo is omitted for Estado=1 and present for Estado=2 (make one synthetic Estado=2).
4. Do NOT run a live DGII send — the parent will coordinate that with the user (needs the real Paso 3 dataset).

## Constraints
- Keep ALL existing functionality working (don't break e-CF/RFCE). Re-run `npm run validate-all` to confirm 29/29 still pass.
- Never log or commit the password. cert.p12 stays gitignored and deleted after use.
- Commit your work with a clear message when done.
- Report: files added/changed, sample signed ACECF (first ~20 lines), XSD validation results, and exactly what
  remains (i.e., wiring the real Paso 3 Excel + live send).
