import { Network, Token } from '@prisma/client';
import { BlockchainAdapter, TransactionInfo, SendTransactionParams } from '../../types';

export abstract class BaseAdapter implements BlockchainAdapter {
  abstract network: Network;

  abstract getBalance(address: string, token: Token): Promise<bigint>;
  abstract getTransaction(txHash: string): Promise<TransactionInfo | null>;
  abstract getLatestBlock(): Promise<number>;
  abstract sendTransaction(params: SendTransactionParams): Promise<string>;
  abstract isValidAddress(address: string): boolean;

  protected tokenDecimals(token: Token): number {
    switch (token) {
      case Token.ETH:
      case Token.BNB:
      case Token.SOL:
        return 18;
      case Token.TRX:
        return 6;
      case Token.USDT:
      case Token.USDC:
        return 6;
      default:
        return 18;
    }
  }

  toBaseUnits(amount: string, decimals: number): bigint {
    const [whole, frac = ''] = amount.split('.');
    const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(whole + fracPadded);
  }

  fromBaseUnits(amount: bigint, decimals: number): string {
    const str = amount.toString().padStart(decimals + 1, '0');
    const whole = str.slice(0, -decimals) || '0';
    const frac = str.slice(-decimals).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  }
}
