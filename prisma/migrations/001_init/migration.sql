-- Migration 001 — Initial schema

-- CreateEnum
CREATE TYPE "Network" AS ENUM ('ETH', 'BSC', 'TRON', 'SOLANA');
CREATE TYPE "Token" AS ENUM ('ETH', 'BNB', 'TRX', 'SOL', 'USDT', 'USDC');
CREATE TYPE "PaymentStatus" AS ENUM ('DETECTED', 'CONFIRMED', 'SWEEPING', 'COMPLETED', 'FAILED');
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "WebhookEventType" AS ENUM ('PAYMENT_DETECTED', 'PAYMENT_CONFIRMED', 'PAYMENT_COMPLETED', 'PAYMENT_FAILED', 'WITHDRAWAL_COMPLETED', 'WITHDRAWAL_FAILED');

-- Settings (singleton row, id = 1)
CREATE TABLE "settings" (
    "id"             INTEGER      NOT NULL DEFAULT 1,
    "fee_percent"    DECIMAL(5,2) NOT NULL DEFAULT 1.0,
    "webhook_url"    TEXT,
    "webhook_secret" TEXT,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "settings_pkey" PRIMARY KEY ("id")
);
INSERT INTO "settings" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP);

-- User wallets
CREATE TABLE "user_wallets" (
    "id"            TEXT         NOT NULL,
    "user_id"       TEXT         NOT NULL,
    "network"       "Network"    NOT NULL,
    "address"       TEXT         NOT NULL,
    "hd_index"      INTEGER      NOT NULL,
    "encrypted_key" TEXT         NOT NULL,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_wallets_user_id_network_key" ON "user_wallets"("user_id", "network");
CREATE UNIQUE INDEX "user_wallets_network_address_key"  ON "user_wallets"("network", "address");

-- Counter for HD index per network
CREATE TABLE "user_wallet_counters" (
    "network" "Network" NOT NULL,
    "count"   INTEGER   NOT NULL DEFAULT 0,
    CONSTRAINT "user_wallet_counters_pkey" PRIMARY KEY ("network")
);
INSERT INTO "user_wallet_counters" ("network", "count") VALUES ('ETH', 0), ('BSC', 0), ('TRON', 0), ('SOLANA', 0);

-- Payments
CREATE TABLE "payments" (
    "id"              TEXT            NOT NULL,
    "user_id"         TEXT            NOT NULL,
    "user_wallet_id"  TEXT            NOT NULL,
    "network"         "Network"       NOT NULL,
    "token"           "Token"         NOT NULL,
    "received_amount" DECIMAL(36,18)  NOT NULL DEFAULT 0,
    "fee_amount"      DECIMAL(36,18)  NOT NULL DEFAULT 0,
    "fee_percent"     DECIMAL(5,2)    NOT NULL,
    "status"          "PaymentStatus" NOT NULL DEFAULT 'DETECTED',
    "tx_hash"         TEXT            NOT NULL,
    "sweep_tx_hash"   TEXT,
    "confirmations"   INTEGER         NOT NULL DEFAULT 0,
    "completed_at"    TIMESTAMP(3),
    "created_at"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payments_tx_hash_key"       ON "payments"("tx_hash");
CREATE INDEX        "payments_user_id_idx"        ON "payments"("user_id");
CREATE INDEX        "payments_status_idx"         ON "payments"("status");
CREATE INDEX        "payments_network_status_idx" ON "payments"("network", "status");
CREATE INDEX        "payments_user_wallet_id_idx" ON "payments"("user_wallet_id");

-- Withdrawals
CREATE TABLE "withdrawals" (
    "id"               TEXT                 NOT NULL,
    "network"          "Network"            NOT NULL,
    "token"            "Token"              NOT NULL,
    "amount"           DECIMAL(36,18)       NOT NULL,
    "fee_amount"       DECIMAL(36,18)       NOT NULL DEFAULT 0,
    "to_address"       TEXT                 NOT NULL,
    "tx_hash"          TEXT,
    "status"           "WithdrawalStatus"   NOT NULL DEFAULT 'PENDING',
    "fail_reason"      TEXT,
    "client_reference" TEXT,
    "created_at"       TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "withdrawals_status_idx" ON "withdrawals"("status");

-- Webhook events
CREATE TABLE "webhook_events" (
    "id"            TEXT               NOT NULL,
    "payment_id"    TEXT,
    "withdrawal_id" TEXT,
    "event_type"    "WebhookEventType" NOT NULL,
    "payload"       JSONB              NOT NULL,
    "attempts"      INTEGER            NOT NULL DEFAULT 0,
    "max_attempts"  INTEGER            NOT NULL DEFAULT 5,
    "replay_count"  INTEGER            NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "delivered_at"  TIMESTAMP(3),
    "last_error"    TEXT,
    "created_at"    TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_events_delivery_idx" ON "webhook_events"("delivered_at", "next_retry_at");

-- Foreign keys
ALTER TABLE "payments"       ADD CONSTRAINT "payments_user_wallet_id_fkey"        FOREIGN KEY ("user_wallet_id") REFERENCES "user_wallets"("id")  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_payment_id_fkey"      FOREIGN KEY ("payment_id")     REFERENCES "payments"("id")      ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_withdrawal_id_fkey"   FOREIGN KEY ("withdrawal_id")  REFERENCES "withdrawals"("id")   ON DELETE SET NULL ON UPDATE CASCADE;
