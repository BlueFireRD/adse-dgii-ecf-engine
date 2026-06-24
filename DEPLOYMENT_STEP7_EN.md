# Receptor Engine Deployment — `ecf.adse-rd.com` (DGII Step 7)

Guide to bring the engine up 24/7 with HTTPS, handle the certificate securely, and register the URLs in Step 7.

---

## 0. Architecture (overview)

```
DGII  ──HTTPS──►  https://ecf.adse-rd.com   (this Node engine, 24/7 container + TLS)
                        │
                        └──internal HTTP──►  CRM/POS on Lovable (adse.app)
```

- The receptor engine lives in its **own service** (not inside Lovable/Supabase, because it needs a persistent process, Node-based XMLDSig signing, and .p12 handling).
- Chosen subdomain: **`ecf.adse-rd.com`** (a DNS record on your Wix domain pointing to the service; it does not affect your website).

---

## 1. Recommended hosting: Railway (simplest to set up and maintain)

Why Railway to start:
- You deploy the `Dockerfile` that's already in the repo — no server administration, patching, or manual TLS.
- **Automatic TLS/HTTPS** on the domain it provides and on your own domain.
- Built-in variables/secrets (this is where the certificate and password go).
- Self-restarts, healthcheck included, live logs. Low cost (metered plan).

> Equivalent alternatives: **Render** or **Fly.io** (same conceptual steps: Docker deploy + secret variables + custom domain). If you prefer full control, a VPS with Docker + Caddy also works (see §7).

### Steps in Railway
1. Create an account at railway.app and a new project → **Deploy from GitHub repo** (push the `dgii-engine` repo to a private GitHub first) or **Deploy from Dockerfile**.
2. Railway detects the `Dockerfile` and builds the image. The container starts with `node dist/api.js` on the `PORT` port (Railway injects it; the engine already respects it).
3. Configure the **Variables** (section §3).
4. Under **Settings → Networking → Custom Domain**, add `ecf.adse-rd.com`. Railway will give you a CNAME target.
5. Configure DNS in Wix (section §4).
6. Wait until the domain shows "Active" with an HTTPS padlock.

---

## 2. SECURE handling of the .p12 certificate (the important part)

**Golden rule:** the `.p12` and its password **NEVER** go in the code, the repo, or the Docker image. They are injected as **secrets** and the engine reads them **in memory**.

The engine supports two modes (pick ONE):

### Mode A — `P12_BASE64` (recommended for Railway/Render/Fly) ✅
The certificate goes in as a base64 secret variable. The engine decodes it in memory at startup; **it is never written to disk**.

How to generate the base64 value (on your machine, one time only):
```bash
# On Linux/Mac:
base64 -w0 cert.p12 > cert_base64.txt    # Linux
base64 cert.p12 | tr -d '\n' > cert_base64.txt   # Mac
# Copy the ENTIRE content of cert_base64.txt (one long single line).
```
Then paste that text as the value of the `P12_BASE64` variable in Railway.

### Mode B — `P12_PATH` (for a VPS with a file volume/secret)
You mount the `.p12` as a *secret file* or volume and point `P12_PATH=/run/secrets/cert.p12`. The file stays out of the repo and the image.

In both modes, the password goes in `P12_PASSWORD` (secret variable), and the engine uses it only in memory — **it is never written to logs** (confirmed in the code: the password is read from the env and never printed).

---

## 3. Environment variables to configure on the host

| Variable | Value | Notes |
|---|---|---|
| `P12_BASE64` | (the content of cert_base64.txt) | **Secret.** Mode A. Omit if using Mode B. |
| `P12_PATH` | `/run/secrets/cert.p12` | Mode B only (VPS). |
| `P12_PASSWORD` | `<TU_PASSWORD_P12>` | **Secret.** Never in the code. |
| `RECEPTOR_JWT_SECRET` | (your own long random string) | **Secret.** Signs the receptor's tokens. Generate one: `openssl rand -hex 32` |
| `DGII_ENV` | `certecf` | Certification environment. In production it will be `ecf`. |
| `PORT` | (injected by Railway) | The engine respects it; don't set it in Railway. On a VPS, 3000. |

> Mark `P12_BASE64`, `P12_PASSWORD`, and `RECEPTOR_JWT_SECRET` as **secret/hidden** in the host's panel.

---

## 4. DNS in Wix for `ecf.adse-rd.com`

Your domain `adse-rd.com` is managed in Wix. You'll add **a single record** that points the `ecf` subdomain to Railway, **without touching** your website's records.

1. Wix → **Settings → Domains → adse-rd.com → Manage DNS Records** (Edit DNS records / Advanced).
2. Add a **CNAME** record:
   - **Host/Name:** `ecf`
   - **Value/Points to:** the target Railway gave you (something like `xxxx.up.railway.app`).
   - TTL: default (1 h).
3. Save. Propagation takes from minutes to a couple of hours.
4. Go back to Railway → the Custom Domain will turn "Active" and issue the TLS certificate automatically.

> If Wix doesn't allow a CNAME at the root (doesn't apply here, we use the `ecf` subdomain, so CNAME is fine). Your site at `adse-rd.com` and `www` remain intact.

---

## 5. Verify it's working (before registering in the portal)

From any terminal:
```bash
# 1) Health
curl -s https://ecf.adse-rd.com/health
#   → {"ok":true,"env":"certecf"}

# 2) Seed (should return XML)
curl -s https://ecf.adse-rd.com/fe/autenticacion/api/semilla
#   → <SemillaModel><valor>...</valor><fecha>...</fecha></SemillaModel>
```
If both respond over valid HTTPS (padlock, no certificate warnings), you're ready.

---

## 6. URLs to register in the portal's Step 7

When the DGII enables Step 7, register the **base** `https://ecf.adse-rd.com` and, depending on the fields the portal shows, the route for each service:

| Service | URL to register |
|---|---|
| Authentication (seed) | `https://ecf.adse-rd.com/fe/autenticacion/api/semilla` |
| Certificate validation | `https://ecf.adse-rd.com/fe/autenticacion/api/validacioncertificado` |
| e-CF Reception | `https://ecf.adse-rd.com/fe/Recepcion/api/ecf` |
| Commercial Approval | `https://ecf.adse-rd.com/fe/AprobacionComercial/api/ecf` |
| (Optional) RFCE Reception | `https://ecf.adse-rd.com/fe/recepcionfc/api/ecf` |

> Some portals ask only for the **base** URL and append the `fe/...` sub-routes themselves. If Step 7 shows a single field, register `https://ecf.adse-rd.com`. If it shows several, use the table.

---

## 7. (Alternative) Your own VPS with Docker + Caddy — automatic TLS

If instead of Railway you prefer a VPS (DigitalOcean/Linode):
```bash
# On the VPS, with Docker installed:
docker build -t adse-ecf .
# Caddy acts as a reverse proxy with automatic HTTPS (Let's Encrypt).
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
And in Wix you point `ecf` with an **A** record to the VPS's IP (instead of a CNAME).

---

## Security notes (summary)
- `.p12` and `.env` are in `.gitignore`; the Docker image does **not** include the certificate (`.dockerignore` excludes it).
- The certificate is injected as a secret and used **only in memory**.
- The password is never written to logs.
- `RECEPTOR_JWT_SECRET` must be unique and secret (don't reuse examples).
- The engine returns real verdicts (Estado 0/1 inside the ARECF); it does not self-block.
