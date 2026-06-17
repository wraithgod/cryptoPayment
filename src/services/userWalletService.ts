import { Network } from '@prisma/client';
import { prisma } from '../db';
import { hdWallet } from '../blockchain/wallet/hdWallet';

export class UserWalletService {
  async getOrCreate(userId: string, network: Network) {
    const existing = await prisma.userWallet.findUnique({
      where: { userId_network: { userId, network } },
    });
    if (existing) return existing;

    return prisma.$transaction(async (tx) => {
      const counter = await tx.userWalletCounter.upsert({
        where: { network },
        update: { count: { increment: 1 } },
        create: { network, count: 1 },
      });

      const derived = hdWallet.deriveUserWallet(network, counter.count);

      return tx.userWallet.create({
        data: {
          userId,
          network,
          address: derived.address,
          hdIndex: derived.hdIndex,
          encryptedKey: derived.privateKey,
        },
      });
    });
  }

  // AAD binds decryption to the specific wallet — prevents key-swap attack
  decryptKey(encryptedKey: string, network: Network, hdIndex: number): string {
    return hdWallet.decryptPrivateKey(encryptedKey, network, hdIndex);
  }
}

export const userWalletService = new UserWalletService();
