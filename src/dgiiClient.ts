import { KeyMaterial, signXml } from './signer';

/**
 * DGII CerteCF (certification) environment endpoints. Casing is significant:
 * the ecf. host uses lowercase "certecf"; the fc. host uses "Certecf".
 */
export const ENDPOINTS = {
  semilla: 'https://ecf.dgii.gov.do/certecf/autenticacion/api/autenticacion/semilla',
  validarSemilla:
    'https://ecf.dgii.gov.do/certecf/autenticacion/api/autenticacion/validarsemilla',
  recepcionEcf: 'https://ecf.dgii.gov.do/certecf/recepcion/api/FacturasElectronicas',
  recepcionRfce: 'https://fc.dgii.gov.do/Certecf/recepcionfc/api/recepcion/ecf',
  consultaResultado: 'https://ecf.dgii.gov.do/certecf/consultaresultado/api/Consultas/Estado',
  // Paso 3 — Aprobación Comercial. Casing ("CerteCF"/"AprobacionComercial") is
  // significant per the DGII community Paso-3 thread. Synchronous JSON verdict.
  aprobacionComercial: 'https://ecf.dgii.gov.do/CerteCF/AprobacionComercial/api/AprobacionComercial',
};

/** POST an XML payload as multipart/form-data under the field name "xml". */
async function postXmlMultipart(
  url: string,
  xml: string,
  filename: string,
  token?: string
): Promise<{ status: number; body: string }> {
  const form = new FormData();
  const blob = new Blob([xml], { type: 'text/xml' });
  form.append('xml', blob, filename);

  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `bearer ${token}`;

  const res = await fetch(url, { method: 'POST', headers, body: form });
  const body = await res.text();
  return { status: res.status, body };
}

/**
 * Full auth flow: fetch the seed, sign it, post it to validarsemilla, and
 * return the bearer token.
 */
export async function authenticate(key: KeyMaterial): Promise<string> {
  const seedRes = await fetch(ENDPOINTS.semilla, { method: 'GET' });
  if (!seedRes.ok) {
    throw new Error(`semilla request failed: HTTP ${seedRes.status}`);
  }
  const seedXml = await seedRes.text();
  const signedSeed = signXml(seedXml, key);

  const { status, body } = await postXmlMultipart(
    ENDPOINTS.validarSemilla,
    signedSeed,
    'seed_signed.xml'
  );
  if (status < 200 || status >= 300) {
    throw new Error(`validarsemilla failed: HTTP ${status} ${body}`);
  }
  const parsed = JSON.parse(body);
  const token = parsed.token || parsed.Token;
  if (!token) throw new Error(`No token in validarsemilla response: ${body}`);
  return token;
}

/**
 * DGII requires the upload filename to be `{RNCEmisor}{eNCF}.xml` (error 3243
 * "La longitud del nombre del archivo no es válida" otherwise). Derive the RNC
 * from the document itself so the name is always correct regardless of caller.
 */
function dgiiFilename(signedXml: string, encf: string): string {
  const m = signedXml.match(/<RNCEmisor>\s*([0-9]+)\s*<\/RNCEmisor>/);
  const rnc = m ? m[1] : '';
  return `${rnc}${encf}.xml`;
}

/** Submit a signed e-CF document to the ecf host. */
export async function sendEcf(signedXml: string, encf: string, key: KeyMaterial) {
  const token = await authenticate(key);
  return postXmlMultipart(ENDPOINTS.recepcionEcf, signedXml, dgiiFilename(signedXml, encf), token);
}

/** Submit a signed RFCE summary to the fc host. */
export async function sendRfce(signedXml: string, encf: string, key: KeyMaterial) {
  const token = await authenticate(key);
  return postXmlMultipart(ENDPOINTS.recepcionRfce, signedXml, dgiiFilename(signedXml, encf), token);
}

/**
 * Submit a signed ACECF (Aprobación Comercial, Paso 3) to the certecf host.
 * Like RFCE this is SYNCHRONOUS: the response carries the verdict JSON
 * ({codigo, estado, mensajes, encf}) directly — no trackId polling.
 */
export async function sendAprobacion(signedXml: string, encf: string, key: KeyMaterial) {
  const token = await authenticate(key);
  return postXmlMultipart(
    ENDPOINTS.aprobacionComercial,
    signedXml,
    dgiiFilename(signedXml, encf),
    token
  );
}

/**
 * Query the async verdict for an e-CF reception trackId. e-CF reception is
 * asynchronous: FacturasElectronicas returns a trackId, and the final
 * Aceptado/Rechazado verdict is fetched here.
 */
export async function consultaResultado(trackId: string, token: string) {
  const url = `${ENDPOINTS.consultaResultado}?trackId=${encodeURIComponent(trackId)}`;
  const res = await fetch(url, { headers: { Authorization: `bearer ${token}` } });
  return { status: res.status, body: await res.text() };
}
