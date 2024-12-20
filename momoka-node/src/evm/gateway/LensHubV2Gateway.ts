import { EthereumNode } from '../ethereum';
import { Interface } from 'ethers/lib/utils';
import { retryWithTimeout } from '../../common/helpers';
import { JSONRPCWithTimeout, RATE_LIMIT_TIME } from '../../input-output/json-rpc-with-timeout';
import { JSONRPCMethods } from '../jsonrpc-methods';
import { environmentToLensHubContract } from '../../common/environment';
import { failure, PromiseResult, success } from '../../data-availability-models/da-result';
import { BigNumber, ethers } from 'ethers';
import { MomokaValidatorError } from '../../data-availability-models/validator-errors';
import { numberToHex } from '../../utils/number-to-hex';
import { ContractCallContext, Multicall } from 'ethereum-multicall';
import { LENS_HUB_V2_ABI } from '../contract-lens/lens-hub-v2-contract-abi';
import { PostParamsRequest, SignatureRequest } from '../abi-types/LensHubV2';

const DALensHubInterface = new Interface(LENS_HUB_V2_ABI);

const contractInterface = new ethers.utils.Interface(Multicall.ABI);

export class LensHubV2Gateway {
  constructor(private readonly ethereumNode: EthereumNode) {}

  /**
   * Generates simulation data for the postWithSig function of the DAlens Hub contract.
   * @param params - The parameters.
   * @param signature - The signature.
   * @returns The simulation data or an error result.
   *          turned into a promise as its minimum CPU intensive
   */
  generatePostSimulationData(
    params: PostParamsRequest,
    signature: SignatureRequest
  ): PromiseResult<string> {
    try {
      const result = DALensHubInterface.encodeFunctionData('postWithSig', [params, signature]);

      return Promise.resolve(success(result));
    } catch (e) {
      return Promise.resolve(failure(MomokaValidatorError.INVALID_FORMATTED_TYPED_DATA));
    }
  }

  /**
   * Fetches on-chain details for a given Lens Profile.
   * @param blockNumber The block number at which to query the contract.
   * @param profileId The ID of the Lens Profile.
   * @param signedByAddress The address of the user who signed the transaction.
   * @returns An object containing the on-chain details of the Lens Profile.
   */
  async getOnChainProfileDetails(
    blockNumber: number,
    profileId: string,
    signedByAddress: string
  ): PromiseResult<{
    nonces: number;
    currentPublicationId: string;
    isSignerApprovedExecutor: boolean;
    ownerOfAddress: string;
  }> {
    // Create a new Multicall instance
    const multicall = new Multicall({
      nodeUrl: this.ethereumNode.nodeUrl,
      tryAggregate: true,
    });

    // Define the contract call context for the Lens Hub contract.
    const contractCallContext: ContractCallContext = {
      reference: 'onChainProfileDetails',
      contractAddress: environmentToLensHubContract(this.ethereumNode.environment),
      abi: LENS_HUB_V2_ABI,
      calls: [
        {
          reference: 'nonces',
          methodName: 'nonces',
          methodParameters: [signedByAddress],
        },
        {
          reference: 'getProfile',
          methodName: 'getProfile',
          methodParameters: [profileId],
        },
        {
          reference: 'isDelegatedExecutorApproved',
          methodName: 'isDelegatedExecutorApproved(uint256, address)',
          methodParameters: [profileId, signedByAddress],
        },
        {
          reference: 'ownerOf',
          methodName: 'ownerOf',
          methodParameters: [profileId],
        },
      ],
    };

    // we go a bespoke way so we can use our own http library and not ethers
    // to be in full control
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - use internal methods from multicall
    const calls = multicall.mapCallContextToMatchContractFormat(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - use internal methods from multicall
      multicall.buildAggregateCallContext([contractCallContext])
    );
    const encodedData = contractInterface.encodeFunctionData('tryBlockAndAggregate', [true, calls]);

    try {
      return await retryWithTimeout(
        async () => {
          const result = await JSONRPCWithTimeout<string>(
            this.ethereumNode.nodeUrl,
            JSONRPCMethods.eth_call,
            [
              {
                // multicall 3 address
                to: '0xcA11bde05977b3631167028862bE2a173976CA11',
                data: encodedData,
              },
              numberToHex(blockNumber),
            ]
          );

          const functionFragment = contractInterface.getFunction('tryBlockAndAggregate');
          const outputTypes = functionFragment.outputs!;

          const decodedResultData = ethers.utils.defaultAbiCoder.decode(outputTypes, result);
          const resultData = decodedResultData[2];

          const [decodedGetProfileResponse] = DALensHubInterface.decodeFunctionResult(
            'getProfile',
            resultData[1].returnData
          );

          // bit ugly but we need to decode the return data
          // we know the order of stuff from the above ContractCallContext::calls
          // but as we using a more bespoke approach we can use index here!
          return success({
            nonces: BigNumber.from(resultData[0].returnData).toNumber(),
            currentPublicationId: BigNumber.from(decodedGetProfileResponse[0]).toHexString(),
            isSignerApprovedExecutor: ethers.utils.defaultAbiCoder.decode(
              ['bool'],
              resultData[2].returnData
            )[0],
            ownerOfAddress: ethers.utils.defaultAbiCoder.decode(
              ['address'],
              resultData[3].returnData
            )[0],
          });
        },
        {
          delayMs: RATE_LIMIT_TIME,
        }
      );
    } catch (_error) {
      return failure(MomokaValidatorError.DATA_CANT_BE_READ_FROM_NODE);
    }
  }

  /**
   * Returns the number of published data availability proofs for a given profile ID and block number.
   * @param profileId The profile ID to retrieve the published proof count for.
   * @param blockNumber The block number to retrieve the published proof count at.
   * @returns The number of published data availability proofs for the specified profile ID and block number.
   */
  async getLensPubCount(profileId: string, blockNumber: number): PromiseResult<BigNumber> {
    const encodedData = DALensHubInterface.encodeFunctionData('getProfile', [profileId]);

    try {
      return await retryWithTimeout(
        async () => {
          const ethCall = await JSONRPCWithTimeout<string>(
            this.ethereumNode.nodeUrl,
            JSONRPCMethods.eth_call,
            [
              {
                to: environmentToLensHubContract(this.ethereumNode.environment),
                data: encodedData,
              },
              numberToHex(blockNumber),
            ]
          );

          if (!ethCall) {
            throw new Error('eth_call returned undefined');
          }

          const [decodedGetProfileResponse] = DALensHubInterface.decodeFunctionResult(
            'getProfile',
            ethCall
          );

          return success(BigNumber.from(decodedGetProfileResponse[0]));
        },
        {
          delayMs: RATE_LIMIT_TIME,
        }
      );
    } catch {
      return failure(MomokaValidatorError.DATA_CANT_BE_READ_FROM_NODE);
    }
  }
}
