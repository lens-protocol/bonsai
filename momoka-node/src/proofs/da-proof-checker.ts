import { Deployment, Environment } from '../common/environment';
import { LogFunctionType } from '../common/logger';
import {
  PromiseResult,
  PromiseWithContextResult,
  PromiseWithContextResultOrNull,
  failure,
  failureWithContext,
  success,
} from '../data-availability-models/da-result';
import { MomokaActionTypes } from '../data-availability-models/data-availability-action-types';
import {
  DAPublicationWithTimestampProofsBatchResult,
  DATimestampProofsResponse,
} from '../data-availability-models/data-availability-timestamp-proofs';
import { DAStructurePublication } from '../data-availability-models/publications/data-availability-structure-publication';
import { MomokaValidatorError } from '../data-availability-models/validator-errors';
import { BlockInfo, EthereumNode } from '../evm/ethereum';
import { TIMEOUT_ERROR, TimeoutError } from '../input-output/common';
import { TxValidatedFailureResult, TxValidatedResult } from '../input-output/tx-validated-results';
import { isValidSubmitter } from '../submitters';
import {
  CheckDASubmissionOptions,
  getDefaultCheckDASubmissionOptions,
} from './models/check-da-submisson-options';
import { checkDAComment } from './publications/comment';
import { checkDAMirror } from './publications/mirror';
import { checkDAPost } from './publications/post';
import { getClosestBlock, isValidEventTimestamp, isValidTypedDataDeadlineTimestamp } from './utils';
import { createDAPublicationVerifier } from './publications/create-da-publication-verifier';
import { checkDAQuote } from './publications/quote';

const validResult = 'valid';
type ValidType = typeof validResult;

export interface DAProofsVerifier {
  extractAddress(daPublication: DAStructurePublication): Promise<string>;

  /**
   * Check if bundlr timestamp proofs are valid and verified against bundlr node
   */
  verifyTimestampSignature(daPublication: DAStructurePublication): Promise<boolean>;

  /**
   * Checks if the given Arweave transaction was submitted by a valid submitter for the specified environment.
   * @param environment The environment to check against.
   * @param txId The Arweave transaction ID to check the submitter of.
   * @param log A logging function to use for outputting log messages.
   * @param deployment The deployment to check against.
   * @returns A Promise that resolves to true if the submitter is valid, false if it is not valid, or a TimeoutError if the request timed out.
   */
  verifyTransactionSubmitter(
    environment: Environment,
    txId: string,
    log: LogFunctionType,
    deployment?: Deployment
  ): Promise<boolean | TimeoutError>;
}

export interface DAProofsGateway {
  getTxResultFromCache(txId: string): Promise<TxValidatedResult | null>;
  getDaPublication(txId: string): Promise<DAStructurePublication | TimeoutError | null>;
  getTimestampProofs(
    timestampId: string,
    txId: string
  ): Promise<DATimestampProofsResponse | TimeoutError | null>;
  getBlockRange(blockNumbers: number[], ethereumNode: EthereumNode): Promise<BlockInfo[]>;
  hasSignatureBeenUsedBefore(signature: string): Promise<boolean>;
}

export class DaProofChecker {
  constructor(private verifier: DAProofsVerifier, private gateway: DAProofsGateway) {}

  /**
   * Checks a data availability proof with metadata, including the timestamp proofs and transaction ID.
   * If the proof has already been checked, returns the previous result.
   * If the submitter is invalid, returns an error.
   * Otherwise, runs the internal proof check and returns the result.
   * @param txId The transaction ID associated with the proof.
   * @param daPublicationWithTimestampProofs The data availability publication with associated timestamp proofs.
   * @param ethereumNode The Ethereum node to use for validation.
   * @param options Optional options for the check, including logging and pointer verification.
   * @returns A context result with the validated publication, or an error if validation fails.
   */

  public checkDAProofWithMetadata = async (
    txId: string,
    daPublicationWithTimestampProofs: DAPublicationWithTimestampProofsBatchResult,
    ethereumNode: EthereumNode,
    options: CheckDASubmissionOptions = getDefaultCheckDASubmissionOptions
  ): PromiseWithContextResult<DAStructurePublication, DAStructurePublication> => {
    if (!options.byPassDb) {
      const alreadyChecked = await this.txAlreadyChecked(txId, options.log);
      if (alreadyChecked) {
        return alreadyChecked;
      }

      const signatureAlreadyUsed = await this.gateway.hasSignatureBeenUsedBefore(
        daPublicationWithTimestampProofs.daPublication.chainProofs.thisPublication.signature
      );
      if (signatureAlreadyUsed) {
        return failureWithContext(
          MomokaValidatorError.CHAIN_SIGNATURE_ALREADY_USED,
          daPublicationWithTimestampProofs.daPublication
        );
      }
    }

    if (
      !isValidSubmitter(
        ethereumNode.environment,
        daPublicationWithTimestampProofs.submitter,
        ethereumNode.deployment
      )
    ) {
      return failureWithContext(
        MomokaValidatorError.TIMESTAMP_PROOF_NOT_SUBMITTER,
        daPublicationWithTimestampProofs.daPublication
      );
    }

    return await this._checkDAProof(
      daPublicationWithTimestampProofs.daPublication,
      daPublicationWithTimestampProofs.timestampProofsData,
      ethereumNode,
      options
    );
  };

  /**
   * Validates a data availability proof of a given transaction on the Arweave network, including the timestamp proofs.
   * @param txId The transaction ID to check.
   * @param ethereumNode The Ethereum node to use to validate the data availability proof.
   * @param options The options for validating the data availability proof.
   * @returns A `Promise` that resolves to a `PromiseResult` containing the validated data availability proof, or `void` if the validation fails.
   */
  public checkDAProof = async (
    txId: string,
    ethereumNode: EthereumNode,
    options: CheckDASubmissionOptions = getDefaultCheckDASubmissionOptions
  ): PromiseWithContextResult<DAStructurePublication | void, DAStructurePublication> => {
    if (!options.byPassDb) {
      const alreadyChecked = await this.txAlreadyChecked(txId, options.log);
      if (alreadyChecked) {
        return alreadyChecked;
      }
    }

    txId = txId.replace('ar://', ''); // pointers have the ar prefix!

    options.log(`Checking the submission`);

    const daPublication = await this.gateway.getDaPublication(txId);

    if (!daPublication) {
      return failureWithContext(MomokaValidatorError.INVALID_TX_ID, undefined as any);
    }
    if (daPublication === TIMEOUT_ERROR) {
      return failureWithContext(MomokaValidatorError.CAN_NOT_CONNECT_TO_BUNDLR, undefined as any);
    }

    const timestampProofsPayload = await this.gateway.getTimestampProofs(
      daPublication.timestampProofs.response.id,
      txId
    );

    if (!timestampProofsPayload) {
      return failureWithContext(MomokaValidatorError.INVALID_TX_ID, undefined as any);
    }
    if (timestampProofsPayload === TIMEOUT_ERROR) {
      return failureWithContext(MomokaValidatorError.CAN_NOT_CONNECT_TO_BUNDLR, undefined as any);
    }

    const timestampProofsSubmitter = await this.verifier.verifyTransactionSubmitter(
      ethereumNode.environment,
      daPublication.timestampProofs.response.id,
      options.log,
      ethereumNode.deployment
    );
    if (timestampProofsSubmitter === TIMEOUT_ERROR) {
      return failureWithContext(MomokaValidatorError.CAN_NOT_CONNECT_TO_BUNDLR, undefined as any);
    }
    if (!timestampProofsSubmitter) {
      return failureWithContext(MomokaValidatorError.TIMESTAMP_PROOF_NOT_SUBMITTER, daPublication);
    }
    options.log('timestamp proof valid submitter');

    return await this._checkDAProof(daPublication, timestampProofsPayload, ethereumNode, options);
  };

  /**
   * Validates the timestamp proofs and signatures of a given publication
   * against the timestampProofs and ethereumNode parameters.
   * @param daPublication The publication to validate.
   * @param timestampProofs The timestamp proofs to validate the publication against.
   * @param ethereumNode The Ethereum node to validate the publication against.
   * @param options The optional parameters to use when checking the publication.
   * @returns A promise with the result of the validation.
   */
  private _checkDAProof = async (
    daPublication: DAStructurePublication,
    timestampProofs: DATimestampProofsResponse,
    ethereumNode: EthereumNode,
    { log, byPassDb, verifyPointer }: CheckDASubmissionOptions
  ): PromiseWithContextResult<DAStructurePublication, DAStructurePublication> => {
    if (!daPublication.signature) {
      return failureWithContext(MomokaValidatorError.NO_SIGNATURE_SUBMITTER, daPublication);
    }

    if (!(await this.isValidSignatureSubmitter(daPublication, ethereumNode, log))) {
      return failureWithContext(MomokaValidatorError.INVALID_SIGNATURE_SUBMITTER, daPublication);
    }

    const timestampProofsResult = await this.validatesTimestampProof(
      daPublication,
      timestampProofs,
      log
    );
    if (timestampProofsResult !== validResult) {
      return failureWithContext(timestampProofsResult, daPublication);
    }

    if (!isValidEventTimestamp(daPublication)) {
      log('event timestamp does not match the publication timestamp');
      // the event emitted must match the same timestamp as the block number
      return failureWithContext(MomokaValidatorError.INVALID_EVENT_TIMESTAMP, daPublication);
    }

    if (!isValidTypedDataDeadlineTimestamp(daPublication)) {
      log('typed data timestamp does not match the publication timestamp');
      // the event emitted must match the same timestamp as the block number
      return failureWithContext(
        MomokaValidatorError.INVALID_TYPED_DATA_DEADLINE_TIMESTAMP,
        daPublication
      );
    }

    log('event timestamp matches publication timestamp');

    const validateBlockResult = await this.validateChosenBlock(
      daPublication.chainProofs.thisPublication.blockNumber,
      daPublication.timestampProofs.response.timestamp,
      ethereumNode,
      log
    );

    if (validateBlockResult.isFailure()) {
      return failureWithContext(validateBlockResult.failure, daPublication);
    }

    log('event timestamp matches up the on chain block timestamp');

    const daResult = await this.checkDAPublication(
      daPublication,
      ethereumNode,
      {
        log,
        byPassDb,
        verifyPointer,
      },
      log
    );

    if (daResult.isFailure()) {
      return failureWithContext(daResult.failure, daPublication);
    }

    return success(daPublication);
  };

  /**
   * Checks if the signature submitter is valid.
   * @param daPublication - The publication to check.
   * @param ethereumNode - The Ethereum node to use.
   * @param log - The logging function to use.
   * @returns True if the signature submitter is valid, false otherwise.
   *          turned into a promise as its CPU intensive
   */
  private isValidSignatureSubmitter = async (
    daPublication: DAStructurePublication,
    ethereumNode: EthereumNode,
    log: LogFunctionType
  ): Promise<boolean> => {
    const signedAddress = await this.verifier.extractAddress(daPublication);

    log('signedAddress', signedAddress);

    return isValidSubmitter(ethereumNode.environment, signedAddress, ethereumNode.deployment);
  };

  /**
   * Validates the timestamp proof of the given DA publication against the corresponding timestamp proof payload.
   * @param daPublication The DA publication to validate the timestamp proof of.
   * @param timestampProofs The timestamp proof payload to validate the DA publication against.
   * @param log A logging function to output debug information.
   * @returns A Promise that resolves with a `ValidType` if the timestamp proof is valid or an error code if it is not.
   */
  private async validatesTimestampProof(
    daPublication: DAStructurePublication,
    timestampProofs: DATimestampProofsResponse,
    log: LogFunctionType
  ): Promise<
    | MomokaValidatorError.TIMESTAMP_PROOF_INVALID_SIGNATURE
    | MomokaValidatorError.TIMESTAMP_PROOF_INVALID_TYPE
    | MomokaValidatorError.TIMESTAMP_PROOF_INVALID_DA_ID
    | ValidType
    // eslint-disable-next-line require-await
  > {
    const valid = await this.verifier.verifyTimestampSignature(daPublication);

    if (!valid) {
      log('timestamp proof invalid signature');
      return MomokaValidatorError.TIMESTAMP_PROOF_INVALID_SIGNATURE;
    }

    log('timestamp proof signature valid');

    if (timestampProofs.type !== daPublication.type) {
      log('timestamp proof type mismatch');
      return MomokaValidatorError.TIMESTAMP_PROOF_INVALID_TYPE;
    }

    if (timestampProofs.dataAvailabilityId !== daPublication.dataAvailabilityId) {
      log('timestamp proof da id mismatch');
      return MomokaValidatorError.TIMESTAMP_PROOF_INVALID_DA_ID;
    }

    return validResult;
  }

  /**
   * Retrieves block information for a range of block numbers.
   * If a block has been retrieved previously, it will return the cached value instead of querying the network.
   * Any newly retrieved blocks will be cached for future use.
   * @param blockNumbers An array of block numbers to retrieve information for
   * @param ethereumNode The Ethereum node to query for block information
   * @returns A PromiseResult containing an array of BlockInfo objects, or a TimeoutError if the query times out
   */
  private async getBlockRange(
    blockNumbers: number[],
    ethereumNode: EthereumNode
  ): PromiseResult<BlockInfo[]> {
    try {
      const blocks = await this.gateway.getBlockRange(blockNumbers, ethereumNode);

      return success(blocks);
    } catch (error) {
      return failure(MomokaValidatorError.BLOCK_CANT_BE_READ_FROM_NODE);
    }
  }

  /**
   * Validate if a block number is the closest one to a given timestamp.
   * @param blockNumber - The block number to be validated.
   * @param timestamp - The timestamp to be used to validate the block.
   * @param ethereumNode - The Ethereum node to be used for block validation.
   * @param log - The log function used to log debug information.
   * @returns A PromiseResult containing a success result if the block is validated, or a failure with the corresponding error.
   */
  private async validateChosenBlock(
    blockNumber: number,
    timestamp: number,
    ethereumNode: EthereumNode,
    log: LogFunctionType
  ): PromiseResult {
    try {
      // got the current block, the previous block, and the block in the future!
      const blockNumbers = [blockNumber - 1, blockNumber, blockNumber + 1];

      const blocksResult = await this.getBlockRange(blockNumbers, ethereumNode);

      if (blocksResult.isFailure()) {
        return failure(blocksResult.failure);
      }

      const blocks = blocksResult.successResult;
      log(
        'blocks',
        blocks.map((c) => ({ time: c.timestamp * 1000, blockNumber: c.number }))
      );
      log('timestamp', timestamp);

      const closestBlock = getClosestBlock(blocks, timestamp);

      // compare block numbers to make sure they are the same
      if (closestBlock.number !== blockNumber) {
        log('closestBlock does not match', {
          closestBlock: closestBlock.number,
          submittedBlockNumber: blockNumber,
          closestBlockFull: closestBlock,
        });

        if (closestBlock.number === blockNumber + 1) {
          log(
            `
        Due to latency with nodes, we allow the next block to be accepted as the closest.
        When you do a request over the wire, the node provider may not have broadcasted yet,
        this means you may have 100-300ms latency which cannot be avoided. The signature still
        needs to conform to the past block, so it's still very valid.
        `
          );
        } else {
          return failure(MomokaValidatorError.NOT_CLOSEST_BLOCK);
        }
      }

      log('compare done', { chosenBlock: closestBlock.timestamp, timestamp });

      //TODO look at this again
      // block times are 2 seconds so this should never ever happen
      // if (closestBlock.number + 2500 > timestamp) {
      //   throw new Error(MomokaValidatorError.BLOCK_TOO_FAR);
      // }

      return success();
    } catch (e) {
      log('validateChosenBlock error', e);
      return failure(MomokaValidatorError.UNKNOWN);
    }
  }

  /**
   * Validates a publication of a DA structure by checking its type and calling the appropriate check function.
   * @param daPublication The publication to validate.
   * @param ethereumNode The Ethereum node to use for validation.
   * @param checkOptions Options for checking the publication.
   * @param log A logging function to use for outputting log messages.
   * @returns A PromiseResult indicating the success or failure of the publication check.
   */
  private async checkDAPublication(
    daPublication: DAStructurePublication,
    ethereumNode: EthereumNode,
    checkOptions: CheckDASubmissionOptions,
    log: LogFunctionType
  ): PromiseResult {
    const publicationVerifierResult = await createDAPublicationVerifier(
      daPublication,
      ethereumNode,
      log
    );

    if (publicationVerifierResult.isFailure()) {
      return failure(publicationVerifierResult.failure);
    }

    const publicationVerifier = publicationVerifierResult.successResult;

    const publicationIdMatchesResult = await publicationVerifier.verifyPublicationIdMatches();

    if (publicationIdMatchesResult.isFailure()) {
      return failure(publicationIdMatchesResult.failure);
    }

    switch (publicationVerifier.type) {
      case MomokaActionTypes.POST_CREATED:
        return checkDAPost(publicationVerifier, checkOptions.log);
      case MomokaActionTypes.COMMENT_CREATED:
        return checkDAComment(
          publicationVerifier,
          checkOptions.verifyPointer,
          ethereumNode,
          checkOptions.log,
          this
        );
      case MomokaActionTypes.MIRROR_CREATED:
        return checkDAMirror(
          publicationVerifier,
          checkOptions.verifyPointer,
          ethereumNode,
          checkOptions.log,
          this
        );
      case MomokaActionTypes.QUOTE_CREATED:
        return checkDAQuote(
          publicationVerifier,
          checkOptions.verifyPointer,
          ethereumNode,
          checkOptions.log,
          this
        );
      default:
        return failure(MomokaValidatorError.PUBLICATION_NOT_RECOGNIZED);
    }
  }

  /**
   * Checks if the given transaction ID has already been checked and returns the corresponding publication.
   * If the transaction ID is found in the database, returns either a success or failure result depending on whether the
   * publication was validated successfully or not, respectively.
   * If the transaction ID is not found in the database, returns null.
   * @param txId The transaction ID to check
   * @param log The logging function to use
   * @returns A promise that resolves to a success or failure result if the publication has already been checked, or null otherwise.
   */
  private async txAlreadyChecked(
    txId: string,
    log: LogFunctionType
  ): PromiseWithContextResultOrNull<DAStructurePublication, DAStructurePublication> {
    // Check if the transaction ID exists in the database
    const cacheResult = await this.gateway.getTxResultFromCache(txId);

    if (cacheResult) {
      // If the transaction ID is found, log a message and return the corresponding publication
      log('Already checked submission');

      if (cacheResult.success) {
        return success(cacheResult.dataAvailabilityResult);
      }

      return failureWithContext(
        (<TxValidatedFailureResult>cacheResult).failureReason,
        cacheResult.dataAvailabilityResult!
      );
    }

    // If the transaction ID is not found, return null
    return null;
  }
}
