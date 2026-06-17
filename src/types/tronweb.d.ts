declare module 'tronweb' {
  class TronWeb {
    constructor(options: {
      fullHost: string;
      headers?: Record<string, string>;
      privateKey?: string;
    });
    trx: {
      getBalance(address: string): Promise<number>;
      sendTransaction(to: string, amount: string): Promise<{ txid: string }>;
      getTransaction(txHash: string): Promise<unknown>;
      getTransactionInfo(txHash: string): Promise<{
        blockNumber?: number;
        receipt?: { result?: string };
      }>;
      getCurrentBlock(): Promise<{
        block_header?: { raw_data?: { number?: number } };
      }>;
    };
    contract(abi: unknown[], address: string): Promise<{
      balanceOf(address: string): { call(): Promise<{ toString(): string }> };
      transfer(to: string, amount: string): {
        send(options: { feeLimit: number; callValue: number }): Promise<string>;
      };
    }>;
    address: {
      fromHex(hex: string): string;
      toHex(address: string): string;
    };
    setAddress(address: string): void;
    setPrivateKey(key: string): void;
    isAddress(address: string): boolean;
  }
  export = TronWeb;
}
