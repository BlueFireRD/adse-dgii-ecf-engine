# DGII e-CF / RFCE Fiscal Engine

Standalone Node.js/TypeScript service that **generates, signs, validates** (against
the official DGII XSDs with `xmllint`) and **submits** Dominican Republic DGII
electronic fiscal documents (e-CF and RFCE). It is designed to be called by a CRM
over HTTP and, crucially, does **not** self-block — DGII returns the real verdicts.

## What it does

- **Schema-driven generation.** The builder walks each document type's XSD in
  `xsd:sequence` order, so element ordering is always correct by construction.
  Empty (`#e`) dataset fields are omitted; indexed fields
  (`FormaPago[1..7]`, `TelefonoEmisor[1..3]`, item lines, item tax sub-tables,
  …) expand into repeating XML groups.
- **Type-aware routing.** All 25 ECF cases are emitted as full e-CF for their
  type (`31/32/33/34/41/43/44/45/46/47`). The four tipo-32 consumo ENCFs
  `E320000000011/12/13/15` are additionally emitted as **RFCE** summaries
  (`RFCE-32` schema) for the `fc.` host.
- **XML-DSig signing.** PKCS#12 (node-forge) + `xml-crypto` enveloped signature,
  **exclusive C14N**, SHA-256 digest, RSA-SHA256, signature appended as the last
  child of the root, X509 cert in `KeyInfo`, UTF-8 no BOM, compact single line.
- **Validation.** `xmllint --noout --schema <type-xsd>` per document.

## Layout

```
src/
  types.ts        TS interfaces + constants (ECF types, RFCE ENCFs)
  dataset.ts      load + normalize dataset.json (strip #e)
  xsd.ts          parse an XSD into an ordered element tree
  buildShared.ts  the schema-driven walker (ordering, omit-empty, repeating groups)
  xmlBuilder.ts   buildEcf(case, type)
  rfceBuilder.ts  buildRfce(case) + CodigoSeguridadeCF synthesis
  signer.ts       PKCS#12 / ephemeral key load, enveloped exc-c14n SHA256 signing + verify
  validator.ts    xmllint runner
  dgiiClient.ts   auth (semilla -> sign -> validarsemilla -> token), sendEcf, sendRfce
  api.ts          express: /generate /sign /validate /submit /health
  cli.ts          validate-all: regenerate + sign + validate all 29 docs, print table
schemas/          official DGII XSDs
out/              generated + signed XML (gitignored)
dataset.json      DGII official test set (ECF[25], RFCE[4])
```

## Install & build

```bash
npm install
npm run build      # tsc -> dist/
```

## Validate all 29 documents

```bash
npm run validate-all
```

Regenerates, signs and validates all 25 e-CF + 4 RFCE documents and prints a
PASS/FAIL table. With no `P12_PATH` set it signs with an **ephemeral self-signed
certificate** so the full generate → sign → validate → verify pipeline runs
offline. The final line reads `RESULT: 29/29 PASS`.

## HTTP API

```bash
npm run serve      # ts-node src/api.ts  (or: npm start, after build)
```

- `GET  /health` → `{ ok: true, env }`
- `POST /generate` `{ type, case }` → unsigned XML
- `POST /sign` `{ xml }` or `{ type, case }` → signed XML
- `POST /validate` `{ xml, type }` (`type:"rfce"` or an e-CF type) → `{ valid, errors }`
- `POST /submit` `{ xml, kind:"ecf"|"rfce", encf }` → DGII response verbatim
  (refuses to submit with an ephemeral cert)

## Environment variables

| Var            | Purpose                                                        |
|----------------|----------------------------------------------------------------|
| `P12_PATH`     | Path to the PKCS#12 (.p12) certificate.                        |
| `P12_PASSWORD` | P12 password. **Never logged.** Required if `P12_PATH` is set. |
| `DGII_ENV`     | Environment label (default `certecf`).                         |
| `PORT`         | API port (default `3000`).                                     |

```bash
export P12_PATH=/secure/cert.p12
export P12_PASSWORD=********        # never printed by this service
export DGII_ENV=certecf
npm run validate-all               # now signs with the real cert
```

## DGII endpoints (CerteCF — casing matters)

| Action            | URL                                                                          |
|-------------------|------------------------------------------------------------------------------|
| Seed (GET)        | `https://ecf.dgii.gov.do/certecf/autenticacion/api/autenticacion/semilla`    |
| Validate seed     | `https://ecf.dgii.gov.do/certecf/autenticacion/api/autenticacion/validarsemilla` |
| Recepción e-CF    | `https://ecf.dgii.gov.do/certecf/recepcion/api/FacturasElectronicas` (async → `trackId`) |
| Resultado e-CF    | `https://ecf.dgii.gov.do/certecf/consultaresultado/api/Consultas/Estado?trackId=<id>` |
| Recepción RFCE    | `https://fc.dgii.gov.do/Certecf/recepcionfc/api/recepcion/ecf` (capital `C`, synchronous verdict) |

Auth: GET seed → sign → POST signed seed to `validarsemilla` as multipart field
`xml` (`type=text/xml`) → bearer token → submit signed document with header
`Authorization: bearer <token>`.

The signed payload must be **single-line with no inter-element whitespace**: the
seed returned by DGII is pretty-printed, and any inherited indentation breaks
DGII's canonical recomputation (`HTTP 400 "Firma del certificado invalida"`).
`signXml` normalizes the DOM (drops whitespace-only text nodes) before signing.

Upload filename must be `{RNCEmisor}{eNCF}.xml` or DGII rejects with code 3243
("La longitud del nombre del archivo no es válida"). e-CF reception is
asynchronous: it returns a `trackId`; poll `Consultas/Estado` for the
Aceptado/Rechazado verdict. RFCE reception returns the verdict synchronously.

## Certificate binding

The certificate SN (`IDCDO-40220012856`, Pedro Leonel Jimenez Castillo) differs
from `RNCEmisor` (`133470616`) **by design** — per DGII the SN corresponds to the
registered representative who owns the certificate. The engine contains **no**
`certificate_claim_mismatch` self-block.

## Notes on the provided schemas

Two of the supplied XSDs were authored against the .NET regex/schema engine and
could not be compiled by libxml2 (`xmllint`). They were corrected without altering
element names, ordering, or validation intent:

- `e-CF-31-v.1.0.xsd`: the `IndicadorServicioTodoIncluidoType` definition had a
  stray leading space in its `name` attribute, so the type reference did not resolve.
- `RFCE-32-v.1.0.xsd`: four patterns used .NET non-capturing groups `(?:…)`, which
  are not valid in XSD 1.0 regular expressions; rewritten as plain groups `(…)`.
