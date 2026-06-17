#!/usr/bin/env node
'use strict';

/**
 * CryptoGateway Initial Setup
 *
 * Generates all sensitive credentials and collects master-wallet
 * addresses/keys for each network.
 *
 * NOTE: fee wallet is NOT separate — the full swept amount arrives at the
 * master wallet and the commission is recorded in the database.
 */

const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const bip39    = require('bip39');

const ENV_PATH = path.join(__dirname, '..', '.env');

// ── CLI helpers ───────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
  return new Promise(resolve => rl.question(prompt, ans => resolve(ans.trim())));
}

const L1 = '═'.repeat(62);
const L2 = '─'.repeat(62);

function banner(title) {
  console.log('\n' + L1);
  console.log('  ' + title);
  console.log(L1 + '\n');
}

function section(title) {
  console.log('\n' + L2);
  console.log('  ' + title);
  console.log(L2 + '\n');
}

// ── Patch .env key=value in-place (or append) ─────────────────────────────────

function patchEnv(envText, key, value) {
  const regex = new RegExp(`^${key}=.*`, 'm');
  return regex.test(envText)
    ? envText.replace(regex, `${key}=${value}`)
    : envText.trimEnd() + `\n${key}=${value}\n`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner('CRYPTOGATEWAY — ПЕРВОНАЧАЛЬНАЯ НАСТРОЙКА');
  console.log('  Скрипт генерирует системные секреты и собирает адреса');
  console.log('  мастер-кошельков для каждой сети.\n');
  console.log('  Запускайте только при первом развёртывании.');
  console.log('  Повторный запуск перезапишет секреты в .env.\n');
  await ask('  Нажмите ENTER чтобы начать...');

  // ─────────────────────────────────────────────────────────────────────────────
  // ШАГ 1 — системные секреты (генерируются автоматически)
  // ─────────────────────────────────────────────────────────────────────────────

  banner('ШАГ 1 / 3  —  Генерация системных секретов');

  const adminSecret = crypto.randomBytes(32).toString('hex');
  const encKey      = crypto.randomBytes(32).toString('hex');
  const mnemonic    = bip39.generateMnemonic(256); // 24 слова

  console.log('  ┌─ ADMIN_SECRET  (пароль к панели /admin/)\n');
  console.log('  │  ' + adminSecret + '\n');

  console.log('  ┌─ WALLET_ENCRYPTION_KEY  (шифрование приватных ключей депозитных кошельков)\n');
  console.log('  │  ' + encKey + '\n');

  console.log('  ┌─ MASTER_MNEMONIC  (BIP39, 24 слова — HD-кошелёк для генерации депозитных адресов)\n');
  console.log('  │  ' + mnemonic + '\n');

  console.log(L2);
  console.log('\n  !!! СОХРАНИТЕ ВСЁ ВЫШЕ ПРЕЖДЕ ЧЕМ ПРОДОЛЖИТЬ !!!');
  console.log('\n  • Потеря MASTER_MNEMONIC = невозможность восстановить депозитные');
  console.log('    адреса пользователей и получить доступ к их средствам.');
  console.log('  • Потеря WALLET_ENCRYPTION_KEY = невозможность расшифровать ключи');
  console.log('    в базе данных.');
  console.log('  • Потеря ADMIN_SECRET = нет доступа к панели администратора.');
  console.log('  • Ни одно из этих значений не будет показано повторно.\n');

  const ok1 = await ask('  Я сохранил все три значения. Продолжить? [yes]: ');
  if (!['', 'y', 'yes'].includes(ok1.toLowerCase())) {
    console.log('\n  Отменено. Запустите setup снова когда будете готовы.\n');
    rl.close(); return;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ШАГ 2 — мастер-кошельки
  // ─────────────────────────────────────────────────────────────────────────────

  banner('ШАГ 2 / 3  —  Мастер-кошельки');
  console.log('  Мастер-кошелёк — это ВАШ горячий кошелёк, на который автоматически');
  console.log('  переводятся (sweep) все поступившие средства после подтверждения платежа.\n');
  console.log('  Комиссия НЕ отправляется отдельно — она фиксируется в базе данных,');
  console.log('  а весь sweep поступает на мастер-кошелёк. Отдельного fee-адреса нет.\n');
  console.log('  Приватный ключ мастер-кошелька нужен только для оплаты газа при');
  console.log('  sweep-транзакциях. ETH и BSC могут использовать один и тот же 0x-адрес.\n');
  console.log('  Оставьте адрес пустым чтобы пропустить сеть.\n');

  const NETWORKS = [
    {
      label:   'ETH (Ethereum / Sepolia testnet)',
      addrKey: 'ETH_MASTER_ADDRESS',
      pkKey:   'ETH_MASTER_PRIVATE_KEY',
      addrHint: '0x + 40 hex',
      pkHint:   '0x + 64 hex',
    },
    {
      label:   'BSC (BNB Smart Chain)',
      addrKey: 'BSC_MASTER_ADDRESS',
      pkKey:   'BSC_MASTER_PRIVATE_KEY',
      addrHint: '0x + 40 hex  (можно тот же что ETH)',
      pkHint:   '0x + 64 hex',
    },
    {
      label:   'TRON',
      addrKey: 'TRON_MASTER_ADDRESS',
      pkKey:   'TRON_MASTER_PRIVATE_KEY',
      addrHint: 'T + 33 символа',
      pkHint:   '64 hex (без 0x)',
    },
    {
      label:   'SOLANA',
      addrKey: 'SOLANA_MASTER_ADDRESS',
      pkKey:   'SOLANA_MASTER_PRIVATE_KEY',
      addrHint: 'base58 pubkey',
      pkHint:   'base58 private key',
    },
  ];

  const walletUpdates = {};  // key → value; empty string = skip this key

  for (const net of NETWORKS) {
    section(net.label);
    const addr = await ask(`  Адрес мастер-кошелька (${net.addrHint}): `);

    if (!addr) {
      console.log('  → Пропущено — существующие значения в .env не изменятся.\n');
      continue;
    }

    const pk = await ask(`  Приватный ключ (${net.pkHint}): `);
    walletUpdates[net.addrKey] = addr;
    walletUpdates[net.pkKey]   = pk;
    console.log('  ✓ Сохранено в очередь записи.\n');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ШАГ 3 — запись в .env
  // ─────────────────────────────────────────────────────────────────────────────

  banner('ШАГ 3 / 3  —  Запись в .env');

  const keysToWrite = [
    'ADMIN_SECRET', 'WALLET_ENCRYPTION_KEY', 'MASTER_MNEMONIC',
    ...Object.keys(walletUpdates),
  ];
  console.log('  Будут обновлены следующие ключи:\n');
  for (const k of keysToWrite) console.log('    • ' + k);
  console.log();

  const ok3 = await ask('  Записать в .env? [yes]: ');
  if (!['', 'y', 'yes'].includes(ok3.toLowerCase())) {
    console.log('\n  Отменено. Файл .env не изменён.\n');
    rl.close(); return;
  }

  try {
    let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';

    env = patchEnv(env, 'ADMIN_SECRET',          adminSecret);
    env = patchEnv(env, 'WALLET_ENCRYPTION_KEY', encKey);
    env = patchEnv(env, 'MASTER_MNEMONIC',       mnemonic);

    for (const [key, value] of Object.entries(walletUpdates)) {
      env = patchEnv(env, key, value);
    }

    fs.writeFileSync(ENV_PATH, env, 'utf8');

    console.log('\n  [OK] .env успешно обновлён.');
    console.log('  Перезапустите сервер командой:\n');
    console.log('    npm start\n');
  } catch (err) {
    console.error('\n  [ОШИБКА] Не удалось записать .env:', err.message);
    console.error('\n  Добавьте значения вручную:');
    console.error(`    ADMIN_SECRET=${adminSecret}`);
    console.error(`    WALLET_ENCRYPTION_KEY=${encKey}`);
    console.error(`    MASTER_MNEMONIC=${mnemonic}`);
    for (const [k, v] of Object.entries(walletUpdates)) {
      console.error(`    ${k}=${v}`);
    }
    console.error();
  }

  rl.close();
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  rl.close();
  process.exit(1);
});
