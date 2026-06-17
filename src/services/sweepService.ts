import { Network, Token } from '@prisma/client';
import { prisma } from '../db';
import { getAdapter } from '../blockchain/adapters';
import { EvmAdapter } from '../blockchain/adapters/evm';
import { userWalletService } from './userWalletService';
import { paymentService } from './paymentService';
import { getSettings } from './settingsService';
import { config } from '../config';

// Conservative gas reserve per network (in native token smallest units).
// Covers 21 000 gas at up to ~15 gwei on ETH, with a safety buffer.
const GAS_RESERVE: Record<Network, bigint> = {
  [Network.ETH]:    400_000_000_000_000n, // 0.0004 ETH  (~15 gwei × 21 000 × 1.3)
  [Network.BSC]:     40_000_000_000_000n, // 0.00004 BNB
  [Network.TRON]:         8_000_000n,     // 8 TRX
  [Network.SOLANA]:      10_000n,         // 0.00001 SOL
};

const NATIVE_TOKEN: Record<Network, Token> = {
  [Network.ETH]:    Token.ETH,
  [Network.BSC]:    Token.BNB,
  [Network.TRON]:   Token.TRX,
  [Network.SOLANA]: Token.SOL,
};

export class SweepService {
  async sweepPayment(paymentId: string): Promise<void> {
    // Atomically claim the sweep right:
    //   • CONFIRMED → SWEEPING  : normal first attempt
    //   • SWEEPING + null tx    : retry after a failed sweep (tx was never broadcast)
    const claimed = await prisma.payment.updateMany({
      where: {
        id: paymentId,
        OR: [
          { status: 'CONFIRMED' },
          { status: 'SWEEPING', sweepTxHash: null },
        ],
      },
      data: { status: 'SWEEPING' },
    });

    if (claimed.count === 0) {
      // Another worker already owns this sweep, or payment reached a terminal state.
      return;
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { userWallet: true },
    });

    if (!payment) throw new Error(`Payment ${paymentId} not found after claim`);

    const adapter = getAdapter(payment.network);
    const masterAddress = config.masterWallets[payment.network];
    if (!masterAddress) throw new Error(`Master wallet not configured for ${payment.network}`);

    const wallet = payment.userWallet!;
    const decryptedKey = userWalletService.decryptKey(wallet.encryptedKey, wallet.network, wallet.hdIndex);
    const balance = await adapter.getBalance(wallet.address, payment.token);

    if (balance === 0n) throw new Error('Deposit wallet has zero balance');

    // For EVM native tokens: use live gas price to calculate exact reserve.
    // For others: fall back to the static table above.
    const gasReserve = await this.getGasReserve(payment.network, payment.token, adapter);

    const settings = await getSettings();
    const feePercent = Number(settings.feePercent);
    const feeAmount = (balance * BigInt(Math.round(feePercent * 100))) / 10000n;

    // Subtract both operator fee and gas from the sweep amount
    const isNative = NATIVE_TOKEN[payment.network] === payment.token;
    const sweepAmount = isNative
      ? balance - feeAmount - gasReserve
      : balance - feeAmount;

    if (sweepAmount <= 0n) {
      throw new Error(
        `Balance too low to sweep: balance=${balance}, fee=${feeAmount}, gasReserve=${gasReserve}`,
      );
    }

    await this.ensureGasIfNeeded(payment.network, payment.token, wallet.address);

    const txHash = await adapter.sendTransaction({
      fromPrivateKey: decryptedKey,
      toAddress: masterAddress,
      amount: sweepAmount,
      token: payment.token,
    });

    await prisma.payment.update({
      where: { id: paymentId },
      data: { sweepTxHash: txHash, feeAmount: feeAmount.toString() },
    });

    await paymentService.onSweepCompleted(paymentId, txHash, feeAmount);
  }

  // Returns the gas cost to reserve for a native-token sweep transaction.
  private async getGasReserve(
    network: Network,
    token: Token,
    adapter: ReturnType<typeof getAdapter>,
  ): Promise<bigint> {
    if (NATIVE_TOKEN[network] !== token) return 0n; // ERC-20 / SPL: gas paid separately

    if (network === Network.ETH || network === Network.BSC) {
      try {
        const provider = (adapter as EvmAdapter).getProvider();
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 15_000_000_000n;
        // 21 000 gas × price × 1.3 safety buffer
        const reserve = (21_000n * gasPrice * 13n) / 10n;
        return reserve;
      } catch {
        return GAS_RESERVE[network];
      }
    }

    return GAS_RESERVE[network];
  }

  private async ensureGasIfNeeded(
    network: Network,
    token: Token,
    depositAddress: string,
  ): Promise<void> {
    const nativeToken = NATIVE_TOKEN[network];
    if (token === nativeToken) return; // native sweep — no pre-funding needed

    const adapter = getAdapter(network);
    const nativeBalance = await adapter.getBalance(depositAddress, nativeToken);

    const minGas: Record<Network, bigint> = {
      [Network.ETH]:    5_000_000_000_000_000n, // 0.005 ETH
      [Network.BSC]:      500_000_000_000_000n, // 0.0005 BNB
      [Network.TRON]:           10_000_000n,    // 10 TRX
      [Network.SOLANA]:          5_000_000n,    // 0.005 SOL
    };

    if (nativeBalance >= minGas[network]) return;

    const masterKey = config.masterPrivateKeys[network];
    if (!masterKey) throw new Error(`Master private key not configured for ${network}`);

    await adapter.sendTransaction({
      fromPrivateKey: masterKey,
      toAddress: depositAddress,
      amount: minGas[network],
      token: nativeToken,
    });

    await new Promise((res) => setTimeout(res, 5000));
  }
}

export const sweepService = new SweepService();
