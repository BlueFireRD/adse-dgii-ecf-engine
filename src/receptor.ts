import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { DOMParser } from '@xmldom/xmldom';
import {
  generateEphemeralKey,
  signXml,
  verifyXml,
  extractSignerIdentity,
  KeyMaterial,
} from './signer';
import {
  schemaPathForEcf,
  schemaPathForRfce,
  schemaPathForAcecf,
  validateXml,
} from './validator';
import { buildArecf, ArecfInput } from './arecfBuilder';
import { getPool } from './db';
import { keyForRnc } from './certStore';

const JWT_SECRET     = process.env.RECEPTOR_JWT_SECRET || 'dev-receptor-secret-change-me';
const JWT_TTL_SECONDS = 60 * 60;   // 1h
const SEED_TTL_MS    = 5 * 60 * 1000; // 5min
const CACHE_TTL_MS   = 60_000;        // 60s eligibility cache

// ---------------------------------------------------------------------------
// R1 — Receptor-eligible set (active registry + certified-or-later cert state)
// Cached ≤60s; refreshed lazily on next request.
// ---------------------------------------------------------------------------
const ELIGIBLE_CERT_STATES = new Set([
  'certified', 'production_setup', 'first_production_aceptado', 'live',
]);

let _eligibleCache: Set<string> | null = null;
let _eligibleCacheExpiry = 0;

async function isReceptorEligible(rnc: string): Promise<boolean> {
  const now = Date.now();
  if (_eligibleCache === null || now > _eligibleCacheExpiry) {
    const db = getPool();
    const { rows } = await db.query<{ rnc: string }>(
      `SELECT r.rnc
       FROM tenant_registry r
       JOIN tenant_certifications c ON c.rnc = r.rnc
       WHERE r.status = 'active'
         AND c.state IN ('certified','production_setup','first_production_aceptado','live')`
    );
    _eligibleCache = new Set(rows.map(r => r.rnc));
    _eligibleCacheExpiry = now + CACHE_TTL_MS;
  }
  return _eligibleCache!.has(rnc);
}

// ---------------------------------------------------------------------------
// R2 — Seed persistence (DB-backed; survive redeploys)
// ---------------------------------------------------------------------------
async function rememberSeed(valor: string): Promise<void> {
  const db = getPool();
  const expiresAt = new Date(Date.now() + SEED_TTL_MS);
  await db.query(
    `INSERT INTO receptor_seeds (valor, expires_at)
     VALUES ($1, $2)
     ON CONFLICT (valor) DO NOTHING`,
    [valor, expiresAt]
  );
}

/** Atomic consume: deletes the row and returns true iff it existed and wasn't expired. */
async function consumeSeed(valor: string): Promise<boolean> {
  const db = getPool();
  // Opportunistic purge of stale rows (best-effort; do not await)
  db.query(`DELETE FROM receptor_seeds WHERE expires_at < now()`).catch(() => {});
  const { rowCount } = await db.query(
    `DELETE FROM receptor_seeds WHERE valor = $1 AND expires_at >= now()`,
    [valor]
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// R2 — Received-eNCF dedup ledger (per tenant)
// ---------------------------------------------------------------------------
async function hasReceivedEncf(rncComprador: string, encf: string): Promise<boolean> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT 1 FROM receptor_received_encf WHERE rnc_comprador = $1 AND encf = $2`,
    [rncComprador, encf]
  );
  return rows.length > 0;
}

async function recordReceivedEncf(rncComprador: string, encf: string): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO receptor_received_encf (rnc_comprador, encf)
     VALUES ($1, $2)
     ON CONFLICT (rnc_comprador, encf) DO NOTHING`,
    [rncComprador, encf]
  );
}

// ---------------------------------------------------------------------------
// R3 — Document store + forwarding
// ---------------------------------------------------------------------------
async function storeDocument(opts: {
  kind: 'recepcion' | 'aprobacion_comercial' | 'recepcion_fc';
  rncComprador?: string;
  rncEmisor?: string;
  encf?: string;
  tipo?: string;
  verdict: string;
  xml: string;
  responseXml?: string;
}): Promise<string> {
  const db = getPool();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO receptor_documents
       (kind, rnc_comprador, rnc_emisor, encf, tipo, verdict, xml, response_xml)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      opts.kind,
      opts.rncComprador || null,
      opts.rncEmisor   || null,
      opts.encf        || null,
      opts.tipo        || null,
      opts.verdict,
      opts.xml,
      opts.responseXml || null,
    ]
  );
  return rows[0].id;
}

/**
 * Resolve the tenant's channel, then POST to the matching ingest URL.
 * One retry on any failure; records forward_error on second failure.
 * If the env URL is unset, silently leaves forwarded_at NULL.
 * Never throws — all errors are logged.
 */
async function forwardDocument(
  docId: string,
  rncComprador: string,
  xml: string,
  kind: string,
  verdict: string
): Promise<void> {
  const db = getPool();
  try {
    const { rows } = await db.query<{ channel: string }>(
      `SELECT channel FROM tenant_registry WHERE rnc = $1`,
      [rncComprador]
    );
    const channel  = rows[0]?.channel;
    const ingestUrl =
      channel === 'crm' ? process.env.CRM_RECIBIDOS_INGEST_URL :
      channel === 'pos' ? process.env.POS_RECIBIDOS_INGEST_URL :
      null;
    if (!ingestUrl) return; // store-only until C3 ingest is deployed

    const padronKey = process.env.PADRON_API_KEY || '';
    const body = JSON.stringify({ kind, rncComprador, verdict, xml });
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fwdRes = await fetch(ingestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-padron-key': padronKey },
          body,
        });
        if (fwdRes.ok) {
          await db.query(
            `UPDATE receptor_documents SET forwarded_at = now() WHERE id = $1`,
            [docId]
          );
          return;
        }
        lastError = `HTTP ${fwdRes.status}`;
      } catch (e: any) {
        lastError = e.message;
      }
    }

    if (lastError) {
      await db.query(
        `UPDATE receptor_documents SET forward_error = $1 WHERE id = $2`,
        [lastError.slice(0, 500), docId]
      );
    }
  } catch (e: any) {
    console.error(`[receptor] forward error docId=${docId}:`, e.message);
  }
}

// ---------------------------------------------------------------------------
// Per-tenant ARECF signing key resolver
// Delegates to the existing per-RNC cert store (DB row → env cert → ephemeral).
// ---------------------------------------------------------------------------
async function resolveReceptorKey(rncComprador: string): Promise<KeyMaterial> {
  try {
    const key = await keyForRnc(rncComprador);
    if (key) return key;
  } catch (e: any) {
    console.warn('[receptor] key lookup failed, using ephemeral:', e.message);
  }
  return generateEphemeralKey();
}

// ---------------------------------------------------------------------------
// XML helpers (unchanged)
// ---------------------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage() });

function xmlFromMultipart(req: Request): string | undefined {
  const f = (req as any).file as Express.Multer.File | undefined;
  if (f && f.buffer) return f.buffer.toString('utf8');
  const body = (req as any).body;
  if (body && typeof body.xml === 'string' && body.xml.length) return body.xml;
  return undefined;
}

function tag(doc: Document, name: string): string {
  const els = doc.getElementsByTagName(name);
  if (!els || els.length === 0) return '';
  return (els[0].textContent || '').trim();
}

// ---------------------------------------------------------------------------
// Auth middleware (requireBearer — unchanged)
// ---------------------------------------------------------------------------
function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.status(401).json({ error: 'missing or malformed Authorization Bearer token' });
    return;
  }
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    (req as any).jwt = payload;
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

export const receptorRouter = express.Router();

// ---------------------------------------------------------------------------
// 1. GET /fe/autenticacion/api/semilla → seed XML
// ---------------------------------------------------------------------------
receptorRouter.get('/fe/autenticacion/api/semilla', async (_req: Request, res: Response) => {
  try {
    const valor = randomUUID();
    const fecha = new Date().toISOString();
    await rememberSeed(valor);
    console.log(`[auth] semilla emitida valor=${valor}`);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<SemillaModel><valor>${valor}</valor><fecha>${fecha}</fecha></SemillaModel>`;
    res.type('application/xml').send(xml);
  } catch (e: any) {
    console.error('[auth] semilla error:', e.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ---------------------------------------------------------------------------
// 2. POST /fe/autenticacion/api/validacioncertificado
//    (multipart `xml` = signed seed) → JWT
// ---------------------------------------------------------------------------
receptorRouter.post(
  '/fe/autenticacion/api/validacioncertificado',
  upload.single('xml'),
  async (req: Request, res: Response) => {
    try {
      const xml = xmlFromMultipart(req);
      if (!xml) return res.status(400).json({ error: 'missing "xml" form field' });

      let signatureOk = false;
      try {
        signatureOk = verifyXml(xml);
      } catch (e: any) {
        console.error(`[auth] verifyXml exception: ${e?.message || e}`);
      }
      if (!signatureOk) {
        console.error('[auth] 401 firma de semilla invalida');
        return res.status(401).json({ error: 'invalid seed signature' });
      }

      let doc: Document;
      try {
        doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
      } catch {
        return res.status(400).json({ error: 'malformed XML' });
      }

      const valor = tag(doc, 'valor');
      const consumed = await consumeSeed(valor);
      if (!valor || !consumed) {
        console.error(`[auth] 401 semilla desconocida/expirada valor=${valor}`);
        return res.status(401).json({ error: 'unknown or expired seed' });
      }

      // Extract the signer's RNC from the certificate on the signed seed.
      // Embedded in the token as rncEmisor for audit; routing uses RNCComprador.
      const rncEmisor = extractSignerIdentity(xml);
      const nowSec = Math.floor(Date.now() / 1000);
      const exp    = nowSec + JWT_TTL_SECONDS;
      const token  = jwt.sign({ rncEmisor, iat: nowSec, exp }, JWT_SECRET);
      console.log(`[auth] token emitido OK rncEmisor=${rncEmisor}`);
      res.json({ token, expira: new Date(exp * 1000).toISOString() });
    } catch (e: any) {
      console.error('[auth] validacion error:', e.message);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// Shared recepción handler (R1 eligibility, R2 dedup, R3 store+forward)
// Protocol invariant: ALWAYS HTTP 200 + signed ARECF; verdict is inside the XML.
// ---------------------------------------------------------------------------
async function handleRecepcion(
  req: Request,
  res: Response,
  schemaFor: (tipo: string) => string,
  kind: 'recepcion' | 'recepcion_fc'
): Promise<void> {
  const xml = xmlFromMultipart(req);
  if (!xml) {
    res.status(400).json({ error: 'missing "xml" form field' });
    return;
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  } catch {
    res.status(400).json({ error: 'malformed XML' });
    return;
  }

  const tipo         = tag(doc, 'TipoeCF');
  const encf         = tag(doc, 'eNCF');
  const rncEmisor    = tag(doc, 'RNCEmisor');
  const rncComprador = tag(doc, 'RNCComprador');

  // Motivo checks in protocol order: 1 schema · 2 firma · 3 duplicado · 4 RNC
  let estado: 0 | 1  = 0;
  let motivo: 1 | 2 | 3 | 4 | undefined;

  const validation = validateXml(xml, schemaFor(tipo), encf);
  if (!validation.valid) {
    estado = 1; motivo = 1;
  } else {
    let signatureOk = false;
    try { signatureOk = verifyXml(xml); } catch { signatureOk = false; }

    if (!signatureOk) {
      estado = 1; motivo = 2;
    } else {
      let isDuplicate = false;
      if (encf && rncComprador) {
        try { isDuplicate = await hasReceivedEncf(rncComprador, encf); }
        catch (e: any) { console.warn('[receptor] dedup check failed:', e.message); }
      }

      if (isDuplicate) {
        estado = 1; motivo = 3;
      } else {
        let eligible = false;
        if (rncComprador) {
          try { eligible = await isReceptorEligible(rncComprador); }
          catch (e: any) { console.error('[receptor] eligibility check failed:', e.message); }
        }

        if (!eligible) {
          estado = 1; motivo = 4;
        } else {
          estado = 0;
          if (encf && rncComprador) {
            try { await recordReceivedEncf(rncComprador, encf); }
            catch (e: any) { console.warn('[receptor] failed to record encf:', e.message); }
          }
        }
      }
    }
  }

  const verdict = estado === 0 ? 'aceptado' : `rechazado_${motivo}`;

  // Sign ARECF with the receptor tenant's cert (→ their DB cert or env cert fallback)
  const signingKey = await resolveReceptorKey(rncComprador);
  const arecfInput: ArecfInput = {
    rncEmisor:    rncEmisor || rncComprador || '',
    rncComprador: rncComprador || '',
    encf,
    estado,
    motivo,
  };
  const signed = signXml(buildArecf(arecfInput), signingKey);

  // Persist every hit (accepted + rejected) before responding
  let docId: string | null = null;
  try {
    docId = await storeDocument({ kind, rncComprador, rncEmisor, encf, tipo, verdict, xml, responseXml: signed });
  } catch (e: any) {
    console.error('[receptor] store failed:', e.message);
  }

  // Protocol: always HTTP 200; verdict travels inside the ARECF XML
  res.status(200).type('application/xml').send(signed);

  // Forward accepted documents fire-and-forget after response is sent
  if (estado === 0 && docId && rncComprador) {
    forwardDocument(docId, rncComprador, xml, kind, verdict).catch(e =>
      console.error('[receptor] forward failed:', e.message)
    );
  }
}

// ---------------------------------------------------------------------------
// 3. POST /fe/Recepcion/api/ecf (Bearer; multipart `xml` = signed e-CF) → ARECF
// ---------------------------------------------------------------------------
receptorRouter.post(
  '/fe/Recepcion/api/ecf',
  requireBearer,
  upload.single('xml'),
  async (req: Request, res: Response) => {
    try {
      await handleRecepcion(req, res, (tipo) => schemaPathForEcf(tipo), 'recepcion');
    } catch (e: any) {
      console.error('[receptor] unhandled error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// 4. POST /fe/AprobacionComercial/api/ecf (Bearer; multipart `xml` = ACECF) → JSON
// ---------------------------------------------------------------------------
receptorRouter.post(
  '/fe/AprobacionComercial/api/ecf',
  requireBearer,
  upload.single('xml'),
  async (req: Request, res: Response) => {
    try {
      const xml = xmlFromMultipart(req);
      if (!xml) return res.status(400).json({ error: 'missing "xml" form field' });

      let encf = ''; let rncComprador = ''; let rncEmisor = '';
      try {
        const d = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
        encf         = tag(d, 'eNCF');
        rncComprador = tag(d, 'RNCComprador');
        rncEmisor    = tag(d, 'RNCEmisor');
      } catch { /* non-fatal; validation below will catch malformed XML */ }

      const validation = validateXml(xml, schemaPathForAcecf(), encf);
      if (!validation.valid) {
        try { await storeDocument({ kind: 'aprobacion_comercial', rncComprador, rncEmisor, encf, verdict: 'rechazado_especificacion', xml }); }
        catch (e: any) { console.error('[receptor] store failed:', e.message); }
        return res.status(400).json({ codigo: 'Error', estado: 'Error de especificación', mensaje: validation.errors });
      }

      let signatureOk = false;
      try { signatureOk = verifyXml(xml); } catch { signatureOk = false; }
      if (!signatureOk) {
        try { await storeDocument({ kind: 'aprobacion_comercial', rncComprador, rncEmisor, encf, verdict: 'rechazado_firma', xml }); }
        catch (e: any) { console.error('[receptor] store failed:', e.message); }
        return res.status(400).json({ codigo: 'Error', estado: 'Error de Firma Digital', mensaje: ['La firma digital del ACECF no es válida'] });
      }

      let docId: string | null = null;
      try { docId = await storeDocument({ kind: 'aprobacion_comercial', rncComprador, rncEmisor, encf, verdict: 'aceptado', xml }); }
      catch (e: any) { console.error('[receptor] store failed:', e.message); }

      res.status(200).json({ codigo: 'OK', estado: 'Aprobacion Comercial Aceptada', mensaje: [] });

      if (docId && rncComprador) {
        forwardDocument(docId, rncComprador, xml, 'aprobacion_comercial', 'aceptado').catch(e =>
          console.error('[receptor] forward failed:', e.message)
        );
      }
    } catch (e: any) {
      console.error('[receptor] aprobacion error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
    }
  }
);

// ---------------------------------------------------------------------------
// 5. POST /fe/recepcionfc/api/ecf (Bearer; multipart `xml` = RFCE) → ARECF
// ---------------------------------------------------------------------------
receptorRouter.post(
  '/fe/recepcionfc/api/ecf',
  requireBearer,
  upload.single('xml'),
  async (req: Request, res: Response) => {
    try {
      await handleRecepcion(req, res, () => schemaPathForRfce(), 'recepcion_fc');
    } catch (e: any) {
      console.error('[receptor] unhandled error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
    }
  }
);
