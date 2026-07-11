# CLAUDE.md — adse-dgii-ecf-engine standing rules

Engine for DGII e-CF electronic fiscal documents (Dominican Republic). Node.js/TypeScript,
Express, Postgres. Deployed on Railway via git push; public URL `https://ecf.adse-rd.com`.
ADSE (RNC `133470616`) is the anchor tenant and is **live in DGII production**.

## Non-negotiables (read before every task)

1. **Environment is always explicit.** `DGII_ENV` on Railway is **production**. Any code path
   that reaches `dgiiClient` (`authenticate`, `sendEcf`, `sendRfce`, `sendAprobacion`,
   `consultaResultado`) must pass an explicit `environment` argument. A missing argument
   silently targets DGII production. This caused a real misrouting incident (2026-07-09).
   New DGII-touching endpoints must 400 when `environment` is absent (see
   `requireEnvironment` / `ENV_REQUIRED_ERROR` in `api.ts`).
2. **Test tooling refuses production.** Anything that sends test documents accepts only
   `certecf` and hard-400s every production spelling (`ecf`, `prod`, `produccion`,
   `production`).
3. **Anchor RNC `133470616` is never the target of mutating test calls.** Probes use
   throwaway RNCs (e.g. `131234567`, `131234568`), registered for the test and deleted the
   same session. `SELECT` to verify before any cleanup `DELETE`.
4. **Never print, log, or commit certificate material or passwords.** P12 passwords come
   from env/DB only. Probe certs are locally generated self-signed throwaways.
5. **tsc pass is not deploy proof.** Gate evidence is: `npx tsc --noEmit; echo "TSC_EXIT=$?"`
   → 0, plus a successful Railway deploy and a `/health` check on the deployed service.
6. **Change nothing outside the numbered scope of the current brief.** Known defects that
   are out of scope go to the hardening backlog (below), not into the diff.
7. **Do not auto-advance certification state.** `tenant_certifications` /
   `tenant_lifecycle_events` mutate only through `/certificaciones/:rnc/advance` and
   `/genesis`, driven by staff. Tooling attaches run/evidence references; humans advance.

## Legacy scripts — reference only, never run, never import

`src/sendAll.ts`, `src/pollAll.ts`, `src/orderedRun.ts`, `src/orderedRunPaso4.ts`,
`src/finalRun.ts`, `src/checkHeld.ts`, `src/sendAprobaciones.ts` are the single-tenant CLI
scripts from ADSE's own 2025 certification. They run `main()` at import, call
`process.exit`, use the anchor env cert only, hardcode RNC `133470616`, write to paths that
do not exist on Railway, and **omit `environment` — on Railway they would fire at DGII
production**. They encode valuable protocol behavior (see below) but must never be imported
by server code or executed on the deployed service.

## Known sharp edges

- `testecf` is accepted by API validation but **silently remapped to CerteCF hosts**
  (`dgiiClient.endpointsFor` is binary certecf/production; `certStore.normalizeEnv`
  collapses it). Backlog item — do not "fix" in passing.
- `certStore.keyForRnc` falls back to the anchor env cert for **any** RNC. Backlog item.
  New multi-tenant code paths must not rely on this fallback: require a `tenant_certs`
  row explicitly for non-anchor RNCs.
- `paso4_plan.json` is not in the repo (`dataset.ts` resolves it outside the repo root);
  `getPaso4Cases()` throws on Railway.
- `RFCE_ENCFS` (`types.ts`) and the dataset files at repo root (`dataset.json`,
  `acecf_dataset.json`) are **ADSE-specific certification data**, not reusable tenant logic.
- `checkEncoding` (`inputGuard.ts`) scans one level deep only. Flat string maps are fully
  covered; nested payloads are not.

## DGII protocol behaviors worth porting (from the legacy scripts)

- **Dependency order / code 614:** a nota (tipo 33/34) referencing `NCFModificado` must be
  sent after the referenced e-CF is Aceptado; sending early triggers 614. Skip-and-flag,
  never send blind.
- **Code 1209 = sequence already used** → the eNCF is already accepted on DGII from a prior
  run. Treat as success (`already_accepted`), never as rejection. This makes re-runs safe.
- **Send+poll cadence:** e-CF reception is async (trackId); poll `Consultas/Estado` every
  2.5 s, ≤14 attempts, stop on any verdict other than "en proceso". RFCE and Aprobación
  Comercial verdicts are synchronous.
- **RFCE two-step binding:** sign the FULL tipo-32 invoice first, derive
  `CodigoSeguridadeCF` from its SignatureValue (`extractSecurityCode`), embed that code in
  the RFCE summary, then sign and send the RFCE. Keep the signed full invoice — those exact
  bytes are uploaded manually to the DGII portal.
- **Prepare-all-before-send:** build + sign + XSD-validate every document before the first
  network call; one XSD failure aborts the batch before anything is sent.
- **Official send order:** regular e-CF first, RFCE consumo second, manual portal upload
  third, notas 33/34 last.

## Architecture map

- `api.ts` — Express app; emisor endpoints guarded by `EMISOR_API_KEY`
  (`x-api-key` / Bearer, timing-safe). Receptor + padrón routers mount BEFORE the guard.
- `lifecycle.ts` — 13-state certification machine (`STATES`), tenant registry, advance/genesis.
- `certStore.ts` — tenant certs (AES-256-GCM at rest), eNCF sequences (`reservar-encf`).
- `dgiiClient.ts` — endpoint sets + auth flow; per-request `environment` override.
- `receptor.ts` — DGII-facing receptor web services; forwards to platforms via
  `CRM_RECIBIDOS_INGEST_URL` / `POS_RECIBIDOS_INGEST_URL` with `PADRon_API_KEY`.
- `padronRouter.ts` / `padronSync.ts` — weekly padrón fan-out (Mon 08:00 UTC cron).
- `db.ts` — pool, AES helpers, `runMigration()` (idempotent CREATE TABLE IF NOT EXISTS).
- Builders/validators: `xmlBuilder`, `rfceBuilder`, `acecfBuilder`, `signer`, `validator`
  (XSD), `qrBuilder`, `inputGuard`.

Railway env vars are owned by Pedro and set AFTER deploy — never assume a new var exists;
code must fail closed when one is absent.

## Hardening backlog (tracked, out of scope unless briefed)

- `forwardDocument`: log when `ingestUrl` unset or forward fails.
- Digits-only RNC normalization in recibidos-ingest business lookup.
- Restrict `keyForRnc` env-cert fallback to the anchor RNC.
- Hard-fail the ephemeral ARECF path.
- Cédula dash-normalization in `extractSignerIdentity`.
- Production tipo-32 sequence skip near sale #60 (collision with accepted `E320000000061`).
- Real TesteCF endpoint set or explicit rejection of `testecf` platform-wide.
- `ecf-dgii-auth` retirement (one remaining legacy consumer).
- Platform-wide `testecf` silent remap fix: currently collapses to certecf hosts in `dgiiClient.endpointsFor` instead of hard-rejecting; `/submit` and all DGII-touching callers should 400 on `testecf` (C5 D2).
- `keyForRnc` global anchor-only restriction: env-cert fallback must be limited to RNC `133470616` in all code paths; non-anchor tenants must require a `tenant_certs` row (C5 D4).

## Reporting conventions

Every leg reports: `TSC_EXIT`, deploy confirmation (`git push` + Railway deploy status +
`/health` body), full probe transcript a–g (redact keys), files touched, and cleanup
verification (SELECT counts = 0 for throwaway rows). Commit messages: `feat(cN): …` /
`fix(cN): …` matching the phase step.
