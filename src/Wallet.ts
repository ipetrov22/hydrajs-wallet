import * as bip38 from "bip38"
import * as wif from "wif"

import { ECPair, HDNode, In } from "bitcoinjs-lib"

import { INetworkInfo } from "./Network"
import { Insight } from "./Insight"
import {
  buildSendToContractTransaction,
  buildPubKeyHashTransaction,
  IUTXO,
  IContractSendTXOptions,
  ISendTxOptions,
  buildCreateContractTransaction,
  IContractCreateTXOptions,
  estimatePubKeyHashTransactionMaxSend,
  estimateSendToContractTransactionMaxValue,
} from "./tx"

import { params, IScryptParams } from "./scrypt"

/**
 * The default relay fee rate (per byte) if network cannot estimate how much to use.
 *
 * This value will be used for testnet.
 */
const defaultTxFeePerByte = Math.ceil((2.222222 * 1e8) / 1024)

export class Wallet {
  public address: string
  private insight: Insight

  constructor(public keyPair: ECPair, public network: INetworkInfo) {
    this.address = this.keyPair.getAddress()
    this.insight = Insight.forNetwork(this.network)
  }

  public toWIF(): string {
    return this.keyPair.toWIF()
  }

  /**
   * Get basic information about the wallet address.
   */
  public async getInfo(): Promise<Insight.IGetInfo> {
    return this.insight.getInfo(this.address)
  }

  public async getUTXOs(): Promise<Insight.IUTXO[]> {
    return this.insight.listUTXOs(this.address)
  }

  /**
   * Get information about the balance history of an address
   */
  public async getBalanceHistory(): Promise<Insight.IBalanceHistory[]> {
    return this.insight.getAddressBalanceHistory(this.address)
  }

  public async getTokenBalanceHistory(token: string): Promise<Insight.ITokenBalanceHistory[]> {
    return this.insight.getAddressTokenBalanceHistory(this.address, token)
  }

  /**
   * get transactions by wallet address
   * @param pageNum page number
   */
  public async getTransactions(
    pageNum?: number,
  ): Promise<Insight.IRawTransactions> {
    return this.insight.getTransactions(this.address)
  }

  public async getTransactionInfo(
    id: string,
  ): Promise<Insight.IRawTransactionInfo> {
    return this.insight.getTransactionInfo(id)
  }

  /**
   * bip38 encrypted wip
   * @param passphrase
   * @param params scryptParams
   */
  public toEncryptedPrivateKey(
    passphrase: string,
    scryptParams: IScryptParams = params.bip38,
  ): string {
    const { privateKey, compressed } = wif.decode(this.toWIF())

    return bip38.encrypt(
      privateKey,
      compressed,
      passphrase,
      undefined,
      scryptParams,
    )
  }

  /**
   * Generate and sign a payment transaction.
   *
   * @param to The receiving address
   * @param amount The amount to transfer (in satoshi)
   * @param opts
   *
   * @returns The raw transaction as hexadecimal string
   */
  public async generateTx(
    to: string,
    amount: number,
    opts: ISendTxOptions = {},
  ): Promise<string> {
    const utxos = await this.getBitcoinjsUTXOs()
    const infoRes = await this.insight.getBlockchainInfo()
    const feeRate = Math.ceil(infoRes.feeRate * 1e5);

    return buildPubKeyHashTransaction(utxos, this.keyPair, to, amount, feeRate)
  }

  /**
   * Estimate the maximum value that could be sent from this wallet address.
   *
   * @param to The receiving address
   * @param opts
   *
   * @returns satoshi
   */
  public async sendEstimateMaxValue(
    to: string,
    opts: ISendTxOptions = {},
  ): Promise<number> {
    const utxos = await this.getBitcoinjsUTXOs()

    const infoRes = await this.insight.getBlockchainInfo()
    const feeRate = Math.ceil(infoRes.feeRate * 1e5);

    return estimatePubKeyHashTransactionMaxSend(utxos, to, feeRate)
  }

  /**
   * Send payment to a receiving address. The transaction is signed locally
   * using the wallet's private key, and the raw transaction submitted to a
   * remote API (without revealing the wallet's secret).
   *
   * @param to The receiving address
   * @param amount The amount to transfer (in satoshi)
   * @param opts
   * @return The raw transaction as hexadecimal string
   */
  public async send(
    to: string,
    amount: number,
    opts: ISendTxOptions = {},
  ): Promise<Insight.ISendRawTxResult> {
    const rawtx = await this.generateTx(to, amount, opts)
    return this.sendRawTx(rawtx)
  }

  /**
   * Submit a signed raw transaction to the network.
   *
   * @param rawtx Hex encoded raw transaction data.
   */
  public async sendRawTx(rawtx: string): Promise<Insight.ISendRawTxResult> {
    return this.insight.sendRawTx(rawtx)
  }

  /**
   * Generate a raw a send-to-contract transaction that invokes a contract's method.
   *
   * @param contractAddress
   * @param encodedData
   * @param opts
   */
  public async generateContractSendTx(
    contractAddress: string,
    encodedData: string,
    opts: IContractSendTXOptions = {},
  ): Promise<string> {
    const utxos = await this.getBitcoinjsUTXOs()

    const infoRes = await this.insight.getBlockchainInfo()
    const feeRate = Math.ceil(infoRes.feeRate * 1e5);

    // TODO: estimate the precise gasLimit

    return await buildSendToContractTransaction(
      utxos,
      this.keyPair,
      contractAddress,
      encodedData,
      feeRate,
      opts,
      this.network
    )
  }

  /**
   * Query a contract's method. It returns the result and logs of a simulated
   * execution of the contract's code.
   *
   * @param contractAddress Address of the contract in hexadecimal
   * @param encodedData The ABI encoded method call, and parameter values.
   * @param opts
   */
  public async contractCall(
    contractAddress: string,
    encodedData: string,
    opts: IContractSendTXOptions = {},
  ): Promise<Insight.IContractCall> {
    return this.insight.contractCall(contractAddress, encodedData, opts)
  }

  /**
   * Create a send-to-contract transaction that invokes a contract's method.
   *
   * @param contractAddress Address of the contract in hexadecimal
   * @param encodedData The ABI encoded method call, and parameter values.
   * @param opts
   */
  public async contractSend(
    contractAddress: string,
    encodedData: string,
    opts: IContractSendTXOptions = {},
  ): Promise<Insight.ISendRawTxResult> {
    const rawTx = await this.generateContractSendTx(
      contractAddress,
      encodedData,
      opts,
    )
    return this.sendRawTx(rawTx)
  }

  /**
   * Estimate the maximum value that could be sent to a contract, substracting the amount reserved for gas.
   *
   * @param contractAddress Address of the contract in hexadecimal
   * @param encodedData The ABI encoded method call, and parameter values.
   * @param opts
   *
   * @returns satoshi
   */
  public async contractSendEstimateMaxValue(
    contractAddress: string,
    encodedData: string,
    opts: IContractSendTXOptions = {},
  ): Promise<number> {
    const utxos = await this.getBitcoinjsUTXOs()

    const infoRes = await this.insight.getBlockchainInfo()
    const feeRate = Math.ceil(infoRes.feeRate * 1e5);

    // TODO: estimate the precise gasLimit

    return await estimateSendToContractTransactionMaxValue(
      utxos,
      this.keyPair,
      contractAddress,
      encodedData,
      feeRate,
      opts,
      this.network
    )
  }

  /**
   * Massage UTXOs returned by the Insight API to UTXO format accepted by the
   * underlying hydrajs-lib.
   */
  public async getBitcoinjsUTXOs(): Promise<IUTXO[]> {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const utxos = (await this.getUTXOs()).filter(e => e.confirmations >= 2000 || e.isStake == false)
    // FIXME: Generating another raw tx before the previous tx had be mined
    // could cause overlapping UXTOs to be used.

    // FIXME: make the two compatible...
    // massage UXTO to format accepted by bitcoinjs
    const bitcoinjsUTXOs: IUTXO[] = utxos.map((utxo) => ({
      ...utxo,
      pos: utxo.outputIndex,
      value: Number(utxo.value),
      hash: utxo.transactionId,
    }))

    return bitcoinjsUTXOs
  }

  /**
   * The BIP32 HDNode, which may be used to derive new key pairs
   */
  public hdnode(): HDNode {
    const seed = this.keyPair.getPublicKeyBuffer()
    const hdnode = HDNode.fromSeedBuffer(seed, this.network)!
    return hdnode
  }

  /**
   * Use BIP32 to derive child wallets from the current wallet's keypair.
   * @param n The index of the child wallet to derive.
   */
  public deriveChildWallet(n = 0): Wallet {
    const childKeyPair = this.hdnode().deriveHardened(n).keyPair
    return new Wallet(childKeyPair, this.network)
  }

  public async contractCreate(
    code: string,
    opts: IContractCreateTXOptions = {},
  ): Promise<Insight.ISendRawTxResult> {
    const rawTx = await this.generateCreateContractTx(code, opts)
    return this.sendRawTx(rawTx)
  }

  public async generateCreateContractTx(
    code: string,
    opts: IContractCreateTXOptions = {},
  ): Promise<string> {
    const utxos = await this.getBitcoinjsUTXOs()

    const infoRes = await this.insight.getBlockchainInfo()
    const feeRate = Math.ceil(infoRes.feeRate * 1e5);

    // TODO: estimate the precise gasLimit

    return await buildCreateContractTransaction(
      utxos,
      this.keyPair,
      code,
      feeRate,
      opts,
      this.network
    )
  }

  // TODO
  // hrc20 lookup
  // estimateCall
}
