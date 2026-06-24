# Despliegue del Motor Receptor — `ecf.adse-rd.com` (Paso 7 DGII)

Guía para poner el motor 24/7 con HTTPS, manejo seguro del certificado, y registrar las URLs en el Paso 7.

---

## 0. Arquitectura (resumen)

```
DGII  ──HTTPS──►  https://ecf.adse-rd.com   (este motor Node, contenedor 24/7 + TLS)
                        │
                        └──HTTP interno──►  CRM/POS en Lovable (adse.app)
```

- El motor receptor vive en su **propio servicio** (no dentro de Lovable/Supabase, porque necesita proceso persistente, firma XMLDSig con Node y manejo del .p12).
- Subdominio elegido: **`ecf.adse-rd.com`** (un registro DNS en tu dominio de Wix apuntando al servicio; no afecta tu sitio web).

---

## 1. Hosting recomendado: Railway (lo más simple de configurar y mantener)

Por qué Railway para empezar:
- Despliegas el `Dockerfile` que ya está en el repo — sin administrar servidor, parches ni TLS manual.
- **TLS/HTTPS automático** en el dominio que te da y en tu dominio propio.
- Variables/secretos integrados (ahí va el certificado y el password).
- Reinicia solo, healthcheck incluido, logs en vivo. Costo bajo (plan de uso medido).

> Alternativas equivalentes: **Render** o **Fly.io** (mismos pasos conceptuales: deploy por Docker + variables secretas + dominio propio). Si prefieres control total, un VPS con Docker + Caddy también sirve (ver §6).

### Pasos en Railway
1. Crea cuenta en railway.app y un proyecto nuevo → **Deploy from GitHub repo** (sube antes el repo `dgii-engine` a un GitHub privado) o **Deploy from Dockerfile**.
2. Railway detecta el `Dockerfile` y construye la imagen. El contenedor arranca con `node dist/api.js` en el puerto `PORT` (Railway lo inyecta; el motor ya lo respeta).
3. Configura las **Variables** (sección §3).
4. En **Settings → Networking → Custom Domain**, agrega `ecf.adse-rd.com`. Railway te dará un destino CNAME.
5. Configura el DNS en Wix (sección §4).
6. Espera a que el dominio quede "Active" con candado HTTPS.

---

## 2. Manejo SEGURO del certificado .p12 (lo importante)

**Regla de oro:** el `.p12` y su password **NUNCA** van en el código, ni en el repo, ni en la imagen Docker. Se inyectan como **secretos** y el motor los lee **en memoria**.

El motor soporta dos modos (elige UNO):

### Modo A — `P12_BASE64` (recomendado para Railway/Render/Fly) ✅
El certificado va como una variable secreta en base64. El motor lo decodifica en memoria al arrancar; **nunca se escribe a disco**.

Cómo generar el valor base64 (en tu máquina, una sola vez):
```bash
# En Linux/Mac:
base64 -w0 cert.p12 > cert_base64.txt    # Linux
base64 cert.p12 | tr -d '\n' > cert_base64.txt   # Mac
# Copia TODO el contenido de cert_base64.txt (una sola línea larga).
```
Luego pega ese texto como el valor de la variable `P12_BASE64` en Railway.

### Modo B — `P12_PATH` (para VPS con volumen/secreto de archivo)
Montas el `.p12` como un *secret file* o volumen y apuntas `P12_PATH=/run/secrets/cert.p12`. El archivo queda fuera del repo y de la imagen.

En ambos modos, el password va en `P12_PASSWORD` (variable secreta), y el motor lo usa solo en memoria — **nunca lo registra en logs** (confirmado en el código: el password se lee de la env y jamás se imprime).

---

## 3. Variables de entorno a configurar en el host

| Variable | Valor | Notas |
|---|---|---|
| `P12_BASE64` | (el contenido de cert_base64.txt) | **Secreto.** Modo A. Omitir si usas Modo B. |
| `P12_PATH` | `/run/secrets/cert.p12` | Solo Modo B (VPS). |
| `P12_PASSWORD` | `<TU_PASSWORD_P12>` | **Secreto.** Nunca en el código. |
| `RECEPTOR_JWT_SECRET` | (cadena larga aleatoria propia) | **Secreto.** Firma los tokens del receptor. Genera una: `openssl rand -hex 32` |
| `DGII_ENV` | `certecf` | Ambiente de certificación. En producción será `ecf`. |
| `PORT` | (lo inyecta Railway) | El motor lo respeta; no fijar en Railway. En VPS, 3000. |

> Marca `P12_BASE64`, `P12_PASSWORD` y `RECEPTOR_JWT_SECRET` como **secretas/ocultas** en el panel del host.

---

## 4. DNS en Wix para `ecf.adse-rd.com`

Tu dominio `adse-rd.com` está gestionado en Wix. Vas a agregar **un solo registro** que apunta el subdominio `ecf` a Railway, **sin tocar** los registros de tu sitio web.

1. Wix → **Settings → Domains → adse-rd.com → Manage DNS Records** (Editar registros DNS / Advanced).
2. Agrega un registro **CNAME**:
   - **Host/Name:** `ecf`
   - **Value/Points to:** el destino que te dio Railway (algo como `xxxx.up.railway.app`).
   - TTL: por defecto (1 h).
3. Guarda. La propagación tarda de minutos a un par de horas.
4. Vuelve a Railway → el Custom Domain pasará a "Active" y emitirá el certificado TLS automáticamente.

> Si Wix no permite CNAME en la raíz (no aplica aquí, usamos subdominio `ecf`, así que CNAME está bien). Tu sitio en `adse-rd.com` y `www` siguen intactos.

---

## 5. Verificar que quedó bien (antes de registrar en el portal)

Desde cualquier terminal:
```bash
# 1) Salud
curl -s https://ecf.adse-rd.com/health
#   → {"ok":true,"env":"certecf"}

# 2) Semilla (debe devolver XML)
curl -s https://ecf.adse-rd.com/fe/autenticacion/api/semilla
#   → <SemillaModel><valor>...</valor><fecha>...</fecha></SemillaModel>
```
Si ambos responden con HTTPS válido (candado, sin advertencias de certificado), estás listo.

---

## 6. URLs a registrar en el Paso 7 del portal

Cuando la DGII habilite el Paso 7, registra la **base** `https://ecf.adse-rd.com` y, según las casillas que muestre el portal, las rutas de cada servicio:

| Servicio | URL a registrar |
|---|---|
| Autenticación (semilla) | `https://ecf.adse-rd.com/fe/autenticacion/api/semilla` |
| Validación certificado | `https://ecf.adse-rd.com/fe/autenticacion/api/validacioncertificado` |
| Recepción e-CF | `https://ecf.adse-rd.com/fe/Recepcion/api/ecf` |
| Aprobación Comercial | `https://ecf.adse-rd.com/fe/AprobacionComercial/api/ecf` |
| (Opcional) Recepción RFCE | `https://ecf.adse-rd.com/fe/recepcionfc/api/ecf` |

> Algunos portales piden solo la URL **base** y ellos añaden las sub-rutas `fe/...`. Si el Paso 7 muestra un solo campo, registra `https://ecf.adse-rd.com`. Si muestra varios, usa la tabla.

---

## 7. (Alternativa) VPS propio con Docker + Caddy — TLS automático

Si en vez de Railway prefieres un VPS (DigitalOcean/Linode):
```bash
# En el VPS, con Docker instalado:
docker build -t adse-ecf .
# Caddy hace de reverse proxy con HTTPS automático (Let's Encrypt).
# Caddyfile:
#   ecf.adse-rd.com {
#     reverse_proxy 127.0.0.1:3000
#   }
docker run -d --name adse-ecf --restart unless-stopped \
  -e P12_BASE64="$(cat cert_base64.txt)" \
  -e P12_PASSWORD='<TU_PASSWORD_P12>' \
  -e RECEPTOR_JWT_SECRET="$(openssl rand -hex 32)" \
  -e DGII_ENV=certecf -e PORT=3000 \
  -p 127.0.0.1:3000:3000 adse-ecf
```
Y en Wix apuntas `ecf` con un registro **A** a la IP del VPS (en vez de CNAME).

---

## Notas de seguridad (resumen)
- `.p12` y `.env` están en `.gitignore`; la imagen Docker **no** incluye el certificado (`.dockerignore` lo excluye).
- El certificado se inyecta como secreto y se usa **solo en memoria**.
- El password nunca se registra en logs.
- `RECEPTOR_JWT_SECRET` debe ser único y secreto (no reutilizar ejemplos).
- El motor responde verdictos reales (Estado 0/1 dentro del ARECF); no se auto-bloquea.
