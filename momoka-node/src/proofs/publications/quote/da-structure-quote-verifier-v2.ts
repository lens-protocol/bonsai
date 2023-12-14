import { DAStructurePublication } from '../../../data-availability-models/publications/data-availability-structure-publication';
import { DAQuoteCreatedEventEmittedResponseV2 } from '../../../data-availability-models/publications/data-availability-structure-publications-events';
import { CreateQuoteV2EIP712TypedData } from '../../../data-availability-models/publications/data-availability-publication-typed-data';
import { LogFunctionType } from '../../../common/logger';
import { failure, PromiseResult, success } from '../../../data-availability-models/da-result';
import { BigNumber } from 'ethers';
import { MomokaValidatorError } from '../../../data-availability-models/validator-errors';
import { DAPublicationVerifierV2 } from '../da-publication-verifier-v2';
import { generatePublicationId } from '../../utils';
import { DAActionTypes } from '../../../data-availability-models/data-availability-action-types';
import { LensHubV2Gateway } from '../../../evm/gateway/LensHubV2Gateway';
import { EthereumNode } from '../../../evm/ethereum';
import { whoSignedTypedData } from '../publication.base';

export type DAQuotePublicationV2 = DAStructurePublication<
  DAQuoteCreatedEventEmittedResponseV2,
  CreateQuoteV2EIP712TypedData
>;

export const isDAQuotePublicationV2 = (
  daPublication: DAStructurePublication
): daPublication is DAQuotePublicationV2 => {
  return daPublication.type === DAActionTypes.QUOTE_CREATED && 'quoteParams' in daPublication.event;
};

export class DAStructureQuoteVerifierV2 extends DAPublicationVerifierV2 {
  private readonly lensHubGateway: LensHubV2Gateway;

  constructor(
    public readonly daPublication: DAQuotePublicationV2,
    readonly ethereumNode: EthereumNode,
    private readonly log: LogFunctionType
  ) {
    super(daPublication);

    this.lensHubGateway = new LensHubV2Gateway(ethereumNode);
  }

  public async verifySigner(): PromiseResult<{
    currentPublicationId: string;
    ownerOfAddress: string;
  }> {
    const typedData = this.daPublication.chainProofs.thisPublication.typedData;

    const whoSignedResult = await whoSignedTypedData(
      typedData.domain,
      typedData.types,
      typedData.value,
      this.daPublication.chainProofs.thisPublication.signature
    );

    if (whoSignedResult.isFailure()) {
      return failure(whoSignedResult.failure);
    }

    const whoSigned = whoSignedResult.successResult;

    this.log('who signed', whoSigned);

    const chainProfileDetailsResult = await this.lensHubGateway.getOnChainProfileDetails(
      this.daPublication.chainProofs.thisPublication.blockNumber,
      typedData.value.profileId,
      whoSigned
    );
    if (chainProfileDetailsResult.isFailure()) {
      return failure(chainProfileDetailsResult.failure);
    }

    const details = chainProfileDetailsResult.successResult;

    if (details.nonces !== typedData.value.nonce) {
      this.log('nonce mismatch', { expected: details.nonces, actual: typedData.value.nonce });
      return failure(MomokaValidatorError.PUBLICATION_NONCE_INVALID);
    }

    if (details.ownerOfAddress !== whoSigned && details.isSignerApprovedExecutor === false) {
      return failure(MomokaValidatorError.PUBLICATION_SIGNER_NOT_ALLOWED);
    }

    return success({
      currentPublicationId: details.currentPublicationId,
      ownerOfAddress: details.ownerOfAddress,
    });
  }

  verifyPublicationIdMatches(): boolean {
    const generatedPublicationId = generatePublicationId(
      this.daPublication.event.quoteParams.profileId,
      this.daPublication.event.pubId,
      this.daPublication.dataAvailabilityId
    );

    return generatedPublicationId === this.daPublication.publicationId;
  }

  verifyEventWithTypedData(pubCountAtBlock: string): PromiseResult {
    const event = this.daPublication.event;
    const typedData = this.daPublication.chainProofs.thisPublication.typedData;

    // compare all event emitted to typed data value
    this.log('cross check event with typed data value');

    // check the pub count makes sense from the block!
    if (BigNumber.from(pubCountAtBlock).add(1).toHexString() !== event.pubId) {
      return Promise.resolve(failure(MomokaValidatorError.EVENT_MISMATCH));
    }

    this.log('pub count at block is correct');

    // compare all others!
    // TODO: verify others
    if (
      typedData.value.profileId !== event.quoteParams.profileId ||
      typedData.value.contentURI !== event.quoteParams.contentURI ||
      typedData.value.pointedProfileId !== event.quoteParams.pointedProfileId ||
      typedData.value.pointedPubId !== event.quoteParams.pointedPubId
    ) {
      return Promise.resolve(failure(MomokaValidatorError.EVENT_MISMATCH));
    }

    this.log('cross check event is complete');

    return Promise.resolve(success());
  }
}
