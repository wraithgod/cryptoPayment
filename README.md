# CryptoGateway — Self-Hosted Custodial Crypto Payment Processor

Кастодиальный шлюз для приёма криптовалютных платежей на собственной инфраструктуре.  
Поддерживает **ETH · BSC · TRON · Solana** и токены USDT / USDC на каждой сети.

---

## Стек

| Слой | Технология |
|---|---|
| API | Node.js 20, Fastify, TypeScript |
| БД | PostgreSQL 16, Prisma ORM |
| Очереди | Redis 7 + BullMQ |
| Кошельки | BIP32/BIP39 HD-кошелёк, шифрование AES-256 |
| Инфра | Docker Compose |

---

## Быстрый старт (Docker)

### 1. Требования

- **Docker Desktop ≥ 4.x** с плагином Compose V2  
  Проверка: `docker compose version`

---

### 2. Клонировать и подготовить `.env`

```bash
git clone <repo-url>
cd cryptoPayment
cp .env.example .env
```

---

### 3. Заполнить `.env`

Откройте `.env` в любом редакторе. Минимальный набор для тестнета:

```env
# ── Пароли для контейнеров (любые) ────────────────────────────
POSTGRES_PASSWORD=supersecret_pg
REDIS_PASSWORD=supersecret_redis

# ── Секреты приложения ─────────────────────────────────────────
# Генерация: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ADMIN_SECRET=<64 hex-символа>
WALLET_ENCRYPTION_KEY=<64 hex-символа>

# Генерация мнемоники (24 слова BIP39):
# node -e "console.log(require('bip39').generateMnemonic(256))"
MASTER_MNEMONIC=word1 word2 ... word24

# ── ETH Sepolia testnet ────────────────────────────────────────
# RPC получить бесплатно на https://alchemy.com (300M compute units/mo)
ETH_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
ETH_WS_URL=wss://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY

# Ваш кошелёк — сюда придут sweep-переводы
ETH_MASTER_ADDRESS=0x<ваш ETH-адрес>
ETH_MASTER_PRIVATE_KEY=0x<приватный ключ>

# Быстрые подтверждения для теста
ETH_CONFIRMATIONS=1
```

> **Альтернатива:** интерактивный wizard генерирует секреты и спрашивает адреса кошельков:
> ```bash
> npm install    # нужен для bip39
> npm run setup
> ```

---

### 4. Запустить

```bash
docker compose up --build -d
```

Что происходит внутри:

| Этап | Описание |
|---|---|
| `build` | Сборка Docker-образа (~2–3 мин при первом запуске) |
| `postgres` / `redis` | Старт баз данных |
| `migrate` | Применяет SQL-миграции (`prisma migrate deploy`), затем завершается |
| `api` | HTTP-сервер на порту 3000 |
| `worker` | Фоновые задачи: sweep, вебхуки, retry |

---

### 5. Проверить запуск

```bash
# Состояние контейнеров
docker compose ps

# Логи (Ctrl+C для выхода)
docker compose logs -f api worker

# Health check
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"2025-..."}
```

Если `migrate` завершился с кодом 0, а `api` и `worker` в статусе `running` — всё готово.

---

## Тестирование платежа (Sepolia testnet)

### Шаг 1 — Получить тестовый ETH

| Фaucet | Ссылка |
|---|---|
| Alchemy Faucet | https://www.alchemy.com/faucets/ethereum-sepolia |
| Sepolia Faucet | https://sepoliafaucet.com |

Понадобится аккаунт Alchemy или Infura. Бесплатно выдают 0.5 ETH/день.

---

### Шаг 2 — Создать депозитный адрес

```bash
curl -X POST http://localhost:3000/api/v1/deposits/address \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET" \
  -d '{"userId": "test_user_1", "network": "ETH"}'
```

Ответ:

```json
{
  "data": {
    "userId": "test_user_1",
    "network": "ETH",
    "address": "0xAbCd...1234",
    "supportedTokens": ["ETH", "USDT", "USDC"],
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

Адрес **постоянный** — повторный вызов с теми же `userId` + `network` вернёт тот же адрес.

---

### Шаг 3 — Отправить тестовый ETH

В MetaMask (сеть Sepolia Testnet):

1. Переключитесь на **Sepolia Testnet**
2. Отправьте любую сумму на адрес из шага 2
3. Подождите ~15–30 секунд (при `ETH_CONFIRMATIONS=1`)

---

### Шаг 4 — Наблюдать жизненный цикл

**Admin Panel** → `http://localhost:3000/admin/`  
Пароль: значение `ADMIN_SECRET` из `.env`

Вкладка **Payments** покажет смену статусов:

```
DETECTED → CONFIRMED → SWEEPING → COMPLETED
```

Через API:

```bash
curl http://localhost:3000/api/v1/admin/payments \
  -H "X-Admin-Secret: YOUR_ADMIN_SECRET"
```

---

### Шаг 5 — Проверить вебхуки (опционально)

Для локального перехвата вебхуков — [webhook.site](https://webhook.site):

1. Откройте webhook.site → скопируйте уникальный URL
2. Admin Panel → **Settings**:
   - Webhook URL: `https://webhook.site/xxxxxxxx-...`
   - Webhook Secret: любая строка ≥ 16 символов
3. Повторите платёж — получите три события:

```json
{ "event": "PAYMENT_DETECTED",   "data": { "txHash": "0x...", "amount": "0.01 ETH" } }
{ "event": "PAYMENT_CONFIRMED",  "data": { ... } }
{ "event": "PAYMENT_COMPLETED",  "data": { "sweepTxHash": "0x..." } }
```

Каждый вебхук подписан заголовком `X-Signature: sha256=<hmac>`.

---

## API Reference

Все запросы требуют заголовок `X-Admin-Secret: <ADMIN_SECRET>`.  
Полная интерактивная документация: `http://localhost:3000/docs`

### Создать депозитный адрес

```
POST /api/v1/deposits/address
Body: { "userId": "string", "network": "ETH|BSC|TRON|SOLANA" }
```

### Список адресов

```
GET /api/v1/deposits/addresses?userId=&network=&page=1&limit=20
```

### Статистика

```
GET /api/v1/admin/stats
```

### Список платежей

```
GET /api/v1/admin/payments?network=ETH&status=COMPLETED&page=1&limit=20
```

### Настройки оператора

```
GET   /api/v1/admin/settings
PATCH /api/v1/admin/settings
Body: { "feePercent": 1.5, "webhookUrl": "https://...", "webhookSecret": "..." }
```

### Вебхуки

```
GET  /api/v1/admin/webhooks?failed=true&page=1
POST /api/v1/admin/webhooks/:id/replay
```

---

## Панель администратора

`http://localhost:3000/admin/`

| Вкладка | Содержимое |
|---|---|
| Dashboard | Счётчики по статусам + последние 10 платежей |
| Payments | Полная таблица с фильтрами по сети / статусу / user ID |
| Webhooks | Лог событий, повтор неудавшихся |
| Settings | Fee %, URL и секрет вебхука |

### Мониторинг очередей BullMQ

`http://localhost:3000/queues`  
Логин: любой / Пароль: значение `ADMIN_SECRET`

---

## Управление контейнерами

```bash
# Остановить (данные сохраняются)
docker compose down

# Остановить + удалить тома (сброс БД и Redis)
docker compose down -v

# Пересобрать после изменений кода
docker compose up --build -d

# Логи
docker compose logs -f api
docker compose logs -f worker

# Открыть psql
docker compose exec postgres psql -U postgres -d crypto_gateway
```

---

## Переменные окружения

| Переменная | Обяз. | Описание |
|---|---|---|
| `POSTGRES_PASSWORD` | ✓ | Пароль PostgreSQL (только для Docker) |
| `REDIS_PASSWORD` | ✓ | Пароль Redis (только для Docker) |
| `ADMIN_SECRET` | ✓ | Пароль к `/admin/` и всем API |
| `MASTER_MNEMONIC` | ✓ | BIP39 мнемоника 24 слова — HD-кошелёк |
| `WALLET_ENCRYPTION_KEY` | ✓ | 64 hex-символа (32 байта AES-ключ) |
| `DATABASE_URL` | авто | Compose подставляет автоматически |
| `REDIS_URL` | авто | Compose подставляет автоматически |
| `ETH_RPC_URL` | ✓ | HTTP RPC (Alchemy / Infura) |
| `ETH_WS_URL` | рек. | WebSocket RPC для подписок на блоки |
| `ETH_MASTER_ADDRESS` | ✓ | Адрес для sweep-переводов |
| `ETH_MASTER_PRIVATE_KEY` | ✓ | Приватный ключ (подпись sweep + газ) |
| `ETH_CONFIRMATIONS` | — | Подтверждений до sweep (тест: 1, прод: 12) |
| `DEFAULT_FEE_PERCENT` | — | Комиссия оператора, по умолчанию 1.0% |
| `TELEGRAM_BOT_TOKEN` | — | Алерты в Telegram |
| `TELEGRAM_CHAT_ID` | — | Chat ID для алертов |

Полный список — [`.env.example`](.env.example).
