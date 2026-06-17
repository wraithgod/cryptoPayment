import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { Network, Token } from '@prisma/client';
import { BaseAdapter } from './base';
import { TransactionInfo, SendTransactionParams } from '../../types';
import { config, TOKEN_CONTRACTS } from '../../config';
import bs58 from 'bs58';

// Addresses that must never be used as withdrawal targets
const SOLANA_RESERVED_ADDRESSES = new Set([
  '11111111111111111111111111111111',           // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bVU', // Associated Token Program
  'SysvarRent111111111111111111111111111111111',  // Rent Sysvar
  'SysvarC1ock11111111111111111111111111111111',  // Clock Sysvar
]);

export class SolanaAdapter extends BaseAdapter {
  network = Network.SOLANA;
  private connection: Connection;

  private static readonly SEND_TIMEOUT_MS = 60_000;

  constructor() {
    super();
    this.connection = new Connection(config.rpc.solana, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: SolanaAdapter.SEND_TIMEOUT_MS,
    });
  }

  private withTimeout<T>(promise: Promise<T>, ms = SolanaAdapter.SEND_TIMEOUT_MS): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Solana RPC timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  async getBalance(address: string, token: Token): Promise<bigint> {
    const pubkey = new PublicKey(address);

    if (token === Token.SOL) {
      const balance = await this.connection.getBalance(pubkey);
      return BigInt(balance);
    }

    const mintAddress = TOKEN_CONTRACTS[Network.SOLANA]?.[token];
    if (!mintAddress) throw new Error(`No mint for ${token} on Solana`);

    const mint = new PublicKey(mintAddress);
    const ata = await getAssociatedTokenAddress(mint, pubkey);

    try {
      const accountInfo = await this.connection.getTokenAccountBalance(ata);
      return BigInt(accountInfo.value.amount);
    } catch {
      return 0n;
    }
  }

  async getTransaction(txHash: string): Promise<TransactionInfo | null> {
    try {
      const tx = await this.connection.getParsedTransaction(txHash, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) return null;

      const slot = tx.slot;
      const currentSlot = await this.connection.getSlot('confirmed');
      const confirmations = Math.max(0, currentSlot - slot);

      const meta = tx.meta;
      const from = tx.transaction.message.accountKeys[0].pubkey.toBase58();
      const to = tx.transaction.message.accountKeys[1]?.pubkey.toBase58() ?? '';
      const preBalance = meta?.preBalances[1] ?? 0;
      const postBalance = meta?.postBalances[1] ?? 0;
      const value = BigInt(Math.max(0, postBalance - preBalance));

      return {
        hash: txHash,
        from,
        to,
        value,
        blockNumber: slot,
        confirmations,
        status: meta?.err ? 'failed' : 'success',
      };
    } catch {
      return null;
    }
  }

  async getLatestBlock(): Promise<number> {
    return this.connection.getSlot('confirmed');
  }

  async sendTransaction(params: SendTransactionParams): Promise<string> {
    const secretKeyBytes = Buffer.from(params.fromPrivateKey, 'hex');
    const keypair = Keypair.fromSecretKey(secretKeyBytes);

    if (params.token === Token.SOL) {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(params.toAddress),
          lamports: params.amount,
        }),
      );
      return this.withTimeout(sendAndConfirmTransaction(this.connection, tx, [keypair]));
    }

    const mintAddress = TOKEN_CONTRACTS[Network.SOLANA]?.[params.token];
    if (!mintAddress) throw new Error(`No mint for ${params.token} on Solana`);

    const mint = new PublicKey(mintAddress);
    const toPubkey = new PublicKey(params.toAddress);

    const fromAta = await getOrCreateAssociatedTokenAccount(this.connection, keypair, mint, keypair.publicKey);
    const toAta = await getOrCreateAssociatedTokenAccount(this.connection, keypair, mint, toPubkey);

    const tx = new Transaction().add(
      createTransferInstruction(fromAta.address, toAta.address, keypair.publicKey, params.amount),
    );
    return this.withTimeout(sendAndConfirmTransaction(this.connection, tx, [keypair]));
  }

  isValidAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return !SOLANA_RESERVED_ADDRESSES.has(address);
    } catch {
      return false;
    }
  }

  // Scan recent confirmed signatures and return incoming transfers.
  // Uses `before` for backwards pagination rather than `until` (which would
  // stop at the known signature and miss all newer ones).
  async scanSignatures(
    address: string,
    token: Token,
    since?: string,
  ): Promise<Array<{ txHash: string; from: string; amount: bigint; slot: number }>> {
    const pubkey = new PublicKey(address);
    // Fetch the latest batch; caller deduplicates by txHash in the DB
    const options: { limit: number; before?: string } = { limit: 50 };
    if (since) options.before = since;

    if (token === Token.SOL) {
      const sigs = await this.connection.getSignaturesForAddress(pubkey, options);
      const results = [];
      for (const sig of sigs) {
        const tx = await this.connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta || tx.meta.err) continue;
        const accountIdx = tx.transaction.message.accountKeys.findIndex(
          (k) => k.pubkey.toBase58() === address,
        );
        if (accountIdx < 0) continue;
        const diff = (tx.meta.postBalances[accountIdx] ?? 0) - (tx.meta.preBalances[accountIdx] ?? 0);
        if (diff > 0) {
          results.push({
            txHash: sig.signature,
            from: tx.transaction.message.accountKeys[0].pubkey.toBase58(),
            amount: BigInt(diff),
            slot: tx.slot,
          });
        }
      }
      return results;
    }

    const mintAddress = TOKEN_CONTRACTS[Network.SOLANA]?.[token];
    if (!mintAddress) return [];
    const mint = new PublicKey(mintAddress);
    const ata = await getAssociatedTokenAddress(mint, pubkey);

    try {
      const sigs = await this.connection.getSignaturesForAddress(ata, options);
      const results = [];
      for (const sig of sigs) {
        const tx = await this.connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        }) as ParsedTransactionWithMeta | null;
        if (!tx?.meta || tx.meta.err) continue;
        const ataStr = ata.toBase58();
        const tokenBalance = (tx.meta.postTokenBalances ?? []).find(
          (b) => b.accountIndex === tx.transaction.message.accountKeys.findIndex(
            (k) => k.pubkey.toBase58() === ataStr,
          ),
        );
        const preBalance = (tx.meta.preTokenBalances ?? []).find(
          (b) => b.accountIndex === tx.transaction.message.accountKeys.findIndex(
            (k) => k.pubkey.toBase58() === ataStr,
          ),
        );
        const post = BigInt(tokenBalance?.uiTokenAmount?.amount ?? 0);
        const pre = BigInt(preBalance?.uiTokenAmount?.amount ?? 0);
        if (post > pre) {
          results.push({
            txHash: sig.signature,
            from: tx.transaction.message.accountKeys[0].pubkey.toBase58(),
            amount: post - pre,
            slot: tx.slot,
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}

export const solanaAdapter = new SolanaAdapter();
