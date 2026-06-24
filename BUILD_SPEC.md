# DGII e-CF Fiscal Engine — Build Specification

You are building a **standalone Node.js/TypeScript service** that generates, signs, validates, and submits Dominican Republic DGII electronic fiscal documents (e-CF and RFCE). This runs OUTSIDE any CRM; a CRM will later call its HTTP API. The whole point of this rebuild is to get a clean, correct, locally-validated engine that does NOT self-block — it lets DGII return real verdicts.

## Repository setup
Repository setup: use existing workspace at `/home/user/workspace/dgii-engine`. Do NOT clone. All work happens in this directory.

## What already exists in the workspace
- `schemas/` — ALL official DGII XSDs, downloaded and valid:
  - `e-CF-31-v.1.0.xsd`, `e-CF-32-v.1.0.xsd`, `e-CF-33-v.1.0.xsd`, `e-CF-34-v.1.0.xsd`, `e-CF-41-v.1.0.xsd`, `e-CF-43-v.1.0.xsd`, `e-CF-44-v.1.0.xsd`, `e-CF-45-v.1.0.xsd`, `e-CF-46-v.1.0.xsd`, `e-CF-47-v.1.0.xsd`
  - `RFCE-32-v.1.0.xsd` (summary schema for consumo facturas < RD$250,000)
  - `Semilla-v.1.0.xsd` (auth seed)
- `dataset.json` — extracted DGII official test set. Two arrays:
  - `ECF`: 25 cases (full e-CF documents)
  - `RFCE`: 4 cases (summary documents, all tipo 32)
- `dataset.xlsx` — original source spreadsheet (reference only)
- `scripts/extract_dataset.py` — the extractor that produced dataset.json
- `xmllint` is installed at `/usr/bin/xmllint` (libxml 21502) for XSD validation.

## CRITICAL dataset rules
1. **`#e` means the field is EMPTY → OMIT the XML tag entirely.** Never emit empty tags. Never emit a tag with value "#e".
2. **Indexed fields** like `FormaPago[1]`/`MontoPago[1]`...`[7]`, `TelefonoEmisor[1]`...`[3]`, `TipoImpuesto[1]`...`[4]` map to **repeating XML groups**. For each index i where the field is not `#e`, emit one group instance. E.g. `FormaPago[1]=1, MontoPago[1]=400000.00` → one `<FormaDePago><FormaPago>1</FormaPago><MontoPago>400000.00</MontoPago></FormaDePago>` group (verify exact element names against the XSD).
3. **Element ORDER matters** — XSD uses `xsd:sequence`. Emit elements in the exact order the XSD declares them. Validate with xmllint to catch ordering errors.
4. **Money**: format to exactly 2 decimals.
5. The e-CF schema element tree is **unified across types** (31/32/33/34/41/43/44/45/46/47) — same structure, only which elements are required differs by type. Each type has its own XSD but they share the tree; validate each doc against ITS type's XSD.
6. Export/reference fields (`NumeroContenedor`, `NumeroReferencia`, `NumeroEmbarque`) live in the `InformacionesAdicionales` group.

## RFCE vs full e-CF routing (IMPORTANT)
- The four ENCFs **E320000000011, E320000000012, E320000000013, E320000000015** appear in BOTH the ECF and RFCE arrays. These are tipo-32 consumo invoices **< RD$250,000**, so they MUST be emitted using the **RFCE summary schema** (`RFCE-32-v.1.0.xsd`) and sent to the **fc. host**. Use the `RFCE` array data for these.
- RFCE structure is summary-only: root `<RFCE>` → `<Encabezado>` (Version, IdDoc, Emisor, Comprador, Totales) + `<CodigoSeguridadeCF>`. NO line items (no `<DetallesItems>`). Inspect `RFCE-32-v.1.0.xsd` for exact element tree and order.
- All OTHER cases (including tipo-32 cases E320000000006 and E320000000005 which are ≥250k or full invoices) use the **full e-CF schema** for their type, sent to the **ecf. host**.

## RFCE root element requirement (known prior failure)
A prior DGII rejection was: missing `RFCE@xmlns:xsi`. The RFCE root element MUST declare the xsi namespace and the schema location attribute exactly as the XSD/spec expects, e.g.:
`<RFCE xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="RFCE-32-v.1.0.xsd" ...>`
Check the XSD and DGII spec PDFs for the exact required root attributes (also applies to e-CF root `<ECF>`). Match exactly.

## Signing requirements (XML-DSig) — these were the root cause of prior HTTP 400s
The prior CRM failed because it used inclusive C14N. You MUST use:
- PKCS#12 (.p12) loaded via `node-forge` (cert + private key). Password supplied at runtime via env var `P12_PASSWORD` (do NOT hardcode; do NOT print it).
- Enveloped signature using `xml-crypto`.
- **Canonicalization: exclusive C14N** → `http://www.w3.org/2001/10/xml-exc-c14n#` (NOT `REC-xml-c14n-20010315`).
- The Reference transforms must be: enveloped-signature transform THEN exc-c14n transform.
- Digest: SHA-256 (`http://www.w3.org/2001/04/xmlenc#sha256`).
- Signature method: RSA-SHA256 (`http://www.w3.org/2001/04/xmldsig-more#rsa-sha256`).
- **`preserveWhiteSpace: false`** when constructing the SignedXml / parsing.
- The `<Signature>` element must be appended as the **LAST child of the document root** (enveloped, inside root `<ECF>`/`<RFCE>`).
- KeyInfo must include the X509 certificate (`<X509Data><X509Certificate>...</X509Certificate></X509Data>`).
- Output: UTF-8, **no BOM**, compact single-line (no pretty-print whitespace between elements after signing — whitespace changes break the digest).

The cert binding is CORRECT and must NEVER be a local block: cert SN is `IDCDO-40220012856` (Pedro Leonel Jimenez Castillo) which differs from RNCEmisor `133470616` — this is per DGII spec ("El campo SN debe corresponder al RNC, Cédula o Pasaporte del propietario del certificado"; Pedro is the registered representative). Do NOT implement any `certificate_claim_mismatch` check.

## DGII endpoint URLs (CerteCF / certification environment — CASING MATTERS)
- Auth seed (GET): `https://ecf.dgii.gov.do/certecf/autenticacion/api/autenticacion/semilla`
- Validate seed (POST signed seed): `https://ecf.dgii.gov.do/certecf/autenticacion/api/autenticacion/validarsemilla`
- Recepción e-CF (POST): `https://ecf.dgii.gov.do/certecf/recepcion/api/recepcion/ecf`
- Recepción RFCE (POST): `https://fc.dgii.gov.do/Certecf/recepcionfc/api/recepcion/ecf`  ← note `Certecf` with CAPITAL C on the fc host; the ecf host uses lowercase `certecf`.
- Consulta resultado: `https://ecf.dgii.gov.do/certecf/consultaresultado/...` (find exact path in spec PDFs if needed)

### Auth flow
1. GET semilla → returns XML seed.
2. Sign the seed XML with the same XML-DSig signing described above.
3. POST signed seed to `validarsemilla` as multipart/form-data, field name **`xml`**, content-type `text/xml`. Equivalent curl: `-F "xml=@seed_signed.xml;type=text/xml"`.
4. Response returns a bearer token.
5. For recepcion/recepcionFC: POST the signed document as multipart `xml` field, header `Authorization: bearer <token>` (lowercase "bearer").

### Response formats
- RFCE success = JSON `{codigo, estado, mensajes[], encf, secuenciaUtilizada}`.
- HTTP 400 with empty `<html>ERROR:</html>` body historically meant signature/c14n was wrong.

## Build the engine with this structure
```
dgii-engine/
  src/
    types.ts          # TS interfaces for dataset cases, ECF doc, RFCE doc
    dataset.ts        # load + normalize dataset.json (strip #e, parse indexed fields)
    xmlBuilder.ts     # build e-CF XML per type from a case (correct order, omit empties, repeating groups)
    rfceBuilder.ts    # build RFCE summary XML from a case
    signer.ts         # node-forge load p12 + xml-crypto enveloped exc-c14n SHA256 signing
    validator.ts      # run xmllint --schema <type-xsd> against a generated file, return pass/fail + errors
    dgiiClient.ts     # auth(semilla→sign→validarsemilla→token), sendEcf, sendRfce — exact URLs
    api.ts            # express HTTP API: POST /generate, POST /sign, POST /validate, POST /submit (see below)
    cli.ts            # CLI entry: generate+validate all 29 docs, print pass/fail table
  schemas/            # (already present)
  out/                # generated + signed XML output (gitignore)
  dataset.json        # (already present)
  package.json, tsconfig.json
  README.md
```

### HTTP API (so a CRM can call it later)
- `POST /generate` body `{type, case}` → returns generated XML (unsigned).
- `POST /sign` body `{xml}` (or generates from case) → returns signed XML. Reads P12 from configured path + `P12_PASSWORD` env.
- `POST /validate` body `{xml, type}` → runs xmllint, returns `{valid, errors}`.
- `POST /submit` body `{xml, kind:"ecf"|"rfce"}` → auths, submits to DGII, returns DGII response verbatim.
- `GET /health` → ok.
Keep it simple (express). No auth on the API for now (local service).

## Acceptance criteria — DO THIS LOOP UNTIL IT PASSES
1. Implement generation for all 25 ECF cases + 4 RFCE cases.
2. For EVERY generated document, validate against its type-specific XSD with xmllint:
   - e-CF cases → `xmllint --noout --schema schemas/e-CF-<type>-v.1.0.xsd out/<encf>.xml`
   - RFCE cases → `xmllint --noout --schema schemas/RFCE-32-v.1.0.xsd out/<encf>_rfce.xml`
3. **Iterate on xmlBuilder/rfceBuilder until ALL 29 documents pass xmllint validation with zero errors.** This is the hard part — fix element ordering, omitted-empty handling, repeating groups, root attributes, decimal formatting, etc. by reading the XSDs.
4. Implement the signer and verify a signed document still validates structurally (signature appended inside root) and that the signature digest is self-consistent (xml-crypto verify round-trip with the public cert).
5. Write a `npm run validate-all` script (cli.ts) that regenerates + validates all 29 and prints a clear PASS/FAIL table. The final run MUST show 29/29 PASS.
6. Do NOT submit to DGII yet (no password available in this subagent run). Just make generation + signing + local validation fully working. Leave dgiiClient + /submit implemented but untested-against-live.

## Reference PDFs (if you need to resolve ambiguity on element names/order/root attrs)
Specs are in the workspace under uploaded attachments. Search for them:
`find /home/user/workspace/uploaded_attachments -name '*.pdf'` — key files: `Informe-Tecnico-e-CF-v1.0.pdf`, `Descripcion-Tecnica-Servicios-DGII.pdf`, `Descripcion-Tecnica-Emisores-Electronicos.pdf`. But the XSDs are the authoritative source for element order/names — trust xmllint.

## Deliverables / report back
- Confirm 29/29 local XSD validation PASS (paste the final validate-all table).
- List any cases where dataset values had to be coerced and why.
- Confirm signer round-trip verify works.
- Note exact run instructions in README (env vars: `P12_PATH`, `P12_PASSWORD`, `DGII_ENV=certecf`).
- Do NOT print or log the P12 password anywhere.
