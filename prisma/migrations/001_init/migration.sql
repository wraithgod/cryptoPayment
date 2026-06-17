-- Migration 001 — Initial schema matching current Prisma schema
-- Replaces the stale wallets/wallet_counters design with user_wallets/user_wallet_counters

-- CreateEnum
CREATE TYPE "Network" AS ENUM ('ETH', 'BSC', 'TRON', 'SOLANA');
CREATE TYPE "Token" AS ENUM ('ETH', 'BNB', 'TRX', 'SOL', 'USDT', 'USDC');
CREATE TYPE "PaymentStatus" AS ENUM ('DETECTED', 'CONFIRMED', 'SWEEPING', 'COMPLETED', 'FAILED');
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "WebhookEventType" AS ENUM ('PAYMENT_DETECTED', 'PAYMENT_CONFIRMED', 'PAYMENT_COMPLETED', 'PAYMENT_FAILED', 'WITHDRAWAL_COMPLETED', 'WITHDRAWAL_FAILED');

-- Clients
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "webhook_url" TEXT,
    "webhook_secret" TEXT,
    "fee_percent" DECIMAL(5,4) NOT NULL DEFAULT 1.0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "clients_email_key" ON "clients"("email");
CREATE UNIQUE INDEX "clients_api_key_key" ON "clients"("api_key");

-- User wallets — one per (clientId, userId, network) tuple
CREATE TABLE "user_wallets" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "address" TEXT NOT NULL,
    "hd_index" INTEGER NOT NULL,
    "encrypted_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_wallets_client_user_network_key" ON "user_wallets"("client_id", "user_id", "network");
CREATE UNIQUE INDEX "user_wallets_network_address_key" ON "user_wallets"("network", "address");
CREATE INDEX "user_wallets_client_id_idx" ON "user_wallets"("client_id");

-- Counter for HD index per network (monotonically increasing)
CREATE TABLE "user_wallet_counters" (
    "network" "Network" NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "user_wallet_counters_pkey" PRIMARY KEY ("network")
);

-- Payments
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_wallet_id" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "token" "Token" NOT NULL,
    "received_amount" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "fee_amount" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "fee_percent" DECIMAL(5,4) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'DETECTED',
    "tx_hash" TEXT NOT NULL,
    "sweep_tx_hash" TEXT,
    "confirmations" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payments_tx_hash_key" ON "payments"("tx_hash");
CREATE INDEX "payments_client_id_idx" ON "payments"("client_id");
CREATE INDEX "payments_user_id_idx" ON "payments"("user_id");
CREATE INDEX "payments_status_idx" ON "payments"("status");
CREATE INDEX "payments_network_status_idx" ON "payments"("network", "status");
CREATE INDEX "payments_user_wallet_id_idx" ON "payments"("user_wallet_id");

-- Withdrawals
CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "network" "Network" NOT NULL,
    "token" "Token" NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "fee_amount" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "to_address" TEXT NOT NULL,
    "tx_hash" TEXT,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "fail_reason" TEXT,
    "client_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "withdrawals_client_id_idx" ON "withdrawals"("client_id");
CREATE INDEX "withdrawals_status_idx" ON "withdrawals"("status");

-- Webhook events
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "payment_id" TEXT,
    "withdrawal_id" TEXT,
    "event_type" "WebhookEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_retry_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_events_client_id_idx" ON "webhook_events"("client_id");
CREATE INDEX "webhook_events_delivery_idx" ON "webhook_events"("delivered_at", "next_retry_at");

-- Foreign keys
ALTER TABLE "user_wallets"   ADD CONSTRAINT "user_wallets_client_id_fkey"     FOREIGN KEY ("client_id")      REFERENCES "clients"("id")       ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments"       ADD CONSTRAINT "payments_client_id_fkey"         FOREIGN KEY ("client_id")      REFERENCES "clients"("id")       ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments"       ADD CONSTRAINT "payments_user_wallet_id_fkey"    FOREIGN KEY ("user_wallet_id") REFERENCES "user_wallets"("id")  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals"    ADD CONSTRAINT "withdrawals_client_id_fkey"      FOREIGN KEY ("client_id")      REFERENCES "clients"("id")       ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_client_id_fkey"   FOREIGN KEY ("client_id")      REFERENCES "clients"("id")       ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_payment_id_fkey"  FOREIGN KEY ("payment_id")     REFERENCES "payments"("id")      ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id")  ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed wallet counters
INSERT INTO "user_wallet_counters" ("network", "count") VALUES ('ETH', 0), ('BSC', 0), ('TRON', 0), ('SOLANA', 0);
