# CryptoGateway API Documentation

## Overview

CryptoGateway is a custodial crypto payment processor. It allows your service to accept and send cryptocurrency payments across Ethereum, BSC, TRON, and Solana networks.

**Base URL:** `https://your-domain.com/api/v1`

---

## Authentication

All client API requests must include your API key in the request header:

```
X-Api-Key: cpg_your_api_key_here
```

API keys are issued by the gateway operator (admin).

---

## Supported Networks and Tokens

| Network | Chain ID | Native Token | Supported Tokens     |
|---------|----------|-------------|----------------------|
| `ETH`   | 1        | ETH         | ETH, USDT, USDC      |
| `BSC`   | 56       | BNB         | BNB, USDT, USDC      |
| `TRON`  | —        | TRX         | TRX, USDT, USDC      |
| `SOLANA`| —        | SOL         | SOL, USDT, USDC      |

---

## Payments (Incoming — Accept Funds)

### Flow

```
1. Your service → POST /payments       → We return a deposit address + expiry
2. Your user sends crypto to that address
3. We detect the deposit on-chain
4. After N confirmations we sweep funds to our master wallet
5. We POST webhook to your server with payment.completed event
```

### Create a Payment

**Request:**
```http
POST /api/v1/payments
X-Api-Key: cpg_...
Content-Type: application/json

{
  "network": "ETH",
  "token": "USDT",
  "amount": "100.00",
  "clientReference": "order_12345",
  "metadata": {
    "userId": "usr_abc",
    "productId": "prod_xyz"
  }
}
```

**Fields:**

| Field            | Type   | Required | Description                                    |
|------------------|--------|----------|------------------------------------------------|
| `network`        | string | ✓        | `ETH`, `BSC`, `TRON`, `SOLANA`                 |
| `token`          | string | ✓        | `ETH`, `BNB`, `TRX`, `SOL`, `USDT`, `USDC`    |
| `amount`         | string | ✓        | Expected amount in token units (e.g. `"100.00"`) |
| `clientReference`| string |          | Your internal order/user ID                     |
| `metadata`       | object |          | Arbitrary JSON passed back in webhooks          |

**Response `201 Created`:**
```json
{
  "data": {
    "id": "pay_uuid",
    "network": "ETH",
    "token": "USDT",
    "address": "0xABC...123",
    "expectedAmount": "100.00",
    "status": "PENDING",
    "expiresAt": "2024-01-15T12:00:00Z",
    "clientReference": "order_12345",
    "createdAt": "2024-01-15T11:00:00Z"
  }
}
```

> **Important:** Tell the payer to send **exactly** the `expectedAmount` to `address` within the time shown in `expiresAt` (default: 1 hour).

---

### Get Payment Status

```http
GET /api/v1/payments/{paymentId}
X-Api-Key: cpg_...
```

**Response `200 OK`:**
```json
{
  "data": {
    "id": "pay_uuid",
    "network": "ETH",
    "token": "USDT",
    "address": "0xABC...123",
    "expectedAmount": "100.00",
    "status": "COMPLETED",
    "txHash": "0xTX_HASH",
    "completedAt": "2024-01-15T11:15:00Z",
    "expiresAt": "2024-01-15T12:00:00Z",
    "clientReference": "order_12345",
    "createdAt": "2024-01-15T11:00:00Z"
  }
}
```

**Payment Statuses:**

| Status      | Description                                                    |
|-------------|----------------------------------------------------------------|
| `PENDING`   | Waiting for deposit. Share the address with your user.         |
| `DETECTED`  | Deposit seen on-chain. Waiting for confirmations.              |
| `CONFIRMED` | Required confirmations reached. Sweep in progress.            |
| `SWEEPING`  | Funds are being moved to master wallet.                        |
| `COMPLETED` | Payment fully processed. Webhook sent to your server.         |
| `EXPIRED`   | Payment window expired. No funds received.                     |
| `FAILED`    | Processing error. Contact support.                             |

---

### List Payments

```http
GET /api/v1/payments?page=1&limit=20&status=COMPLETED
X-Api-Key: cpg_...
```

**Query Parameters:**

| Param   | Type   | Description                         |
|---------|--------|-------------------------------------|
| `page`  | number | Page number (default: 1)            |
| `limit` | number | Items per page (max: 100, default: 20) |
| `status`| string | Filter by payment status            |

---

## Withdrawals (Outgoing — Send Funds)

### Flow

```
1. Your service → POST /withdrawals    → We queue the transfer
2. We execute transfer from hot wallet to toAddress
3. We POST webhook to your server with withdrawal.completed event
```

### Create a Withdrawal

```http
POST /api/v1/withdrawals
X-Api-Key: cpg_...
Content-Type: application/json

{
  "network": "TRON",
  "token": "USDT",
  "amount": "50.00",
  "toAddress": "TTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "clientReference": "payout_789"
}
```

**Fields:**

| Field            | Type   | Required | Description                      |
|------------------|--------|----------|----------------------------------|
| `network`        | string | ✓        | Target network                   |
| `token`          | string | ✓        | Token to send                    |
| `amount`         | string | ✓        | Amount to send (our fee deducted)|
| `toAddress`      | string | ✓        | Recipient wallet address         |
| `clientReference`| string |          | Your internal reference ID       |

**Response `201 Created`:**
```json
{
  "data": {
    "id": "wdr_uuid",
    "network": "TRON",
    "token": "USDT",
    "amount": "50.00",
    "toAddress": "TTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "status": "PENDING",
    "clientReference": "payout_789",
    "createdAt": "2024-01-15T11:00:00Z"
  }
}
```

---

### Get Withdrawal Status

```http
GET /api/v1/withdrawals/{withdrawalId}
X-Api-Key: cpg_...
```

---

### List Withdrawals

```http
GET /api/v1/withdrawals?page=1&limit=20
X-Api-Key: cpg_...
```

---

## Webhooks

We send HTTP POST requests to your `webhookUrl` when payment/withdrawal status changes.

### Setup

Provide your webhook URL and secret when registering with us (admin can configure via dashboard).

### Payload Structure

```json
{
  "event": "payment.completed",
  "paymentId": "pay_uuid",
  "network": "ETH",
  "token": "USDT",
  "amount": "100000000",
  "status": "COMPLETED",
  "txHash": "0xTX_HASH",
  "clientReference": "order_12345",
  "metadata": { "userId": "usr_abc" },
  "timestamp": "2024-01-15T11:15:00Z"
}
```

### Event Types

| Event                  | Trigger                                            |
|------------------------|----------------------------------------------------|
| `payment.detected`     | Deposit seen on-chain (not yet confirmed)          |
| `payment.confirmed`    | Required block confirmations reached               |
| `payment.completed`    | Funds swept to master wallet — payment is done     |
| `payment.expired`      | Payment window expired without deposit             |
| `payment.failed`       | Processing error                                   |
| `withdrawal.completed` | Outgoing transfer confirmed on-chain               |
| `withdrawal.failed`    | Transfer failed                                    |

### Webhook Verification (HMAC-SHA256)

If you set a `webhookSecret`, we sign every request:

```
X-Signature: sha256=<hmac_hex>
```

Verify in your server:

```typescript
import { createHmac } from 'crypto';

function verifyWebhook(body: string, signature: string, secret: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return expected === signature;
}

// In your route handler:
const rawBody = await request.text();
const sig = request.headers.get('x-signature');
if (!verifyWebhook(rawBody, sig, YOUR_SECRET)) {
  return Response.json({ error: 'Invalid signature' }, { status: 401 });
}
```

### Retries

If your endpoint does not return HTTP 2xx within 10 seconds, we retry with exponential backoff:

| Attempt | Delay   |
|---------|---------|
| 1       | 5 sec   |
| 2       | 25 sec  |
| 3       | 2 min   |
| 4       | 10 min  |
| 5       | 50 min  |

After 5 failures the event is marked as dead. Contact support to replay.

---

## Confirmations Required

| Network | Confirmations | Avg. Time  |
|---------|---------------|------------|
| ETH     | 12            | ~2.5 min   |
| BSC     | 15            | ~1.5 min   |
| TRON    | 19            | ~2 min     |
| Solana  | 1 finalized   | ~1 sec     |

---

## Error Responses

All errors return JSON with an `error` field:

```json
{ "error": "Token USDT is not supported on SOLANA" }
```

| HTTP Code | Meaning                                   |
|-----------|-------------------------------------------|
| 400       | Bad request — invalid parameters          |
| 401       | Missing or invalid API key                |
| 404       | Resource not found                        |
| 429       | Rate limit exceeded (100 req/min per key) |
| 500       | Internal server error                     |

---

## Integration Quickstart

### 1. Accept a payment (Node.js example)

```typescript
// 1. Create a payment invoice
const response = await fetch('https://gateway.your-domain.com/api/v1/payments', {
  method: 'POST',
  headers: {
    'X-Api-Key': 'cpg_your_key',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    network: 'TRON',
    token: 'USDT',
    amount: '100.00',
    clientReference: `order_${orderId}`,
    metadata: { userId, orderId },
  }),
});
const { data: payment } = await response.json();

// 2. Show to your user
console.log(`Send ${payment.expectedAmount} ${payment.token} to:`);
console.log(payment.address);
console.log(`Expires: ${payment.expiresAt}`);

// 3. Handle webhook (in your webhook route handler)
app.post('/webhooks/crypto', (req, res) => {
  const { event, paymentId, status, clientReference } = req.body;
  if (event === 'payment.completed') {
    // Mark order as paid
    fulfillOrder(clientReference);
  }
  res.sendStatus(200);
});
```

### 2. Send a payout

```typescript
const response = await fetch('https://gateway.your-domain.com/api/v1/withdrawals', {
  method: 'POST',
  headers: {
    'X-Api-Key': 'cpg_your_key',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    network: 'SOLANA',
    token: 'USDC',
    amount: '25.00',
    toAddress: 'RecipientSolanaAddress...',
    clientReference: `payout_${payoutId}`,
  }),
});
const { data: withdrawal } = await response.json();
console.log(`Withdrawal ${withdrawal.id} queued, status: ${withdrawal.status}`);
```

---

## Rate Limits

- **100 requests per minute** per API key
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

## Fees

Fees are deducted at sweep time (incoming) or transfer time (outgoing). Your specific fee percentage is configured by the gateway operator. The default is **1%**.

- **Example:** User sends 100 USDT → you receive credit for 99 USDT (1% fee)
- **Withdrawal example:** You request 50 USDT payout → recipient gets 49.5 USDT

---

## Admin API

Admin endpoints use `X-Admin-Secret` header instead of `X-Api-Key`. Available at:

- `GET  /api/v1/admin/stats` — Dashboard statistics
- `GET  /api/v1/admin/clients` — List all clients
- `POST /api/v1/admin/clients` — Register new client
- `PATCH /api/v1/admin/clients/:id` — Update client settings
- `POST /api/v1/admin/clients/:id/rotate-key` — Rotate API key
- `GET  /api/v1/admin/payments` — All payments with filters
- `GET  /api/v1/admin/webhooks` — Webhook event log

Admin dashboard (web UI): `https://your-domain.com/admin/`
