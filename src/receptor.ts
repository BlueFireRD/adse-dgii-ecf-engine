import express, { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { DOMParser } from '@xmldom/xmldom';
import { keyFromEnv, generateEphemeralKey, signXml, verifyXml, KeyMaterial } from './signer';
import {
  schemaPathForEcf,
  schemaPathForRfce,
  schemaPathForAcecf,
  validateXml,
} from './validator';
import { buildArecf, ArecfInput } from './arecfBuilder';

/** ADSE's RNC: every e-CF the DGII sends us in certification must be addressed here. */
const ADSE_RNC = '133470616';

/** JWT signing secret. Real secret via env; the default is for local dev only. */
const JWT_SECRET = process.env.RECEPTOR_JWT_SECRET || 'dev-receptor-secret-change-me';
const JWT_TTL_SECONDS = 60 * 60; // 1h
const SEED_TTL_MS = 5 * 60 * 1000; // 5min

// --- In-memory state -------------------------------------------------------
// Fine for DGII certification. In the CRM these would live in a database
// (seeds table with expiry, and a per-receptor ledger of acknowledged eNCF).
const issuedSeeds = new Map<string, number>(); // valor -> expiry epoch ms
const receivedEncf = new Set<string>(); // eNCF already acknowledged this session

function rememberSeed(valor: string): void {
  issuedSeeds.set(valor, Date.now() + SEED_TTL_MS);
}

/** True if the seed value was issued by us and has not expired (consumes it). */
function consumeSeed(valor: string): boolean {
  const exp = issuedSeeds.get(valor);
  if (exp === undefined) return false;
  issuedSeeds.delete(valor);
  return exp >= Date.now();
}

/** Lazily resolve signing key material (real P12 or ephemeral fallback). */
function getKey(): { key: KeyMaterial; ephemeral: boolean } {
  const envKey = keyFromEnv();
  if (envKey) return { key: envKey, ephemeral: false };
  return { key: generateEphemeralKey(), ephemeral: true };
}

/** First text content of the named element, or '' if absent. */
function tag(doc: Document, name: string): string {
  const els = doc.getElementsByTagName(name);
  if (!els || els.length === 0) return '';
  return (els[0].textContent || '').trim();
}

const upload = multer({ storage: multer.memoryStorage() });

/** Read the multipart `xml` field as a UTF-8 string, or undefined. */
function xmlFromMultipart(req: Request): string | undefined {
  const f = (req as any).file as Express.Multer.File | undefined;
  if (f && f.buffer) return f.buffer.toString('utf8');
  // Some clients send `xml` as a plain text field rather than a file part.
  const body = (req as any).body;
  if (body && typeof body.xml === 'string' && body.xml.length) return body.xml;
  return undefined;
}

/** Express middleware: require a valid Bearer JWT signed with our secret. */
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

// 1. GET /fe/autenticacion/api/semilla -> seed XML.
receptorRouter.get('/fe/autenticacion/api/semilla', (_req: Request, res: Response) => {
  const valor = randomUUID();
  const fecha = new Date().toISOString();
  rememberSeed(valor);
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<SemillaModel><valor>${valor}</valor><fecha>${fecha}</fecha></SemillaModel>`;
  res.type('application/xml').send(xml);
});

// 2. POST /fe/autenticacion/api/validacioncertificado (multipart `xml` = signed seed).
receptorRouter.post(
  '/fe/autenticacion/api/validacioncertificado',
  upload.single('xml'),
  (req: Request, res: Response) => {
    const xml = xmlFromMultipart(req);
    if (!xml) return res.status(400).json({ error: 'missing "xml" form field' });

    // (a) verify the XMLDSig signature against the certificate embedded in the doc.
    let signatureOk = false;
    try {
      signatureOk = verifyXml(xml);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) return res.status(401).json({ error: 'invalid seed signature' });

    // (b) the seed value must have been issued by us and not expired.
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
    } catch {
      return res.status(400).json({ error: 'malformed XML' });
    }
    const valor = tag(doc, 'valor');
    if (!valor || !consumeSeed(valor)) {
      return res.status(401).json({ error: 'unknown or expired seed' });
    }

    // Issue our own JWT. RNC identifies the receptor (ADSE).
    const nowSec = Math.floor(Date.now() / 1000);
    const exp = nowSec + JWT_TTL_SECONDS;
    const token = jwt.sign({ rnc: ADSE_RNC, iat: nowSec, exp }, JWT_SECRET);
    res.json({ token, expira: new Date(exp * 1000).toISOString() });
  }
);

/**
 * Shared recepción handler: parse the incoming e-CF, validate structure + firma,
 * compute the ARECF Estado/Motivo, then sign and return the ARECF synchronously.
 * `schemaFor` resolves the XSD from the parsed TipoeCF (e-CF vs RFCE).
 */
function handleRecepcion(
  req: Request,
  res: Response,
  schemaFor: (tipo: string) => string
): void {
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

  const tipo = tag(doc, 'TipoeCF');
  const encf = tag(doc, 'eNCF');
  const rncEmisor = tag(doc, 'RNCEmisor');
  const rncComprador = tag(doc, 'RNCComprador');

  // Determine Estado / CodigoMotivoNoRecibido. Order of checks mirrors the
  // motivo codes: 1 XSD, 2 firma, 3 duplicado, 4 RNCComprador.
  let estado: 0 | 1 = 0;
  let motivo: 1 | 2 | 3 | 4 | undefined;

  const schemaPath = schemaFor(tipo);
  const validation = validateXml(xml, schemaPath, encf);
  if (!validation.valid) {
    estado = 1;
    motivo = 1; // Error de especificación
  } else {
    let signatureOk = false;
    try {
      signatureOk = verifyXml(xml);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) {
      estado = 1;
      motivo = 2; // Error de Firma Digital
    } else if (encf && receivedEncf.has(encf)) {
      estado = 1;
      motivo = 3; // Envío duplicado
    } else if (rncComprador !== ADSE_RNC) {
      estado = 1;
      motivo = 4; // RNC Comprador no corresponde
    } else {
      estado = 0;
      if (encf) receivedEncf.add(encf);
    }
  }

  const input: ArecfInput = {
    rncEmisor: rncEmisor || ADSE_RNC,
    rncComprador: ADSE_RNC,
    encf: encf,
    estado,
    motivo,
  };
  const arecf = buildArecf(input);
  const signed = signXml(arecf, getKey().key);
  // The acuse is ALWAYS HTTP 200 with the signed ARECF; the "no recibido"
  // verdict travels inside the XML, never as an HTTP error.
  res.status(200).type('application/xml').send(signed);
}

// 3. POST /fe/Recepcion/api/ecf (Bearer; multipart `xml` = signed e-CF) -> signed ARECF.
receptorRouter.post(
  '/fe/Recepcion/api/ecf',
  requireBearer,
  upload.single('xml'),
  (req: Request, res: Response) => {
    handleRecepcion(req, res, (tipo) => schemaPathForEcf(tipo));
  }
);

// 4. POST /fe/AprobacionComercial/api/ecf (Bearer; multipart `xml` = signed ACECF) -> JSON.
receptorRouter.post(
  '/fe/AprobacionComercial/api/ecf',
  requireBearer,
  upload.single('xml'),
  (req: Request, res: Response) => {
    const xml = xmlFromMultipart(req);
    if (!xml) return res.status(400).json({ error: 'missing "xml" form field' });

    const encf = (() => {
      try {
        const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
        return tag(doc, 'eNCF');
      } catch {
        return '';
      }
    })();

    const validation = validateXml(xml, schemaPathForAcecf(), encf);
    if (!validation.valid) {
      return res.status(400).json({
        codigo: 'Error',
        estado: 'Error de especificación',
        mensaje: validation.errors,
      });
    }
    let signatureOk = false;
    try {
      signatureOk = verifyXml(xml);
    } catch {
      signatureOk = false;
    }
    if (!signatureOk) {
      return res.status(400).json({
        codigo: 'Error',
        estado: 'Error de Firma Digital',
        mensaje: ['La firma digital del ACECF no es válida'],
      });
    }
    res.status(200).json({
      codigo: 'OK',
      estado: 'Aprobacion Comercial Aceptada',
      mensaje: [],
    });
  }
);

// 5. (Optional) POST /fe/recepcionfc/api/ecf for RFCE (<250k consumo) -> signed ARECF.
receptorRouter.post(
  '/fe/recepcionfc/api/ecf',
  requireBearer,
  upload.single('xml'),
  (req: Request, res: Response) => {
    handleRecepcion(req, res, () => schemaPathForRfce());
  }
);
