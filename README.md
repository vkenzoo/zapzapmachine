# RoboVendas Backend

Backend Hono que faz a ponte entre frontend, Evolution API (WhatsApp) e Supabase.

## Endpoints

### Publicos
- `GET /` — saude (string "OK")
- `GET /health` — saude JSON
- `POST /webhooks/evolution?instance=<uuid>` — recebe webhooks do Evolution

### Autenticados (Bearer Supabase JWT)
- `POST /whatsapp/instancias` — cria instancia
- `GET /whatsapp/:id/qr` — busca QR code
- `GET /whatsapp/:id/status` — polling de status
- `DELETE /whatsapp/:id` — desconecta e remove

## Dev local

```bash
cp .env.example .env
# preencha as variaveis

npm install
npm run dev
```

Backend sobe em http://localhost:3001.

### Expor webhook local pra Evolution (ngrok)
Enquanto o backend nao esta em producao, use ngrok pra Evolution conseguir chamar o webhook:

```bash
ngrok http 3001
```

Copie a URL `https://xxxx.ngrok.app` e use em `BACKEND_PUBLIC_URL` no `.env`.

## Deploy (Coolify)

1. Conecta este repo no Coolify
2. Build pack: Dockerfile
3. Domain: `api.<DOMINIO>.com`
4. Environment variables: copia do `.env.example` preenchido
5. Deploy

Coolify auto-provisiona SSL via Let's Encrypt.
