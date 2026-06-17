# Production Deployment Guide

## Architecture overview

```
Internet → Caddy (HTTPS/TLS) → Fastify API :3000
                                     ↕
                              PostgreSQL   Redis
                                     ↕
                             Worker process (block watcher, sweep, webhooks)
```

---

## 1. Free services

| Service | Purpose | Free tier | Link |
|---------|---------|-----------|------|
| **Neon** | PostgreSQL | 0.5 GB, serverless | https://neon.tech |
| **Upstash** | Redis | 10 000 req/day, TLS | https://upstash.com |
| **Alchemy** | ETH/BSC RPC | 300M compute units/mo | https://alchemy.com |
| **Helius** | Solana RPC | 100k credits/day | https://helius.dev |
| **TronGrid** | TRON RPC | 5 000 req/day | https://trongrid.io |
| **UptimeRobot** | Uptime monitoring | 50 monitors, 5-min checks | https://uptimerobot.com |
| **Telegram Bot** | Critical alerts | Free | https://t.me/BotFather |
| **Caddy** | Reverse proxy + HTTPS | Free, open source | https://caddyserver.com |
| **Railway / Fly.io** | VPS hosting | $5/mo credit (Railway) | https://railway.app |

---

## 2. Server requirements

- **OS**: Ubuntu 22.04 LTS or Debian 12
- **RAM**: 1 GB minimum (2 GB recommended)
- **CPU**: 1 vCPU minimum
- **Node.js**: 20 LTS (`curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt install nodejs`)
- **PM2**: `npm install -g pm2`
- **Caddy**: see https://caddyserver.com/docs/install

---

## 3. Initial setup

```bash
# Clone repository
git clone https://github.com/your-org/crypto-payment-gateway.git /opt/cpg
cd /opt/cpg

# Install dependencies
npm install

# Copy and fill environment
cp .env.example .env
nano .env          # fill in all values

# Build TypeScript
npm run build

# Run DB migrations
npx prisma db push    # or: npx prisma migrate deploy

# Generate Prisma client (already done by build, but just in case)
npx prisma generate
```

---

## 4. Caddy (recommended — auto-HTTPS)

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Edit Caddyfile — replace YOUR_DOMAIN
sudo nano /opt/cpg/Caddyfile

# Run Caddy pointing at our Caddyfile
sudo caddy run --config /opt/cpg/Caddyfile --adapter caddyfile &

# Or as a systemd service (recommended)
sudo tee /etc/systemd/system/caddy.service > /dev/null <<'EOF'
[Unit]
Description=Caddy
After=network.target

[Service]
User=caddy
ExecStart=/usr/bin/caddy run --config /opt/cpg/Caddyfile --adapter caddyfile
ExecReload=/bin/kill -USR1 $MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now caddy
```

---

## 5. Nginx + Certbot (alternative)

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# Copy config (edit YOUR_DOMAIN first)
sudo cp /opt/cpg/nginx.conf /etc/nginx/sites-available/cpg
sudo ln -s /etc/nginx/sites-available/cpg /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Obtain Let's Encrypt certificate (auto-patches nginx config)
sudo certbot --nginx -d YOUR_DOMAIN

# Auto-renew (runs twice daily via cron)
sudo certbot renew --dry-run
```

---

## 6. PM2 process manager

```bash
# Start both API and worker
pm2 start /opt/cpg/ecosystem.config.js

# Save process list so they survive reboots
pm2 save
pm2 startup    # follow the printed command to enable systemd unit

# Useful commands
pm2 logs cpg-api
pm2 logs cpg-worker
pm2 monit
pm2 restart cpg-api
```

---

## 7. Telegram alert bot setup

1. Open Telegram, message **@BotFather** → `/newbot` → follow prompts → copy token.
2. Start a chat with your new bot (send any message).
3. Get your `chat_id`:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
   ```
4. Put both values in `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:ABC...
   TELEGRAM_CHAT_ID=-100123456789
   ```

The worker will send a Telegram message on:
- Block watcher crash
- Worker process fatal error
- 5+ consecutive RPC errors on any network

---

## 8. UptimeRobot monitoring (free)

1. Register at https://uptimerobot.com
2. Add HTTP monitor → URL: `https://YOUR_DOMAIN/health`
3. Add HTTP monitor → URL: `http://YOUR_SERVER_IP:3001` (worker health)
4. Set alert interval: 5 minutes
5. Add Telegram / email notification channel

---

## 9. Admin IP whitelist

In `.env`, set:
```
ADMIN_WHITELIST_IPS=1.2.3.4,5.6.7.8
```
Only those IPs can access `/admin/*`. Leave empty to disable restriction (not recommended for production).

---

## 10. Generating master wallets

```bash
# BIP39 mnemonic (24 words)
node -e "const b=require('bip39'); console.log(b.generateMnemonic(256))"

# Encryption key (32 bytes = 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Generate your master hot wallet addresses** using MetaMask (ETH/BSC), TronLink (TRON), or Phantom (Solana) and put them in `.env` as `ETH_MASTER_ADDRESS`, etc. These receive all swept funds.

---

## 11. Deployment checklist

- [ ] `NODE_ENV=production` in `.env`
- [ ] All required env vars set (app will fail fast with a clear error if not)
- [ ] `DATABASE_URL` points to production DB with SSL
- [ ] `REDIS_URL` uses TLS (`rediss://`)
- [ ] `MASTER_MNEMONIC` backed up securely (paper / password manager)
- [ ] `WALLET_ENCRYPTION_KEY` backed up securely
- [ ] Master hot wallet addresses filled in
- [ ] `ADMIN_SECRET` is long and random
- [ ] `ADMIN_WHITELIST_IPS` set to your static IP(s)
- [ ] Telegram alerts tested
- [ ] UptimeRobot monitor active
- [ ] PM2 startup hook installed (`pm2 startup`)
- [ ] Firewall: only ports 80, 443 open externally (3000, 3001 blocked from internet)
- [ ] Caddy or Nginx serving HTTPS with valid certificate

---

## 12. Firewall (ufw)

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (redirect only)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw deny 3000/tcp   # API — internal only
sudo ufw deny 3001/tcp   # Worker health — internal only
sudo ufw enable
```
