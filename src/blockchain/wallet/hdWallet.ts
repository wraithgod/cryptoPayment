import * as bip39 from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { ethers } from 'ethers';
import { createHash } from 'crypto';
import { derivePath } from 'ed25519-hd-key';
import * as nacl from 'tweetnacl';
import { Network } from '@prisma/client';
import { config } from '../../config';
import { KeystoreManager } from './keystore';
import bs58 from 'bs58';

const bip32 = BIP32Factory(ecc);

export interface DerivedWallet {
  address: string;
  privateKey: string;
  hdIndex: number;
  network: Network;
}

// BIP44 coin types
// ETH and BSC share coin type 60 but are differentiated by the account index
// to prevent key reuse across networks (same key = doubled blast radius on compromise)
const COIN_TYPES: Record<Network, number> = {
  [Network.ETH]: 60,
  [Network.BSC]: 60,
  [Network.TRON]: 195,
  [Network.SOLANA]: 501,
};

// Account index disambiguates ETH vs BSC within the same coin type 60
const ACCOUNT_INDEX: Partial<Record<Network, number>> = {
  [Network.ETH]: 0,
  [Network.BSC]: 1,
};

function aadFor(network: Network, hdIndex: number): string {
  return `operator:${network}:${hdIndex}`;
}

export class HdWalletManager {
  private seed: Buffer;
  private keystore: KeystoreManager;

  constructor() {
    if (!bip39.validateMnemonic(config.wallet.mnemonic)) {
      throw new Error('Invalid master mnemonic');
    }
    this.seed = bip39.mnemonicToSeedSync(config.wallet.mnemonic);
    this.keystore = new KeystoreManager(config.wallet.encryptionKey);
  }

  deriveWallet(network: Network, index: number): DerivedWallet {
    if (network === Network.SOLANA) return this.deriveSolanaWallet(index);
    if (network === Network.TRON) return this.deriveTronWallet(index);
    return this.deriveEvmWallet(network, index);
  }

  deriveUserWallet(network: Network, index: number): DerivedWallet {
    if (network === Network.SOLANA) return this.deriveSolanaUserWallet(index);
    if (network === Network.TRON) return this.deriveTronUserWallet(index);
    return this.deriveEvmUserWallet(network, index);
  }

  decryptPrivateKey(encryptedKey: string, network: Network, hdIndex: number): string {
    return this.keystore.decrypt(encryptedKey, aadFor(network, hdIndex));
  }

  private deriveEvmWallet(network: Network, index: number): DerivedWallet {
    const coinType = COIN_TYPES[network];
    const account = ACCOUNT_INDEX[network] ?? 0;
    const path = `m/44'/${coinType}'/${account}'/0/${index}`;
    const root = bip32.fromSeed(this.seed);
    const child = root.derivePath(path);
    if (!child.privateKey) throw new Error('Failed to derive private key');

    const privateKeyHex = '0x' + child.privateKey.toString('hex');
    const wallet = new ethers.Wallet(privateKeyHex);

    return {
      address: wallet.address,
      privateKey: this.keystore.encrypt(privateKeyHex, aadFor(network, index)),
      hdIndex: index,
      network,
    };
  }

  private deriveEvmUserWallet(network: Network, index: number): DerivedWallet {
    const coinType = COIN_TYPES[network];
    const account = ACCOUNT_INDEX[network] ?? 0;
    // change=1 separates user wallets from pool wallets
    const path = `m/44'/${coinType}'/${account}'/1/${index}`;
    const root = bip32.fromSeed(this.seed);
    const child = root.derivePath(path);
    if (!child.privateKey) throw new Error('Failed to derive private key');

    const privateKeyHex = '0x' + child.privateKey.toString('hex');
    const wallet = new ethers.Wallet(privateKeyHex);

    return {
      address: wallet.address,
      privateKey: this.keystore.encrypt(privateKeyHex, aadFor(network, index)),
      hdIndex: index,
      network,
    };
  }

  private deriveTronWallet(index: number): DerivedWallet {
    const path = `m/44'/195'/0'/0/${index}`;
    const root = bip32.fromSeed(this.seed);
    const child = root.derivePath(path);
    if (!child.privateKey) throw new Error('Failed to derive TRON private key');

    const privateKeyHex = child.privateKey.toString('hex');
    const ethWallet = new ethers.Wallet('0x' + privateKeyHex);
    const tronAddress = this.ethToTronAddress(ethWallet.address);

    return {
      address: tronAddress,
      privateKey: this.keystore.encrypt(privateKeyHex, aadFor(Network.TRON, index)),
      hdIndex: index,
      network: Network.TRON,
    };
  }

  private deriveTronUserWallet(index: number): DerivedWallet {
    const path = `m/44'/195'/0'/1/${index}`;
    const root = bip32.fromSeed(this.seed);
    const child = root.derivePath(path);
    if (!child.privateKey) throw new Error('Failed to derive TRON private key');

    const privateKeyHex = child.privateKey.toString('hex');
    const ethWallet = new ethers.Wallet('0x' + privateKeyHex);
    const tronAddress = this.ethToTronAddress(ethWallet.address);

    return {
      address: tronAddress,
      privateKey: this.keystore.encrypt(privateKeyHex, aadFor(Network.TRON, index)),
      hdIndex: index,
      network: Network.TRON,
    };
  }

  private deriveSolanaWallet(index: number): DerivedWallet {
    const path = `m/44'/501'/${index}'/0'`;
    const { key } = derivePath(path, this.seed.toString('hex'));
    const keypair = nacl.sign.keyPair.fromSeed(key);

    const publicKey = bs58.encode(Buffer.from(keypair.publicKey));
    const privateKeyHex = Buffer.from(keypair.secretKey).toString('hex');

    return {
      address: publicKey,
      privateKey: this.keystore.encrypt(privateKeyHex, aadFor(Network.SOLANA, index)),
      hdIndex: index,
      network: Network.SOLANA,
    };
  }

  private deriveSolanaUserWallet(index: number): DerivedWallet {
    const path = `m/44'/501'/${index}'/1'`;
    const { key } = derivePath(path, this.seed.toString('hex'));
    const keypair = nacl.sign.keyPair.fromSeed(key);

    const publicKey = bs58.encode(Buffer.from(keypair.publicKey));
    const privateKeyHex = Buffer.from(keypair.secretKey).toString('hex');

    return {
      address: publicKey,
      privateKey: this.keystore.encrypt(privateKeyHex, aadFor(Network.SOLANA, index)),
      hdIndex: index,
      network: Network.SOLANA,
    };
  }

  private ethToTronAddress(ethAddress: string): string {
    const addressBytes = Buffer.from('41' + ethAddress.slice(2), 'hex');
    const checksum = this.tronChecksum(addressBytes);
    const fullAddress = Buffer.concat([addressBytes, checksum]);
    return bs58.encode(fullAddress);
  }

  private tronChecksum(payload: Buffer): Buffer {
    const hash1 = createHash('sha256').update(payload).digest();
    const hash2 = createHash('sha256').update(hash1).digest();
    return hash2.slice(0, 4);
  }
}

export const hdWallet = new HdWalletManager();
