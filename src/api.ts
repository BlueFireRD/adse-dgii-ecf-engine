import express, { Request, Response } from 'express';
import { buildEcf } from './xmlBuilder';
import { buildRfce } from './rfceBuilder';
import { buildAcecf, AcecfCase } from './acecfBuilder';
import { normalize, getAcecfCase } from './dataset';
import { schemaPathForEcf, schemaPathForRfce, schemaPathForAcecf, validateXml } from './validator';
import { keyFromEnv, generateEphemeralKey, signXml, KeyMaterial } from './signer';
import { sendEcf, sendRfce, sendAprobacion } from './dgiiClient';
import { RFCE_ENCFS } from './types';
import { receptorRouter } from './receptor';

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '10mb' }));

// RECEPTOR web services (fe/...). Multipart routes handle their own body
// parsing (multer), so they coexist with the JSON/text parsers above.
app.use(receptorRouter);

/** Lazily resolve signing key material (real P12 or ephemeral fallback). */
function getKey(): { key: KeyMaterial; ephemeral: boolean } {
  const envKey = keyFromEnv();
  if (envKey) return { key: envKey, ephemeral: false };
  return { key: generateEphemeralKey(), ephemeral: true };
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, env: process.env.DGII_ENV || 'certecf' });
});

/** POST /generate { type, case } -> unsigned XML. */
app.post('/generate', (req: Request, res: Response) => {
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

/** POST /sign { xml } | { type, case } -> signed XML. */
app.post('/sign', (req: Request, res: Response) => {
  try {
    let xml: string | undefined = typeof req.body === 'string' ? req.body : req.body.xml;
    if (!xml && req.body.case) {
      const data = normalize(req.body.case);
      const t = String(req.body.type || data.TipoeCF);
      xml = isRfce(data, t) ? buildRfce(data) : buildEcf(data, t);
    }
    if (!xml) return res.status(400).json({ error: 'missing "xml" or "case"' });
    const { key } = getKey();
    res.type('application/xml').send(signXml(xml, key));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /validate { xml, type } -> { valid, errors }. type "rfce" or e-CF type. */
app.post('/validate', (req: Request, res: Response) => {
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

/**
 * Resolve an AcecfCase from a request body: either a full case object, or
 * { encf } to derive the smoke-test candidate from the e-CF dataset.
 */
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
app.post('/aprobacion', (req: Request, res: Response) => {
  try {
    const resolved = resolveAcecfCase(req.body);
    if ('error' in resolved) return res.status(400).json({ error: resolved.error });
    const signed = signXml(buildAcecf(resolved), getKey().key);
    if (req.body && req.body.validate) {
      const result = validateXml(signed, schemaPathForAcecf(), resolved.eNCF);
      if (!result.valid) return res.status(422).json(result);
    }
    res.type('application/xml').send(signed);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /submit-aprobacion { ...AcecfCase | encf } -> DGII verdict (sync). */
app.post('/submit-aprobacion', async (req: Request, res: Response) => {
  try {
    const resolved = resolveAcecfCase(req.body);
    if ('error' in resolved) return res.status(400).json({ error: resolved.error });
    const { key, ephemeral } = getKey();
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

/** POST /submit { xml, kind } -> DGII response verbatim. */
app.post('/submit', async (req: Request, res: Response) => {
  try {
    const { xml, kind, encf } = req.body;
    if (!xml || !kind) return res.status(400).json({ error: 'missing "xml" or "kind"' });
    const { key, ephemeral } = getKey();
    if (ephemeral) {
      return res.status(412).json({
        error: 'No P12 configured; refusing to submit to DGII with an ephemeral cert. Set P12_PATH and P12_PASSWORD.',
      });
    }
    const result =
      kind === 'rfce'
        ? await sendRfce(xml, encf || 'doc', key)
        : await sendEcf(xml, encf || 'doc', key);
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
  app.listen(PORT, () => {
    console.log(`DGII e-CF engine listening on :${PORT} (env=${process.env.DGII_ENV || 'certecf'})`);
  });
}

export { app };
