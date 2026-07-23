import express, { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { buildEcf } from './xmlBuilder';
import { buildRfce } from './rfceBuilder';
import { buildAcecf, AcecfCase } from './acecfBuilder';
import { normalize, getAcecfCase } from './dataset';
import { schemaPathForEcf, schemaPathForRfce, schemaPathForAcecf, validateXml } from './validator';
import { generateEphemeralKey, signXml, extractSecurityCode, loadP12FromDerBinary, KeyMaterial } from './signer';
import * as forge from 'node-forge';
import { keyForRnc, upsertCert, reservarEncf, upsertSequence } from './certStore';
import { sendEcf, sendRfce, sendAprobacion, authenticate, consultaResultado } from './dgiiClient';
import { runMigration } from './db';
import { RFCE_ENCFS } from './types';
import {
  upsertTenant,
  listTenants,
  getTenantFull,
  advanceCertification,
  genesisCertification,
} from './lifecycle';
import { receptorRouter } from './receptor';
import { padronRouter, schedulePadronCron } from './padronRouter';
import { checkEncoding } from './inputGuard';
import { extractFechaFirma, buildEcfQrUrl, buildFcQrUrl, xmlTag } from './qrBuilder';
import { buildOrchestratorRouter } from './orchestrator';

const ADSE_RNC = '133470616';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '10mb' }));

// RECEPTOR web services (fe/...). Mounted before the emisor API-key guard so
// the DGII can call us without an emisor key.
app.use(receptorRouter);
app.use(padronRouter);

/**
 * API-key guard for emisor endpoints (/generate, /sign, /validate, etc.).
 * Disabled when EMISOR_API_KEY is unset (local dev). Accepts the key via
 * "x-api-key" header or "Authorization: Bearer <key>".
 */
const EMISOR_API_KEY = process.env.EMISOR_API_KEY || '';
function emisorAuth(req: Request, res: Response, next: NextFunction) {
  if (!EMISOR_API_KEY) return next();
  const header = String(req.headers['authorization'] || '');
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const provided = String(req.headers['x-api-key'] || '') || bearer;
  if (provided && timingSafeEqualStr(provided, EMISOR_API_KEY)) return next();
  return res.status(401).json({ error: 'unauthorized: missing or invalid API key' });
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract RNCEmisor from a JSON request body (case object or top-level field). */
function rncFromBody(body: any): string {
  if (typeof body === 'string') {
    const m = body.match(/<RNCEmisor>\s*([0-9]+)\s*<\/RNCEmisor>/);
    return m ? m[1] : ADSE_RNC;
  }
  if (body?.case?.RNCEmisor) return String(body.case.RNCEmisor);
  if (body?.RNCEmisor) return String(body.RNCEmisor);
  return ADSE_RNC;
}

/** Extract RNCEmisor from a signed or unsigned XML string. */
function rncFromXml(xml: string): string {
  const m = xml.match(/<RNCEmisor>\s*([0-9]+)\s*<\/RNCEmisor>/);
  return m ? m[1] : ADSE_RNC;
}

/**
 * Resolve signing key for an RNC.
 * Uses the DB cert if available; falls back to env cert; last resort is ephemeral.
 */
async function resolveKey(rnc: string): Promise<{ key: KeyMaterial; ephemeral: boolean }> {
  const key = await keyForRnc(rnc);
  if (key) return { key, ephemeral: false };
  return { key: generateEphemeralKey(), ephemeral: true };
}

/**
 * PSF endpoints must never fall back to DGII_ENV (production since go-live).
 * Returns 'ecf' | 'certecf' for known members, 'testecf-rejected' for testecf
 * (any case), or null for absent/blank/unknown — callers must 400 on null or sentinel.
 */
function requireEnvironment(raw: unknown): string | null {
  const e = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (e === 'ecf' || e === 'prod' || e === 'produccion' || e === 'production') return 'ecf';
  if (e === 'certecf') return 'certecf';
  if (e === 'testecf') return 'testecf-rejected';
  return null;
}

const ENV_REQUIRED_ERROR = {
  error: 'missing "environment" — send "certecf" or "ecf" explicitly.',
};

const TESTECF_REJECTED_ERROR = {
  error: 'environment "testecf" is not supported: TesteCF endpoints are not configured; use "certecf"',
};

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, env: process.env.DGII_ENV || 'certecf' });
});

/** POST /generate { type, case } -> unsigned XML. */
app.post('/generate', emisorAuth, (req: Request, res: Response) => {
  try {
    const { type, case: rawCase } = req.body;
    if (!rawCase) return res.status(400).json({ error: 'missing "case"' });
    const data = normalize(rawCase);
    const t = String(type || data.TipoeCF);
    const xml = isRfce(data, t) ? buildRfce(data) : buildEcf(data, t);
    res.type('application/xml').send(xml);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /sign { xml } | { type, case } -> signed XML. Selects cert by RNCEmisor. */
app.post('/sign', emisorAuth, async (req: Request, res: Response) => {
  try {
    let xml: string | undefined = typeof req.body === 'string' ? req.body : req.body.xml;
    if (!xml && req.body.case) {
      const data = normalize(req.body.case);
      const t = String(req.body.type || data.TipoeCF);
      xml = isRfce(data, t) ? buildRfce(data) : buildEcf(data, t);
    }
    if (!xml) return res.status(400).json({ error: 'missing "xml" or "case"' });
    const rnc = rncFromBody(req.body);
    const { key } = await resolveKey(rnc);
    res.type('application/xml').send(signXml(xml, key));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /validate { xml, type } -> { valid, errors }. */
app.post('/validate', emisorAuth, (req: Request, res: Response) => {
  try {
    const xml: string = typeof req.body === 'string' ? req.body : req.body.xml;
    const type = String((req.body && req.body.type) || '').toLowerCase();
    if (!xml) return res.status(400).json({ error: 'missing "xml"' });
    const schema = type === 'rfce' ? schemaPathForRfce() : schemaPathForEcf(type);
    const result = validateXml(xml, schema);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function resolveAcecfCase(body: any): AcecfCase | { error: string } {
  if (body && body.eNCF && body.RNCEmisor) return body as AcecfCase;
  const encf = body && (body.encf || body.eNCF);
  if (encf) {
    const c = getAcecfCase(String(encf));
    if (!c) return { error: `no ACECF case derivable for eNCF ${encf}` };
    return c;
  }
  return { error: 'provide a full AcecfCase or { encf }' };
}

/** POST /aprobacion { ...AcecfCase | encf, validate? } -> signed ACECF XML. */
app.post('/aprobacion', emisorAuth, async (req: Request, res: Response) => {
  try {
    const resolved = resolveAcecfCase(req.body);
    if ('error' in resolved) return res.status(400).json({ error: resolved.error });
    const { key } = await resolveKey(resolved.RNCEmisor || ADSE_RNC);
    const signed = signXml(buildAcecf(resolved), key);
    if (req.body && req.body.validate) {
      const result = validateXml(signed, schemaPathForAcecf(), resolved.eNCF);
      if (!result.valid) return res.status(422).json(result);
    }
    res.type('application/xml').send(signed);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /submit-aprobacion { ...AcecfCase | encf } -> DGII verdict. */
app.post('/submit-aprobacion', emisorAuth, async (req: Request, res: Response) => {
  try {
    const resolved = resolveAcecfCase(req.body);
    if ('error' in resolved) return res.status(400).json({ error: resolved.error });
    const { key, ephemeral } = await resolveKey(resolved.RNCEmisor || ADSE_RNC);
    if (ephemeral) {
      return res.status(412).json({
        error: 'No P12 configured; refusing to submit to DGII with an ephemeral cert. Set P12_PATH and P12_PASSWORD.',
      });
    }
    const signed = signXml(buildAcecf(resolved), key);
    const result = await sendAprobacion(signed, resolved.eNCF, key);
    res.status(result.status).type('application/json').send(result.body);
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

/** POST /submit { xml, kind, encf, environment } -> DGII response verbatim. */
app.post('/submit', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { xml, kind, encf, environment } = req.body;
    if (!xml || !kind) return res.status(400).json({ error: 'missing "xml" or "kind"' });
    const env = requireEnvironment(environment);
    if (!env) return res.status(400).json(ENV_REQUIRED_ERROR);
    if (env === 'testecf-rejected') return res.status(400).json(TESTECF_REJECTED_ERROR);
    const rnc = rncFromXml(xml);
    const { key, ephemeral } = await resolveKey(rnc);
    if (ephemeral) {
      return res.status(412).json({
        error: 'No P12 configured; refusing to submit to DGII with an ephemeral cert. Set P12_PATH and P12_PASSWORD.',
      });
    }
    const result = kind === 'rfce'
      ? await sendRfce(xml, encf || 'doc', key, env)
      : await sendEcf(xml, encf || 'doc', key, env);
    const code = extractSecurityCode(xml);
    const fechaFirma = extractFechaFirma(xml);
    const qr = kind === 'rfce'
      ? buildFcQrUrl({ environment: env, rncEmisor: rncFromXml(xml), encf: encf || xmlTag(xml, 'eNCF'), montoTotal: xmlTag(xml, 'MontoTotal'), codigoSeguridad: code })
      : buildEcfQrUrl({ environment: env, rncEmisor: rncFromXml(xml), rncComprador: xmlTag(xml, 'RNCComprador') || undefined, encf: encf || xmlTag(xml, 'eNCF'), fechaEmision: xmlTag(xml, 'FechaEmision'), montoTotal: xmlTag(xml, 'MontoTotal'), fechaFirma, codigoSeguridad: code });
    res.status(result.status).set('Content-Type', 'application/json').send(
      (() => {
        try {
          const parsed = JSON.parse(result.body);
          return JSON.stringify({ ...parsed, codigoSeguridad: code, fechaFirma, qr });
        } catch {
          return result.body;
        }
      })()
    );
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * POST /emitir-consumo { ...caseFields, environment } -> DGII verdict (sync RFCE).
 * Two-step: sign the full e-CF 32 to derive codigoSeguridad, embed it in
 * the RFCE summary, then sign and submit the RFCE.
 */
app.post('/emitir-consumo', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { environment } = req.body;
    const env = requireEnvironment(environment);
    if (!env) return res.status(400).json(ENV_REQUIRED_ERROR);
    if (env === 'testecf-rejected') return res.status(400).json(TESTECF_REJECTED_ERROR);
    const data = normalize(req.body);
    const rnc = data.RNCEmisor || ADSE_RNC;
    const { key, ephemeral } = await resolveKey(rnc);
    if (ephemeral) {
      return res.status(412).json({
        error: 'No P12 configured; refusing to submit to DGII with an ephemeral cert. Set P12_PATH and P12_PASSWORD.',
      });
    }
    const signedFull = signXml(buildEcf(data, '32'), key);
    const code = extractSecurityCode(signedFull);
    const fechaFirma = extractFechaFirma(signedFull);
    const signed = signXml(buildRfce(data, code), key);
    const result = await sendRfce(signed, data.ENCF || 'doc', key, env);
    const qr = buildFcQrUrl({
      environment: env,
      rncEmisor: rnc,
      encf: data.ENCF || '',
      montoTotal: xmlTag(signedFull, 'MontoTotal') || String((data as any).MontoTotal ?? ''),
      codigoSeguridad: code,
    });
    res.status(result.status).set('Content-Type', 'application/json').send(
      (() => {
        try {
          const parsed = JSON.parse(result.body);
          return JSON.stringify({ ...parsed, codigoSeguridad: code, fechaFirma, qr });
        } catch {
          return result.body;
        }
      })()
    );
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * POST /certs { rnc, p12Base64, password }
 * Validate the P12 decrypts and is not expired BEFORE storing it.
 * Returns { ok, subject, notAfter } on success.
 */
app.post('/certs', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { rnc, p12Base64, password } = req.body;
    if (!rnc || !p12Base64 || !password) {
      return res.status(400).json({ error: 'missing required fields: rnc, p12Base64, password' });
    }
    // Parse the P12 and extract cert metadata BEFORE storing anything.
    let subject = '';
    let notAfter: Date | null = null;
    let certIdentity: string | null = null;
    try {
      const der = Buffer.from(String(p12Base64), 'base64').toString('binary');
      const km = loadP12FromDerBinary(der, String(password));
      const cert = forge.pki.certificateFromPem(km.certPem);
      const cnAttr = cert.subject.getField('CN');
      const serialAttr = cert.subject.getField('serialNumber');
      subject = (cnAttr?.value as string | undefined) ||
        cert.subject.attributes.map((a: any) => a.value).filter(Boolean).join(', ');
      notAfter = cert.validity.notAfter;
      // Identity: OID 2.5.4.5 (SERIALNUMBER) first — bypasses forge's shortName:undefined
      // quirk for that OID. Bare attribute scan is the fallback only; it is ordered
      // by OID-first to prevent a STREET value that strips to 11 digits from silently
      // taking the cédula branch and bypassing the RNC cross-check.
      const digitsOf = (v: any) => String(v || '').replace(/\D/g, '');
      const isId = (d: string) => /^\d{9}$|^\d{11}$/.test(d);
      const serialDigits = digitsOf(
        cert.subject.attributes.find((a: any) => a.type === '2.5.4.5')?.value
      );
      certIdentity = isId(serialDigits)
        ? serialDigits
        : (cert.subject.attributes.map((a: any) => digitsOf(a.value)).find(isId) ?? null);
    } catch (_ve) {
      return res.status(422).json({ error: 'invalid_p12_or_password' });
    }
    // Length-aware identity check AFTER the parse block so parse errors stay distinct.
    const normalizedRnc = String(rnc).replace(/\D/g, '');
    if (!certIdentity || (certIdentity.length !== 9 && certIdentity.length !== 11)) {
      return res.status(422).json({ error: 'cert_identity_unreadable' });
    }
    if (certIdentity.length === 9 && certIdentity !== normalizedRnc) {
      // 9-digit = company RNC: must match the target RNC exactly.
      return res.status(422).json({ error: 'cert_rnc_mismatch', certIdentity });
    }
    // 11-digit = cédula (personal-linked cert): accepted for any company RNC.
    if (notAfter && notAfter.getTime() <= Date.now()) {
      return res.status(422).json({ error: 'certificate_expired', subject, notAfter: notAfter.toISOString() });
    }
    await upsertCert(String(rnc), String(p12Base64), String(password), { subject, notAfter });
    res.json({ ok: true, subject, notAfter: notAfter ? notAfter.toISOString() : null, certIdentity });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /secuencias { rnc, ecfType, environment, desde, hasta, actual, vencimiento? }
 * Load or refresh a tenant's eNCF sequence range.
 */
app.post('/secuencias', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { rnc, ecfType, environment, desde, hasta, actual, vencimiento } = req.body;
    if (!rnc || !ecfType || desde == null || hasta == null || actual == null) {
      return res.status(400).json({ error: 'missing required fields: rnc, ecfType, desde, hasta, actual' });
    }
    const env = requireEnvironment(environment);
    if (!env) return res.status(400).json(ENV_REQUIRED_ERROR);
    if (env === 'testecf-rejected') return res.status(400).json(TESTECF_REJECTED_ERROR);
    await upsertSequence({
      rnc: String(rnc),
      ecfType: String(ecfType),
      environment: env,
      desde: Number(desde),
      hasta: Number(hasta),
      actual: Number(actual),
      vencimiento: vencimiento ? String(vencimiento) : undefined,
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /reservar-encf { rnc, ecfType, environment }
 * Atomically reserve the next eNCF in the tenant's active sequence range.
 * Returns { encf: "E31XXXXXXXXXX" }.
 */
app.post('/reservar-encf', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { rnc, ecfType, environment } = req.body;
    if (!rnc || !ecfType) {
      return res.status(400).json({ error: 'missing required fields: rnc, ecfType' });
    }
    const env = requireEnvironment(environment);
    if (!env) return res.status(400).json(ENV_REQUIRED_ERROR);
    if (env === 'testecf-rejected') return res.status(400).json(TESTECF_REJECTED_ERROR);
    const encf = await reservarEncf(String(rnc), String(ecfType), env.toLowerCase());
    res.json({ encf });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /consulta { trackId, rnc?, environment } -> DGII async verdict for a trackId. */
app.post('/consulta', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { trackId, rnc, environment } = req.body;
    if (!trackId) return res.status(400).json({ error: 'missing "trackId"' });
    const env = requireEnvironment(environment);
    if (!env) return res.status(400).json(ENV_REQUIRED_ERROR);
    if (env === 'testecf-rejected') return res.status(400).json(TESTECF_REJECTED_ERROR);
    const { key, ephemeral } = await resolveKey(rnc || ADSE_RNC);
    if (ephemeral) {
      return res.status(412).json({
        error: 'No P12 configured; refusing to submit to DGII with an ephemeral cert. Set P12_PATH and P12_PASSWORD.',
      });
    }
    const token = await authenticate(key, env);
    const result = await consultaResultado(String(trackId), token, env);
    res.status(result.status).type('application/json').send(result.body);
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Tenant lifecycle endpoints — Phase C
// ---------------------------------------------------------------------------

const VALID_RNC_RE = /^\d{9}$|^\d{11}$/;
const VALID_REGISTRY_STATUSES = new Set(['onboarding', 'active', 'offboarding', 'closed']);
const VALID_CHANNELS = new Set(['crm', 'pos', 'external_api', 'factura']);

/** POST /tenants — upsert registry row. */
app.post('/tenants', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { rnc, displayName, channel, status } = req.body;
    if (!rnc || !VALID_RNC_RE.test(String(rnc))) {
      return res.status(400).json({ error: 'rnc must be 9 or 11 digits' });
    }
    if (channel !== undefined && !VALID_CHANNELS.has(String(channel))) {
      return res.status(400).json({ error: `channel must be one of: ${[...VALID_CHANNELS].join(', ')}` });
    }
    if (status !== undefined && !VALID_REGISTRY_STATUSES.has(String(status))) {
      return res.status(400).json({ error: `status must be one of: ${[...VALID_REGISTRY_STATUSES].join(', ')}` });
    }
    const encErr = checkEncoding({ displayName: displayName != null ? String(displayName) : '' });
    if (encErr) return res.status(400).json(encErr);
    const row = await upsertTenant({
      rnc:         String(rnc),
      displayName: displayName != null ? String(displayName) : null,
      channel:     channel     != null ? String(channel)     : null,
      status:      status      != null ? String(status)      : null,
    });
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /tenants — registry list with cert state. */
app.get('/tenants', emisorAuth, async (_req: Request, res: Response) => {
  try {
    res.json(await listTenants());
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** GET /certificaciones/:rnc — full tenant + certification + events. */
app.get('/certificaciones/:rnc', emisorAuth, async (req: Request, res: Response) => {
  try {
    const result = await getTenantFull(req.params.rnc);
    if (!result) return res.status(404).json({ error: 'tenant not found' });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /certificaciones/:rnc/advance — state machine transition. */
app.post('/certificaciones/:rnc/advance', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { toState, actor, evidence, notes, regress } = req.body;
    if (!toState) return res.status(400).json({ error: 'missing required field: toState' });
    if (!actor)   return res.status(400).json({ error: 'missing required field: actor' });
    const encErr = checkEncoding({ actor: String(actor), notes: notes != null ? String(notes) : '', evidence: evidence ?? {} });
    if (encErr) return res.status(400).json(encErr);
    const result = await advanceCertification(req.params.rnc, {
      toState:  String(toState),
      actor:    String(actor),
      evidence: evidence,
      notes:    notes != null ? String(notes) : undefined,
      regress:  regress === true || regress === 'true',
    });
    if ('error' in result) {
      const { statusCode, ...body } = result;
      return res.status(statusCode).json(body);
    }
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /certificaciones/:rnc/genesis — backfill for pre-Phase-C tenants. */
app.post('/certificaciones/:rnc/genesis', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { state, actor, notes } = req.body;
    if (!state)  return res.status(400).json({ error: 'missing required field: state' });
    if (!actor)  return res.status(400).json({ error: 'missing required field: actor' });
    if (!notes)  return res.status(400).json({ error: 'missing required field: notes' });
    const encErr = checkEncoding({ actor: String(actor), notes: String(notes) });
    if (encErr) return res.status(400).json(encErr);
    const result = await genesisCertification(req.params.rnc, {
      state:  String(state),
      actor:  String(actor),
      notes:  String(notes),
    });
    if ('error' in result) {
      const { statusCode, ...body } = result;
      return res.status(statusCode).json(body);
    }
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Orchestrator routes (test-sets + test-runs) — under emisorAuth
app.use(emisorAuth, buildOrchestratorRouter());

function isRfce(data: Record<string, string>, type: string): boolean {
  return type === '32' && RFCE_ENCFS.includes(data.ENCF);
}

const PORT = parseInt(process.env.PORT || '3000', 10);
if (require.main === module) {
  runMigration()
    .then(() => {
      schedulePadronCron();
      app.listen(PORT, () => {
        console.log(`DGII e-CF engine listening on :${PORT} (env=${process.env.DGII_ENV || 'certecf'})`);
      });
    })
    .catch((e) => {
      console.error('[db] migration failed:', (e as Error).message);
      schedulePadronCron();
      app.listen(PORT, () => {
        console.log(`DGII e-CF engine listening on :${PORT} (DB unavailable)`);
      });
    });
}

export { app };
