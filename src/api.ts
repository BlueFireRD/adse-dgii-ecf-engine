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
import { receptorRouter } from './receptor';

const ADSE_RNC = '133470616';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '10mb' }));

// RECEPTOR web services (fe/...). Mounted before the emisor API-key guard so
// the DGII can call us without an emisor key.
app.use(receptorRouter);

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

/** POST /submit { xml, kind, encf, environment? } -> DGII response verbatim. */
app.post('/submit', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { xml, kind, encf, environment } = req.body;
    if (!xml || !kind) return res.status(400).json({ error: 'missing "xml" or "kind"' });
    const rnc = rncFromXml(xml);
    const { key, ephemeral } = await resolveKey(rnc);
    if (ephemeral) {
      return res.status(412).json({
        error: 'No P12 configured; refusing to submit to DGII with an ephemeral cert. Set P12_PATH and P12_PASSWORD.',
      });
    }
    const env = environment ? String(environment) : undefined;
    const result = kind === 'rfce'
      ? await sendRfce(xml, encf || 'doc', key, env)
      : await sendEcf(xml, encf || 'doc', key, env);
    res.status(result.status).type('application/json').send(result.body);
  } catch (e: any) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * POST /emitir-consumo { ...caseFields, environment? } -> DGII verdict (sync RFCE).
 * Two-step: sign the full e-CF 32 to derive codigoSeguridad, embed it in
 * the RFCE summary, then sign and submit the RFCE.
 */
app.post('/emitir-consumo', emisorAuth, async (req: Request, res: Response) => {
  try {
    const data = normalize(req.body);
    const rnc = data.RNCEmisor || ADSE_RNC;
    const env = req.body.environment ? String(req.body.environment) : undefined;
    const { key, ephemeral } = await resolveKey(rnc);
    if (ephemeral) {
      return res.status(412).json({
        error: 'No P12 configured; refusing to submit to DGII with an ephemeral cert. Set P12_PATH and P12_PASSWORD.',
      });
    }
    const signedFull = signXml(buildEcf(data, '32'), key);
    const code = extractSecurityCode(signedFull);
    const signed = signXml(buildRfce(data, code), key);
    const result = await sendRfce(signed, data.ENCF || 'doc', key, env);
    res.status(result.status).set('Content-Type', 'application/json').send(
      (() => {
        try {
          const parsed = JSON.parse(result.body);
          return JSON.stringify({ ...parsed, codigoSeguridad: code });
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
    // Validate the P12 opens with this password BEFORE storing anything.
    let subject = '';
    let notAfter: Date | null = null;
    try {
      const der = Buffer.from(String(p12Base64), 'base64').toString('binary');
      const km = loadP12FromDerBinary(der, String(password));
      const cert = forge.pki.certificateFromPem(km.certPem);
      const cn = cert.subject.getField('CN');
      subject = (cn && cn.value) || cert.subject.attributes.map((a: any) => a.value).filter(Boolean).join(', ');
      notAfter = cert.validity.notAfter;
    } catch (_ve) {
      return res.status(422).json({ error: 'invalid_p12_or_password' });
    }
    if (notAfter && notAfter.getTime() <= Date.now()) {
      return res.status(422).json({ error: 'certificate_expired', subject, notAfter: notAfter.toISOString() });
    }
    await upsertCert(String(rnc), String(p12Base64), String(password));
    res.json({ ok: true, subject, notAfter: notAfter ? notAfter.toISOString() : null });
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
    await upsertSequence({
      rnc: String(rnc),
      ecfType: String(ecfType),
      environment: String(environment || 'certecf'),
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
    const encf = await reservarEncf(String(rnc), String(ecfType), String(environment || 'certecf'));
    res.json({ encf });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /consulta { trackId, rnc?, environment? } -> DGII async verdict for a trackId. */
app.post('/consulta', emisorAuth, async (req: Request, res: Response) => {
  try {
    const { trackId, rnc, environment } = req.body;
    if (!trackId) return res.status(400).json({ error: 'missing "trackId"' });
    const env = environment ? String(environment) : undefined;
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

function isRfce(data: Record<string, string>, type: string): boolean {
  return type === '32' && RFCE_ENCFS.includes(data.ENCF);
}

const PORT = parseInt(process.env.PORT || '3000', 10);
if (require.main === module) {
  runMigration()
    .then(() =>
      app.listen(PORT, () => {
        console.log(`DGII e-CF engine listening on :${PORT} (env=${process.env.DGII_ENV || 'certecf'})`);
      })
    )
    .catch((e) => {
      console.error('[db] migration failed:', (e as Error).message);
      app.listen(PORT, () => {
        console.log(`DGII e-CF engine listening on :${PORT} (DB unavailable)`);
      });
    });
}

export { app };
