use json::JsonValue;
use regex::Regex;
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::Arc,
};

use crate::{
    bundlr::{
        api::{get_bulk_transactions_api, get_transaction_api},
        verify::verify_timestamp_proofs,
    },
    cache::{
        read_signature_cache, read_transaction_cache, set_signature_cache, set_transaction_cache,
        TransactionCacheResult,
    },
    evm::ProviderContext,
    logger::Logger,
    submitter::state::is_valid_submitter,
    types::{
        transaction::{MomokaTransaction, MomokaTxId, TransactionSummary},
        verifier_error::MomokaVerifierError,
    },
};
use ethers::{
    providers::{Http, Middleware, Provider, RetryClient},
    types::{Address, Block, BlockNumber, Signature, H256, U256},
};

/// Returns the block from a slice of three blocks that is closest in time to a specified target timestamp.
///
/// # Arguments
///
/// * `blocks` - A slice containing three blocks to search through.
/// * `target_timestamp` - The target timestamp to find the closest block to.
///
/// # Returns
///
/// An optional `Block` struct containing the closest block, or `None` if the input slice is empty.
///
/// # Examples
///
/// ```
/// # use momoka_rs::{Block, get_closest_block};
/// # use ethers::types::{BlockNumber, H256, U256};
/// let blocks = [
///     Block {
///         hash: H256::zero(),
///         parent_hash: H256::zero(),
///         number: BlockNumber::Number(42.into()),
///         timestamp: U256::from(1620641837),
///         gas_limit: Default::default(),
///         gas_used: Default::default(),
///         miner: Default::default(),
///         difficulty: Default::default(),
///         total_difficulty: Default::default(),
///         size: Default::default(),
///         extra_data: Default::default(),
///         transactions: Default::default(),
///         uncles: Default::default(),
///         seal_fields: Default::default(),
///         logs_bloom: Default::default(),
///         state_root: Default::default(),
///         receipts_root: Default::default(),
///         transactions_root: Default::default(),
///         uncle_hash: Default::default(),
///     },
///     Block {
///         number: BlockNumber::Number(43.into()),
///         timestamp: U256::from(1620641838),
///         ..Default::default()
///     },
///     Block {
///         number: BlockNumber::Number(44.into()),
///         timestamp: U256::from(1620641839),
///         ..Default::default()
///     },
/// ];
///
/// let target_timestamp = U256::from(1620641838);
/// let closest_block = get_closest_block(&blocks, target_timestamp);
/// assert_eq!(closest_block.unwrap().number, BlockNumber::Number(43.into()));
/// ```
fn get_closest_block(blocks: &[Block<H256>; 3], target_timestamp: U256) -> Option<Block<H256>> {
    let target_timestamp_ms = target_timestamp.as_u64();
    let target_block_number = BlockNumber::Number(target_timestamp.as_u64().into());

    blocks
        .iter()
        .filter(|block| block.number <= target_block_number.as_number())
        .min_by_key(|block| {
            let block_timestamp_ms = block.timestamp.as_u64() * 1000;
            (block_timestamp_ms as i64 - target_timestamp_ms as i64).abs()
        })
        .cloned()
}

/// Fetches blocks with the given block numbers from a specified Ethereum node.
///
/// # Arguments
///
/// * `block_numbers` - An array containing three block numbers to fetch.
/// * `provider` - A ethers provider instance
///
/// # Returns
///
/// An array containing the fetched blocks.
///
/// # Errors
///
/// Returns a `MomokaVerifierError` if any of the blocks cannot be fetched from the node.
///
/// # Examples
///
/// ```
/// # use momoka_rs::get_blocks;
///
/// let block_numbers = [42, 43, 44];
/// let provider =  Provider::<Http>::try_from(node_url).unwrap();
/// let result = get_blocks(block_numbers, &provider).await;
/// ```
async fn get_blocks(
    block_numbers: [u64; 3],
    provider: &Provider<RetryClient<Http>>,
) -> Result<[Block<H256>; 3], MomokaVerifierError> {
    let mut blocks = [Default::default(), Default::default(), Default::default()];

    for (i, block_number) in block_numbers.iter().enumerate() {
        let block = provider
            .get_block(*block_number)
            .await
            .map_err(|_| MomokaVerifierError::BlockCantBeReadFromNode)?
            .ok_or(MomokaVerifierError::BlockCantBeReadFromNode)?;

        blocks[i] = block;
    }

    Ok(blocks)
}

/// Verifies that the block number in a given Momoka transaction matches the closest block to its timestamp.
///
/// # Arguments
///
/// * `block_number` - A reference to the block number in the Momoka transaction to verify.
/// * `timestamp` - A reference to the timestamp in the Momoka transaction to use for finding the closest block.
/// * `provider_context` - The provider context.
///
/// # Returns
///
/// A `Result<(), MomokaVerifierError>` indicating whether the block number in the Momoka transaction matches the closest block to its timestamp.
///
/// # Errors
///
/// Returns a `MomokaVerifierError` if any of the following errors occur:
///
/// * The block numbers cannot be read from the node.
/// * The block number in the closest block to the timestamp does not match the given block number, and it is not the next block due to latency.
/// * The block number in the closest block to the timestamp does not exist.
///
/// # Examples
///
/// ```
/// # use momoka_rs::{is_valid_chosen_block, EthereumNode};
///
/// let block_number = 42;
/// let timestamp = 1620627000;
/// let provider_context = ProviderContext{(/* ... */)};
/// let result = is_valid_chosen_block(&block_number, &timestamp, &provider_context).await;
/// ```
async fn is_valid_chosen_block(
    block_number: &u64,
    timestamp: &u64,
    provider_context: &ProviderContext,
) -> Result<(), MomokaVerifierError> {
    let blocks = get_blocks(
        [
            block_number.checked_sub(1).unwrap(),
            *block_number,
            block_number.checked_add(1).unwrap(),
        ],
        &provider_context.node,
    )
    .await?;

    let closest_block = get_closest_block(&blocks, U256::from(*timestamp));
    if let Some(closest_block) = closest_block {
        if let Some(closest_block_number) = closest_block.number.map(|n| n.as_u64()) {
            if closest_block_number != *block_number {
                // println!(
                //     "The block you have chosen is not the closest block to the timestamp.
                //     The closest block is {} and you have chosen {}.",
                //     closest_block_number, block_number
                // );

                if closest_block_number == block_number.checked_add(1).unwrap_or_default() {
                    // println!("
                    //     Due to latency with nodes, we allow the next block to be accepted as the closest.
                    //     When you do a request over the wire, the node provider may not have broadcasted yet,
                    //     this means you may have 100-300ms latency which cannot be avoided. The signature still
                    //     needs to conform to the past block, so it's still very valid.
                    // ");
                } else {
                    return Err(MomokaVerifierError::NotClosestBlock);
                }
            }
        } else {
            return Err(MomokaVerifierError::NotClosestBlock);
        }
    } else {
        return Err(MomokaVerifierError::BlockCantBeReadFromNode);
    }

    Ok(())
}

/// the pattern to extract the signature out of the big payload
const SIGNATURE_EXTRACT_PATTERN: &str = r#""signature"\s*:\s*"0x[a-fA-F0-9]{130}",?\s*"#;

/// Extracts the address from a MomokaTransaction.
///
/// This function removes the signature from the payload of the transaction,
/// updates the verifying contract and collect module (if present), and recovers
/// the address from the signature.
///
/// # Arguments
///
/// * `transaction` - A reference to the MomokaTransaction from which to extract the address.
///
/// # Returns
///
/// * `Result<Address, MomokaVerifierError>` - The extracted address if successful, or an error if any step fails.
///
fn extract_address(transaction: &MomokaTransaction) -> Result<Address, MomokaVerifierError> {
    // due to signing a huge payload of typed data we need to remove the signature from the payload
    // this was due to some calls in the node code and this had some knock on here so we have to do it
    // a bit dirty! - sorry!!

    let mut inner_object = transaction.get_inner_object()?;

    // Update verifying contract
    let verifying_contract = transaction.verifying_contract()?;
    inner_object["chainProofs"]["thisPublication"]["typedData"]["domain"]["verifyingContract"] =
        JsonValue::String(ethers::utils::to_checksum(verifying_contract, None));

    // Update collect module if present
    if let Some(collect_module) = transaction.typed_data_collect_module()? {
        let collect_module_checksum = ethers::utils::to_checksum(collect_module, None);
        inner_object["chainProofs"]["thisPublication"]["typedData"]["value"]["collectModule"] =
            JsonValue::String(collect_module_checksum.clone());
        inner_object["event"]["collectModule"] = JsonValue::String(collect_module_checksum);
    }

    // Convert the inner object to a JSON string
    let inner_object_string = json::stringify(inner_object.clone());

    // Remove the signature from the payload
    let re = Regex::new(SIGNATURE_EXTRACT_PATTERN)
        .map_err(|_| MomokaVerifierError::InvalidSignatureSubmitter)?;
    let omit_signature = re.replace(&inner_object_string, "").into_owned();

    // Recover the address from the signature
    let signature = Signature::from_str(transaction.signature()?)
        .map_err(|_| MomokaVerifierError::InvalidSignatureSubmitter)?;

    let address = signature
        .recover::<String>(omit_signature)
        .map_err(|_| MomokaVerifierError::InvalidSignatureSubmitter)?;

    Ok(address)
}

/// Verifies that the timestamp proofs for a given Momoka transaction match the transaction.
///
/// # Arguments
///
/// * `momoka_tx` - A reference to the `MomokaTransaction` struct to verify the timestamp proofs for.
///
/// # Returns
///
/// A `Result<(), MomokaVerifierError>` indicating whether the timestamp proofs match the transaction.
///
/// # Examples
///
/// ```
/// # use momoka_rs::{verify_timestamp_proofs_match_transaction, TransactionSummary};
///
/// let transaction = TransactionSummary::new(/* ... */);
/// let result = verify_timestamp_proofs_match_transaction(&transaction).await;
/// ```
async fn verify_timestamp_proofs_match_transaction(
    transaction: &TransactionSummary,
) -> Result<(), MomokaVerifierError> {
    if transaction.timestamp_proofs_response.is_none() {
        return Err(MomokaVerifierError::TimestampProofInvalidType);
    }

    if let Some(timestamp_proofs) = transaction.timestamp_proofs_response.as_ref() {
        if timestamp_proofs.action_type != *transaction.momoka_tx.transaction_type()? {
            return Err(MomokaVerifierError::TimestampProofInvalidType);
        }

        if timestamp_proofs.data_availability_id != *transaction.momoka_tx.data_availability_id()? {
            return Err(MomokaVerifierError::TimestampProofInvalidDAID);
        }
    } else {
        return Err(MomokaVerifierError::TimestampProofInvalidType);
    }

    verify_timestamp_proofs(&transaction.momoka_tx.get_timestamp_proofs()?.response).await?;

    Ok(())
}

/// Processes the proof for a given transaction summary.
///
/// # Arguments
///
/// * `transaction_summary` - A reference to the `TransactionSummary` struct to process the proof for.
/// * `provider_context` - The provider context.
///
/// # Returns
///
/// A `Result<(), MomokaVerifierError>` indicating whether the proof was processed successfully.
///
/// # Examples
///
/// ```
/// # use momoka_rs::{process_proofs, EthereumNode, TransactionSummary};
///
/// let transaction_summary = TransactionSummary::new(/* ... */);
/// let provider_context = ProviderContext{(/* ... */)};
/// let result = process_proof(&transaction_summary, &provider_context).await;
/// ```
async fn process_proof(
    transaction_summary: &TransactionSummary,
    provider_context: &ProviderContext,
) -> Result<(), MomokaVerifierError> {
    let signer_address = extract_address(&transaction_summary.momoka_tx)?;

    if !is_valid_submitter(
        &provider_context.environment,
        &signer_address,
        &provider_context.deployment,
    ) {
        println!("Invalid submitter");
        return Err(MomokaVerifierError::InvalidSignatureSubmitter);
    }

    if !transaction_summary.momoka_tx.valid_publication_id()? {
        return Err(MomokaVerifierError::GeneratedPublicationIdMismatch);
    }

    if !is_valid_submitter(
        &provider_context.environment,
        &transaction_summary.submitter,
        &provider_context.deployment,
    ) {
        return Err(MomokaVerifierError::TimestampProofNotSubmitter);
    }

    if !transaction_summary.momoka_tx.is_valid_event_timestamp()? {
        return Err(MomokaVerifierError::InvalidEventTimestamp);
    }

    if !transaction_summary
        .momoka_tx
        .is_valid_typed_data_deadline_timestamp()?
    {
        return Err(MomokaVerifierError::InvalidTypedDataDeadlineTimestamp);
    }

    is_valid_chosen_block(
        transaction_summary.momoka_tx.block_number()?,
        transaction_summary
            .momoka_tx
            .third_party_proofs_timestamp()?,
        provider_context,
    )
    .await?;

    verify_timestamp_proofs_match_transaction(transaction_summary).await?;

    transaction_summary
        .momoka_tx
        .validate_transaction(provider_context)
        .await
}

/// Retrieves the cached result for a given transaction ID.
///
/// This function checks if the transaction ID exists in the cache and returns the cached result
/// if available. If the transaction ID is not found in the cache, it returns `None`.
///
/// # Arguments
///
/// * `tx_id` - The transaction ID to check in the cache.
///
/// # Returns
///
/// * `Result<Option<Result<(), MomokaVerifierError>>` - A `Result` containing `Some(Ok(()))` if the transaction is
///   cached and successful, `Some(Err(...))` if the transaction is cached but failed, or `None` if the transaction
///   is not found in the cache.
fn cached_tx_id(
    tx_id: &MomokaTxId,
) -> Result<Option<Result<(), MomokaVerifierError>>, MomokaVerifierError> {
    let cached: Option<Arc<TransactionCacheResult>> = read_transaction_cache(tx_id);

    if let Some(cached_value) = cached {
        if !cached_value.success {
            let error = cached_value
                .error
                .clone()
                .unwrap_or(MomokaVerifierError::CacheError);
            Ok(Some(Err(error)))
        } else {
            Ok(Some(Ok(())))
        }
    } else {
        // not in cache
        Ok(None)
    }
}

/// Sets the cache for a transaction ID with the given result.
///
/// This function sets the cache for the provided transaction ID based on the result. If the result
/// is `Ok(())`, indicating a successful verification, the cache will be set with a success status
/// and no error. If the result is `Err(...)`, indicating a failed verification with an error,
/// the cache will be set with a failure status and the error.
///
/// # Arguments
///
/// * `tx_id` - The transaction ID to set in the cache.
/// * `result` - The result of the verification, either `Ok(())` for success or `Err(...)` for failure.
///
/// # Returns
///
/// * `Result<(), MomokaVerifierError>` - A `Result` indicating success if the cache is set successfully.
fn set_tx_cache(
    tx_id: MomokaTxId,
    result: &Result<(), MomokaVerifierError>,
) -> Result<(), MomokaVerifierError> {
    let cache_result = TransactionCacheResult {
        success: result.is_ok(),
        error: result.clone().err(),
    };

    set_transaction_cache(tx_id, cache_result);

    Ok(())
}

/// Checks if the given signature is cached.
///
/// # Arguments
///
/// * `signature` - The signature to check.
///
/// # Returns
///
/// A `Result` containing a boolean indicating whether the signature is cached,
/// or an error if the signature could not be found in the cache.
///
/// # Errors
///
/// * `MomokaVerifierError::SignatureNotFound` - The signature could not be found in the cache.
fn cached_signature(signature: &str) -> Result<bool, MomokaVerifierError> {
    let cached: Option<Arc<()>> = read_signature_cache(signature);

    Ok(cached.is_some())
}

/// Processes timestamp proofs for a vector of transaction summaries.
///
/// # Arguments
///
/// * `transactions` - A slice of `TransactionSummary` structs to process proofs for.
/// * `provider_context` - The provider context.
///
/// # Returns
///
/// A vector of `Result<(), MomokaVerifierError>` indicating whether each transaction's proof was processed successfully.
///
/// # Examples
///
/// ```
/// # use momoka_rs::{process_proofs, EthereumNode, TransactionSummary};
///
/// let transactions = vec![/* ... */];
/// let provider_context = ProviderContext{(/* ... */)};
/// let results = process_proofs(&transactions, &provider_context).await;
/// ```
async fn process_proofs(
    mut transactions: Vec<TransactionSummary>,
    provider_context: &ProviderContext,
) -> Result<Vec<Result<(), MomokaVerifierError>>, MomokaVerifierError> {
    // to handle many TCP requests lets bulk grab the data if > 10 requests at once
    if transactions.len() > 10 {
        let pointer_tx_ids: HashMap<String, String> = transactions
            .iter()
            .filter_map(|transaction| {
                transaction.momoka_tx.pointer().ok().and_then(|pointer| {
                    pointer
                        .as_ref()
                        .map(|p| (transaction.id.clone(), p.location.replace("ar://", "")))
                })
            })
            .collect();

        let pointer_transactions = get_bulk_transactions_api(
            // remove duplicates as many transactions may point to the same transaction
            &pointer_tx_ids
                .values()
                .cloned()
                .collect::<HashSet<String>>()
                .into_iter()
                .collect::<Vec<String>>(),
        )
        .await?;

        for transaction in transactions.iter_mut() {
            if let Some(pointer_id) = pointer_tx_ids.get(&transaction.id) {
                if let Some(pointer_transaction) = pointer_transactions
                    .success
                    .iter()
                    .find(|t| t.id == *pointer_id)
                {
                    transaction
                        .set_pointer_transaction_summary(Box::new(pointer_transaction.clone()));
                }
            }
        }
    }

    let futures = transactions.iter().map(|transaction| async move {
        if let Some(pointer) = transaction.momoka_tx.pointer()? {
            let tx_id: &MomokaTxId = &pointer.location.replace("ar://", "");

            let cached = cached_tx_id(tx_id)?;
            if let Some(cached) = cached {
                cached.unwrap()
            }

            if transaction.pointer_transaction_summary.is_some() {
                process_proof(
                    transaction.pointer_transaction_summary.as_ref().unwrap(),
                    provider_context,
                )
                .await
                .map_err(|_| MomokaVerifierError::PointerFailedVerification)?;
            } else {
                let pointer_transaction = get_transaction_api(tx_id).await?;
                process_proof(&pointer_transaction, provider_context)
                    .await
                    .map_err(|_| MomokaVerifierError::PointerFailedVerification)?;
            }
        }

        let tx_cached = cached_tx_id(&transaction.id)?;
        if let Some(tx_cached) = tx_cached {
            tx_cached.unwrap()
        }

        let signature = transaction.momoka_tx.signature()?;

        let seen_signature = cached_signature(signature)?;
        if seen_signature {
            return Err(MomokaVerifierError::ChainSignatureAlreadyUsed);
        }

        let result: Result<(), MomokaVerifierError> =
            process_proof(transaction, provider_context).await;

        set_signature_cache(signature.to_owned());
        set_tx_cache(transaction.id.clone(), &result)?;

        match &result {
            Ok(()) => {
                Logger.success(&format!("{:?} - OK", transaction.id));
            }
            Err(err) => {
                Logger.error(&format!("{:?} -FAILED - {:?}", transaction.id, err));
            }
        }

        result
    });

    Ok(futures::future::join_all(futures).await)
}

/// Checks the proofs of a vector of transaction IDs using the provided Ethereum node.
///
/// # Arguments
///
/// * `tx_ids` - A vector of transaction IDs to check proofs for.
/// * `provider_context` - The provider context
///
/// # Returns
///
/// A vector of results, where each result represents the success or failure of checking the proof for
/// the corresponding transaction ID in the input vector.
///
/// # Examples
///
/// ```rust
/// # use momoka_rs::{check_proofs, EthereumNode};
///
/// #[tokio::main]
/// async fn main() {
///     let tx_ids = vec![
///         "dwKu4-ITFVZ_tsYhD0yj2LBYm32LGwiUqpkgg-BDZNE".to_string(),
///         "lwKu4-ITFVZ_tsYhD0yj2LBYm32LGwiUqpkgg-BDZNE".to_string(),
///         "qwKu4-ITFVZ_tsYhD0yj2LBYm32LGwiUqpkgg-BDZNE".to_string(),
///     ];
///
///     let provider_context = ProviderContext{(/* ... */)};
///
///     let results = check_proofs(&tx_ids, &provider_context).await;
///
///     for result in results {
///         match result {
///             Ok(_) => println!("Proof check succeeded"),
///             Err(e) => println!("Proof check failed: {:?}", e),
///         }
///     }
/// }
/// ```
pub async fn check_proofs(
    tx_ids: &Vec<MomokaTxId>,
    provider_context: &ProviderContext,
) -> Result<Vec<Result<(), MomokaVerifierError>>, MomokaVerifierError> {
    let amount = tx_ids.len();
    let is_bulk = amount > 999;
    if is_bulk {
        Logger.info(&format!("Fetching {} transactions from bundlr", amount));
    }

    let transactions = get_bulk_transactions_api(tx_ids).await?;

    if is_bulk {
        Logger.info(&format!("Fetched {} transactions from bundlr", amount));
    }

    for (id, error) in transactions.failed {
        Logger.error(&format!("{:?} - FAILED - {:?}", id, error));
    }

    Logger.info(&format!("Checking proofs for {} transactions", amount));

    process_proofs(transactions.success, provider_context).await
}

/// Asynchronously checks the proof for a single transaction ID and returns the result.
///
/// This method calls the `check_proofs` function internally with a single transaction ID and
/// returns the result of the first transaction. If the proof check is successful for the transaction,
/// it returns `Ok(())`. Otherwise, an appropriate error variant is returned.
///
/// # Arguments
///
/// * `tx_id` - A string slice representing the transaction ID to check the proof for.
/// * `provider_context` - A reference to the `ProviderContext` containing the necessary provider information.
///
/// # Returns
///
/// * `Ok(())` if the proof check is successful for the first transaction.
/// * An `Err` containing the appropriate `MomokaVerifierError` if the proof check fails for the first transaction,
///   or if the transaction ID is not found in the `check_proofs` results.
pub async fn check_proof(
    tx_id: &MomokaTxId,
    provider_context: &ProviderContext,
) -> Result<(), MomokaVerifierError> {
    let results = check_proofs(&vec![tx_id.to_string()], provider_context).await?;

    // Get the first result or return an error if the transaction ID is not found
    match results.get(0) {
        Some(Ok(())) => Ok(()),
        Some(Err(err)) => Err(err.clone()),
        None => panic!("Could not find the tx {:?}", tx_id),
    }
}
