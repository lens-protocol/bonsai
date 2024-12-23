# Momoke-node

This package holds the node implementation of the momoka and also the ability to run it client side.

## Running

### Key information

To run the verifier, you MUST use an archive node. You can sign up with Alchemy and use one of their free nodes. Non-archive nodes do not retain state information beyond the previous 16-128 blocks. While this may be sufficient for immediate runtime calls after the DA publication is created, it will not work for past transactions beyond the 16-128 block range.

### Being as fast as possible - Concurrency

The verifier is designed for optimal speed, with performance determined by its configuration parameters. Achieving 10,000 TPS is not a problem, provided that the hardware and nodes can support these limits. When running the verifier, you have the option to set the CONCURRENCY, which divides the number of requests sent to the NODE_URL simultaneously. Higher concurrency values result in faster performance during resynchronization or when handling a large volume of transactions at once.

The default concurrency is 100, which typically requires a paid archive node. If you prefer using a free node, the verifier will be slower, but it will still work effectively. For a free node, you can set the concurrency between 1 and 3. For example, at LENS, we have set the concurrency at 120, which enables our verifier to run very quickly.

## Running straight out the box

Currently, you have two options to run it directly. Either by using the npm `momoka` package, or through Docker.

### Running from npm

You can install it globally:

```bash
$ npm i @lens-protocol/momoka -g
```

then you can just run:

```bash
$ momoka --node 'YOUR_NODE' --environment='MUMBAI|AMOY|POLYGON' --concurrency=20
```

you can also just run with npx:

```bash
$ npx @lens-protocol/momoka --node 'YOUR_NODE' --environment='MUMBAI|AMOY|POLYGON' --concurrency=20
```

By default it will not resync all the data, it just start verifying from this point onwards unless you add the parameter `--resync=true` which will start from block 0 and resync all the data.

### Running from Docker

You can use the `Dockerfile.stable` file to set up a container which will run the latest stable release on Momoka from `npm`. The Dockerfile assumes running on the `POLYGON` environment, and sets concurrency to 100. You can change those if necessary.

A few environment variables are required for it to work, which you can set however you'd like depending on how and where you're running the Docker container. Specifically, you need to set `NODE_URL`, `ENVIRONMENT`, and `CONCURRENCY` environment variables.

> NOTE: A `render.yaml` IaC blueprint is also provided which runs `Dockerfile.stable`. If you'd like to use [Render](https://render.com) for hosting your Momoka verifier, you can easily deploy it there by using the Render Blueprint. See their docs on [Infrastructure as Code](https://render.com/docs/infrastructure-as-code) to see how.

### Parameter meanings

- `--node` - this is the URI of the Polygon archive node you wish to connect to, this can be a free node or a paid node, it is recommended to use a paid node for the best performance. you can get up and running with a node using Alchemy, Infura, or any other similar infrastructure provider
- `--environment` - this is the environment you wish to run the verifier on, this can be `MUMBAI` `AMOY` or `POLYGON`
- `--concurrency` - this is the concurrency you wish to run the verifier on, which was talked in depth above
- `--resync` - this is a boolean value, which if set to true will start the verifier from the block 0 and resync all transactions from the past, if set to false it will start verifying from this moment onwards.

## Installing package

This is a written in node, and this means it can be run on the client as well as a server; it won't use the DB on the client but can mean you can run proof checks in runtime, which is super powerful. Also, you may which to monitor this on your server to index stuff as it comes in.

```bash
$ npm i @lens-protocol/momoka
```

<b>Do not use if you do not know what you are doing the basic config works for all production apps</b>

Please note if you wish to use a different deployment then `PRODUCTION` you will need to make sure you put `deployment: STAGING` or `deployment: LOCAL` in the `EthereumNode` object. This for most will not be the case.

### Client usage

The package exposes a separate entry point for the client usage (`'@lens-protocol/momoka/client'`) to make sure the bundle size is not affected by any polyfills or other node specific code.

Check the `playground-browser` folder for a working example of the client usage.

#### checkDAProof

The `checkDAProof` will return you a failure reason of the enum `MomokaValidatorError`, and if successful, you be returned the entire `DAStructurePublication`. This is a client specific version of the `checkDAProof` function that doesn't have any caching in place. For the server version, please see the server usage section.

```ts
import { checkDAProof, EthereumNode, Environment } from '@lens-protocol/momoka/client';

const ethereumNode: EthereumNode = {
  environment: Environment.POLYGON,
  nodeUrl: YOUR_NODE_URL,
};

const result = await checkDAProof(PROOF_ID, ethereumNode);
if (result.isSuccess()) {
  console.log('proof valid', result.successResult);
  return; // all is well!
}

// it failed!
console.error('proof invalid do something', result.failure);
```

### Server usage

#### checkDAProof

The `checkDAProof` will return you a failure reason of the enum `MomokaValidatorError`, and if successful, you be returned the entire `DAStructurePublication`. This is a server specific version of the `checkDAProof` function that has caching in place. For the client version, please see the client usage section.

```ts
import { checkDAProof, EthereumNode, Environment } from '@lens-protocol/momoka';

const ethereumNode: EthereumNode = {
  environment: Environment.POLYGON,
  nodeUrl: YOUR_NODE_URL,
};

const result = await checkDAProof(PROOF_ID, ethereumNode);
if (result.isSuccess()) {
  console.log('proof valid', result.successResult);
  return; // all is well!
}

// it failed!
console.error('proof invalid do something', result.failure);
```

#### startDAVerifierNode

This will start watching all the DA items coming in and logging it all out in your terminal. you can install the package and run it on your own server. By default it will not resync all the data, it just start verifying from this point onwards unless you add the parameter which is defined below.

```ts
import { startDAVerifierNode, EthereumNode } from '@lens-protocol/momoka';

const ethereumNode: EthereumNode = {
  environment: Environment.POLYGON,
  nodeUrl: YOUR_NODE_URL,
};

// you should read up on section "Being as fast as possible - Concurrency"
const concurrency = 100;

// it run forever and log out to the terminal
startDAVerifierNode(ethereumNode, concurrency);
```

#### startDAVerifierNode - Stream with proofs verified

If you wish to index the data yourself, you can use the `startDAVerifierNode` and stream the data out to your own DB using the `StreamCallback`. This will run the verifier node and check the proofs as every new one comes in. By default it will not resync all the data, it just start verifying from this point onwards unless you add the parameter which is defined below.

```ts
import { startDAVerifierNode, StreamResult, EthereumNode } from '@lens-protocol/momoka';

const stream = (result: StreamResult) => {
  console.log('streamed publication', result);

  if (result.success) {
    // success - insert into your db here if you wish
    console.log('success', result.dataAvailabilityResult);
  } else {
    // failure reason
    console.log('reason', result.failureReason);
    // this will expose the submission if it could be read
    console.log('submisson', result.dataAvailabilityResult);
  }
};

const ethereumNode: EthereumNode = {
  environment: Environment.POLYGON,
  nodeUrl: YOUR_NODE_URL,
};

// you should read up on section "Being as fast as possible - Concurrency"
const concurrency = 100;

// it run forever and log out to the terminal
startDAVerifierNode(ethereumNode, concurrency, { stream });
```

#### Start verifier from block 0

You may wish to start the verifier and recheck from the first ever momoka transaction, You can do this by passing in the `resync` option.

```ts
import { startDAVerifierNode, StreamResult, EthereumNode } from '@lens-protocol/momoka';

const ethereumNode: EthereumNode = {
  environment: Environment.POLYGON,
  nodeUrl: YOUR_NODE_URL,
};

// you should read up on section "Being as fast as possible - Concurrency"
const concurrency = 100;

// it run forever and log out to the terminal
startDAVerifierNode(ethereumNode, concurrency, { resync: true });
```

#### startDATrustingIndexing

If you just want to get the data as fast as possible and do not wish to verify the proofs, you can use the `startDATrustingIndexing` function. This will stream out the data as fast as possible and will not check the proofs, so does not require an archive node.

```ts
import {
  startDATrustingIndexing,
  StreamResult,
  StartDATrustingIndexingRequest,
} from '@lens-protocol/momoka';

const stream = (result: StreamResult) => {
  console.log('streamed publication', result);

  if (result.success) {
    // success - insert into your db here if you wish
    console.log('success', result.dataAvailabilityResult);
  } else {
    // failure reason
    console.log('reason', result.failureReason);
    // this will expose the submisson if it could be read
    console.log('submisson', result.dataAvailabilityResult);
  }
};

const request: StartDATrustingIndexingRequest = {
  environment: Environment.POLYGON,
  stream,
};

// it run forever and stream data as it comes in
startDATrustingIndexing(request);
```

### Running from this repo

#### Dependencies

This package has a few dependencies that need to be installed, these are:

- we use `pnpm` for this repo so please have it installed: https://pnpm.io/installation
- nvm is also used for node versioning:

If you wish to just run it on its own, you can just run:

```bash
$ nvm use
$ pnpm i
$ pnpm run start
```

To build its just:

```bash
$ pnpm build
```

### Tests

To run the tests:

create an `.env.test` file with the following (you need to add a AMOY node url)

```bash
ETHEREUM_NETWORK=AMOY
NODE_URL=AMOY_NODE_URL
DEPLOYMENT=PRODUCTION
CONCURRENCY=10
```

```bash
$ pnpm test
```

### Docker

Please note you need a `.env` setup for this to work.

To run the docker first build it:

```bash
$ docker build -t da-service .
```

Then run it:

```bash
$ docker run -d -p 3008:3008 da-service
```

This will return an docker id.

Then to listen to the logs you can:

```bash
docker logs <id>
```

## Validation checks flows

This is written in sudo `node` code to understand the current flow of the validation checks.

```ts
async function validateClaim() {
  // 1. Fetch DA metadata from Bundlr
  const metadata = await fetchMetadataFromBundlr();

  // 2. Check if `signature` is defined
  if (!signature) {
    return MomokaValidatorError.NO_SIGNATURE_SUBMITTER;
  }

  // 3. Verify `signature` with `metadata`
  if (!verifySignature(signature, metadata)) {
    return MomokaValidatorError.INVALID_SIGNATURE_SUBMITTER;
  }

  // 4. Check timestamp proofs with Bundlr
  if (!(await checkTimestampProofs())) {
    return MomokaValidatorError.TIMESTAMP_PROOF_INVALID_SIGNATURE;
  }

  // 5. Check if timestamp proofs submitter is valid
  if (!isValidTimestampProofsSubmitter()) {
    return MomokaValidatorError.TIMESTAMP_PROOF_INVALID_SUBMITTER;
  }

  // 6. Check if event `timestamp` equals `blockTimestamp`
  if (eventTimestamp !== blockTimestamp) {
    return MomokaValidatorError.INVALID_EVENT_TIMESTAMP;
  }

  // 7. Check if block number is closest to timestamp proofs
  if (!isClosestBlock()) {
    return MomokaValidatorError.NOT_CLOSEST_BLOCK;
  }

  // 8. Check if chain signature has already been used
  if (!chainSignatureAlreadyUsed()) {
    return MomokaValidatorError.CHAIN_SIGNATURE_ALREADY_USED;
  }

  // 9. Check if pointer is defined
  if (isPost() && pointer) {
    return MomokaValidatorError.INVALID_POINTER_SET_NOT_NEEDED;
  } else if (!pointer && (isMirror() || isComment())) {
    return MomokaValidatorError.INVALID_POINTER_NOT_SET;
  }

  // 9.1. Check pointer type (if defined)
  if (pointer && !isPointerTypeOnDA()) {
    return PUBLICATION_NONE_DA;
  }

  // 10. Verify pointer (if defined) - follow steps from 1
  const pointerStepError = await verifyPointer();
  if (pointerStepError) {
    return pointerStepError;
  }

  // 11. Check if formatted typed data is valid
  if (!isValidFormattedTypedData()) {
    return MomokaValidatorError.INVALID_FORMATTED_TYPED_DATA;
  }

  // 12a. If `POST`, simulate transaction using eth_call
  if (isPost()) {
    const simulationResult = await simulateTransaction();
    if (simulationResult === 'nodeError') {
      return MomokaValidatorError.SIMULATION_NODE_COULD_NOT_RUN;
    } else if (simulationResult === 'failed') {
      return MomokaValidatorError.SIMULATION_FAILED;
    }
  }
  // 12b. If `COMMENT` or `MIRROR`, perform additional checks
  else {
    if (!isValidPublicationNonce()) {
      return MomokaValidatorError.PUBLICATION_NONCE_INVALID;
    }
    if (!isPublicationSignerAllowed()) {
      return MomokaValidatorError.PUBLICATION_SIGNER_NOT_ALLOWED;
    }
  }

  // 13. Cross-check typed data values with `event`
  if (!isEventMatchingTypedData()) {
    return MomokaValidatorError.EVENT_MISMATCH;
  }

  // 14. Check if `publicationId` matches expected ID
  if (!isPublicationIdMatch()) {
    // 15. Check if it could of been a potential reorg

    // if so:
    return MomokaValidatorError.POTENTIAL_REORG;

    // if not
    return MomokaValidatorError.GENERATED_PUBLICATION_ID_MISMATCH;
  }

  // all validated!
}
```

At this point, you have done all the checks needed, and this is a valid submission! As you see, using signatures and EVM calls, we can verify the data is correct and the submitter is correct without any other third party.

### Validation error checks types and messages

The summary in the code should explain what is being checked for and what it would fail out if it doesn't match. Below is the full list of error cases

```ts
export enum MomokaValidatorError {
  /**
   * This means the main signature has not been attached to the payload
   */
  NO_SIGNATURE_SUBMITTER = 'NO_SIGNATURE_SUBMITTER',

  /**
   * This means the main signature has not been signed by the same payload as the data itself
   */
  INVALID_SIGNATURE_SUBMITTER = 'INVALID_SIGNATURE_SUBMITTER',

  /**
   * This means the submitted timestamp proof does not have a valid timestamp proof signature
   */
  TIMESTAMP_PROOF_INVALID_SIGNATURE = 'TIMESTAMP_PROOF_INVALID_SIGNATURE',

  /**
   * This means the type in the timestamp proofs do not match
   * timestamp proofs are not portable
   */
  TIMESTAMP_PROOF_INVALID_TYPE = 'TIMESTAMP_PROOF_INVALID_TYPE',

  /**
   * This means the da id in the timestamp proofs do not match up
   * timestamp proofs are not portable
   */
  TIMESTAMP_PROOF_INVALID_DA_ID = 'TIMESTAMP_PROOF_INVALID_DA_ID',

  /**
   * This means the timestamp proof uploaded was not done by a valid submitter
   */
  TIMESTAMP_PROOF_NOT_SUBMITTER = 'TIMESTAMP_PROOF_NOT_SUBMITTER',

  /**
   * We tried to call them 5 times and its errored out - this is not a bad proof but bundlr/arweave are having issues
   */
  CAN_NOT_CONNECT_TO_BUNDLR = 'CAN_NOT_CONNECT_TO_BUNDLR',

  /**
   * The DA tx could not be found or invalid on the bundlr/arweave nodes
   * can happened if pasted it in wrong
   */
  INVALID_TX_ID = 'INVALID_TX_ID',

  /**
   * This the typed data format is invalid (aka a invalid address type etc)
   */
  INVALID_FORMATTED_TYPED_DATA = 'INVALID_FORMATTED_TYPED_DATA',

  /**
   * This means it can not read the block from the node
   */
  BLOCK_CANT_BE_READ_FROM_NODE = 'BLOCK_CANT_BE_READ_FROM_NODE',

  /**
   * This means it can not read the data from the node
   */
  DATA_CANT_BE_READ_FROM_NODE = 'DATA_CANT_BE_READ_FROM_NODE',

  /**
   * This means the simulation was not able to be ran on the node, this does not mean
   * that it would fail on chain, it means the nodes may of been down and needs rechecking
   */
  SIMULATION_NODE_COULD_NOT_RUN = 'SIMULATION_NODE_COULD_NOT_RUN',

  /**
   * This means the simulation was not successful and got rejected on-chain
   * or the result from the simulation did not match the expected result
   */
  SIMULATION_FAILED = 'SIMULATION_FAILED',

  /**
   * This means the event emitted from the simulation does not match the expected event
   */
  EVENT_MISMATCH = 'EVENT_MISMATCH',

  /**
   * This means the event timestamp passed into the emitted event does not match the signature timestamp
   */
  INVALID_EVENT_TIMESTAMP = 'INVALID_EVENT_TIMESTAMP',

  /**
   * This means the deadline set in the typed data is not correct
   */
  INVALID_TYPED_DATA_DEADLINE_TIMESTAMP = 'INVALID_TYPED_DATA_DEADLINE_TIMESTAMP',

  /**
   * This means the generated publication id for the generic id does not match
   * what it should be
   */
  GENERATED_PUBLICATION_ID_MISMATCH = 'GENERATED_PUBLICATION_ID_MISMATCH',

  /**
   * This means the pointer set in the chain proofs is not required but set anyway
   */
  INVALID_POINTER_SET_NOT_NEEDED = 'INVALID_POINTER_SET_NOT_NEEDED',

  /**
   * This means the pointer has failed verification
   */
  POINTER_FAILED_VERIFICATION = 'POINTER_FAILED_VERIFICATION',

  /**
   * This means the block processed against is not the closest block to the timestamp proofs
   */
  NOT_CLOSEST_BLOCK = 'NOT_CLOSEST_BLOCK',

  /**
   * This means the timestamp proofs are not close enough to the block
   */
  BLOCK_TOO_FAR = 'NOT_CLOSEST_BLOCK',

  /**
   * This means the publication submitted does not have a valid pointer
   * and a pointer is required
   */
  PUBLICATION_NO_POINTER = 'PUBLICATION_NO_POINTER',

  /**
   * Some publications (comment and mirror) for now can only be on another
   * DA publication not on evm chain publications
   */
  PUBLICATION_NONE_DA = 'PUBLICATION_NONE_DA',

  /**
   * This means the publication nonce is invalid at the time of submission
   */
  PUBLICATION_NONCE_INVALID = 'PUBLICATION_NONCE_INVALID',

  /**
   * This means the publication submisson was signed by a wallet that is not allowed
   */
  PUBLICATION_SIGNER_NOT_ALLOWED = 'PUBLICATION_SIGNER_NOT_ALLOWED',

  /**
   * This means the evm signature has already been used
   */
  CHAIN_SIGNATURE_ALREADY_USED = 'CHAIN_SIGNATURE_ALREADY_USED',

  /**
   * This means the publication submisson could not pass potentional due to a reorg
   */
  POTENTIAL_REORG = 'POTENTIAL_REORG',

  /**
   * unknown error should not happen but catch all
   */
  UNKNOWN = 'UNKNOWN',
}
```

## Contributing

Any PRs are welcome and we will review them as soon as possible. Please make sure you have tests and they pass.

## Acknowledgements

### Bundlr

A special thank you to [Bundlr](https://bundlr.network/) for making this project possible with their cutting-edge technology. We are grateful to their exceptional team for their collaboration and support.

### Arweave

We also extend our gratitude to [Arweave](https://www.arweave.org/) for providing decentralized storage solutions for our data, contributing to the overall success of the DA project.

## Why node?

Our goal was to create a tool that could be verified both on the client and server side, and we found that Node.js was the most suitable option for this purpose. Additionally, we aimed to make it as understandable as possible, and Node.js is renowned for its ease of use and a big languaged used throughout web3 development. As per our roadmap, we plan to migrate a significant portion of this stack to Rust, a more low-level language, to achieve maximum speed once we need it.
