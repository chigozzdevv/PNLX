#![no_std]

use governance_interface::GovernanceClient;
use intent_registry_interface::IntentRegistryClient;
use market_interface::{MarketClient, MarketPrice};
use position_state_interface::{AppendReceipt, PositionStateClient};
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contractimpl, contracttype, Address, Bytes, BytesN, Env, IntoVal,
    Symbol, Val, Vec, U256,
};

const MAX_PUBLIC_ITEMS: u32 = 8;
const FEE_EPOCH: u128 = 1;
const TAKER_FEE_PPM: u128 = 500;
const MAKER_REBATE_PPM: u128 = 150;
const INSURANCE_FEE_PPM: u128 = 100;
const BN254_SCALAR_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Batch(BytesN<32>, BytesN<32>),
    Governance,
    ProofLedger,
    MarketContract,
    PositionState,
    ShieldedPool,
    IntentRegistry,
    Circuit,
    FeeToken,
    ResidualMargin(BytesN<32>),
    ClaimedResidual(BytesN<32>),
}

#[derive(Clone)]
#[contracttype]
pub struct ProofMeta {
    pub circuit_id: BytesN<32>,
    pub circuit_hash: BytesN<32>,
    pub verifier_hash: BytesN<32>,
    pub public_input_hash: BytesN<32>,
    pub proof_digest: BytesN<32>,
}

#[derive(Clone)]
#[contracttype]
pub struct SettlementMeta {
    pub settlement_digest: BytesN<32>,
    pub first_position_index: u32,
    pub position_root: BytesN<32>,
    pub proof: ProofMeta,
    pub oracle_price: i128,
    pub oracle_timestamp: u64,
    pub volume: i128,
    pub residual: i128,
    pub fee_config_hash: BytesN<32>,
    pub gross_taker_fee: i128,
    pub maker_rebate: i128,
    pub insurance_fee: i128,
    pub treasury_fee: i128,
}

#[contractclient(name = "ShieldedPoolClient")]
pub trait ShieldedPoolInterface {
    fn token_digest(env: &Env, token: &Address) -> BytesN<32>;
    fn spend_secure(env: &Env, writer: &Address, root: &BytesN<32>, nullifier: &BytesN<32>);
    fn append_secure_note(env: &Env, writer: &Address, commitment: &BytesN<32>);
    fn deposit_claim_secure(
        env: &Env,
        writer: &Address,
        token: &Address,
        amount: &i128,
        commitment: &BytesN<32>,
        proof: &ProofMeta,
    );
    fn accrue_fees(env: &Env, writer: &Address, token: &Address, insurance: &i128, treasury: &i128);
}

#[contract]
pub struct BatchSettlement;

#[contractimpl]
impl BatchSettlement {
    pub fn init(
        env: Env,
        governance: Address,
        proof_ledger: Address,
        market_contract: Address,
        position_state: Address,
        shielded_pool: Address,
        intent_registry: Address,
        circuit_id: BytesN<32>,
    ) {
        validate_hash(&env, &circuit_id);
        if env.storage().persistent().has(&DataKey::Governance) {
            panic!("already initialized");
        }
        env.storage()
            .persistent()
            .set(&DataKey::Governance, &governance);
        env.storage()
            .persistent()
            .set(&DataKey::ProofLedger, &proof_ledger);
        env.storage()
            .persistent()
            .set(&DataKey::MarketContract, &market_contract);
        env.storage()
            .persistent()
            .set(&DataKey::PositionState, &position_state);
        env.storage()
            .persistent()
            .set(&DataKey::ShieldedPool, &shielded_pool);
        env.storage()
            .persistent()
            .set(&DataKey::IntentRegistry, &intent_registry);
        env.storage()
            .persistent()
            .set(&DataKey::Circuit, &circuit_id);
    }

    pub fn configure_fee_token(env: Env, token: Address) {
        let governance_id: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Governance)
            .unwrap_or_else(|| panic!("not initialized"));
        GovernanceClient::new(&env, &governance_id)
            .admin()
            .require_auth();
        if let Some(configured) = env
            .storage()
            .persistent()
            .get::<_, Address>(&DataKey::FeeToken)
        {
            if configured != token {
                panic!("fee token already configured");
            }
            return;
        }
        env.storage().persistent().set(&DataKey::FeeToken, &token);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let governance_id: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Governance)
            .unwrap_or_else(|| panic!("not initialized"));
        GovernanceClient::new(&env, &governance_id)
            .upgrade_authority()
            .require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn settle(
        env: Env,
        batch_id: BytesN<32>,
        market_id: BytesN<32>,
        settlement_digest: BytesN<32>,
        proof: ProofMeta,
        filled_intents: Vec<BytesN<32>>,
        new_commitments: Vec<BytesN<32>>,
        margin_change_commitments: Vec<BytesN<32>>,
        spent_nullifiers: Vec<BytesN<32>>,
        matching_payload_commitments: Vec<BytesN<32>>,
        residual_commitments: Vec<BytesN<32>>,
        residual_margins: Vec<i128>,
        residual_payload_commitments: Vec<BytesN<32>>,
        volume: i128,
        residual: i128,
        fee_config_hash: BytesN<32>,
        gross_taker_fee: i128,
        maker_rebate: i128,
        insurance_fee: i128,
        treasury_fee: i128,
        maker_intents: Vec<BytesN<32>>,
        taker_intents: Vec<BytesN<32>>,
    ) {
        if volume <= 0 {
            panic!("invalid volume");
        }
        if residual < 0 {
            panic!("invalid residual");
        }
        if fee_config_hash != expected_fee_config_hash(&env) {
            panic!("fee configuration mismatch");
        }
        if gross_taker_fee < 0 || maker_rebate < 0 || insurance_fee < 0 || treasury_fee < 0 {
            panic!("negative fee amount");
        }
        if gross_taker_fee
            != maker_rebate
                .checked_add(insurance_fee)
                .and_then(|amount| amount.checked_add(treasury_fee))
                .unwrap_or_else(|| panic!("fee amount overflow"))
        {
            panic!("fee allocation mismatch");
        }
        validate_public_items(&env, &new_commitments, true);
        validate_public_items(&env, &margin_change_commitments, false);
        validate_public_items(&env, &spent_nullifiers, true);
        validate_public_items(&env, &maker_intents, true);
        validate_public_items(&env, &taker_intents, true);
        validate_public_items(&env, &matching_payload_commitments, true);
        if matching_payload_commitments.len() != filled_intents.len()
            || residual_commitments.len() != filled_intents.len()
            || residual_margins.len() != filled_intents.len()
            || residual_payload_commitments.len() != filled_intents.len()
        {
            panic!("intent payload count mismatch");
        }
        if maker_intents.len() != taker_intents.len()
            || maker_intents.len() * 2 != new_commitments.len()
        {
            panic!("fee execution count mismatch");
        }
        validate_proof(&env, &proof);
        validate_public_inputs(
            &env,
            &batch_id,
            &market_id,
            &settlement_digest,
            &filled_intents,
            &new_commitments,
            &margin_change_commitments,
            &spent_nullifiers,
            &matching_payload_commitments,
            &residual_commitments,
            &residual_margins,
            &residual_payload_commitments,
            residual,
            volume,
            &fee_config_hash,
            gross_taker_fee,
            maker_rebate,
            insurance_fee,
            treasury_fee,
            &maker_intents,
            &taker_intents,
            &proof,
        );
        let batch_key = DataKey::Batch(batch_id, market_id.clone());
        if env.storage().persistent().has(&batch_key) {
            panic!("batch settled");
        }
        validate_active_intents(&env, &filled_intents, &matching_payload_commitments,
            &spent_nullifiers);
        validate_execution_priority(&env, &filled_intents, &maker_intents, &taker_intents);
        spend_margin_nullifiers(&env, &spent_nullifiers);
        record_margin_changes(&env, &margin_change_commitments);
        consume_filled_intents(
            &env,
            &filled_intents,
            &residual_commitments,
            &residual_margins,
            &residual_payload_commitments,
        );
        let oracle = checked_market_price(&env, &market_id);
        let appended = append_positions(&env, &new_commitments);
        register_position_pairs(&env, &market_id, &new_commitments);
        accrue_fees(&env, insurance_fee, treasury_fee);

        let meta = SettlementMeta {
            settlement_digest: settlement_digest.clone(),
            first_position_index: appended.first_index,
            position_root: appended.root,
            proof,
            oracle_price: oracle.price,
            oracle_timestamp: oracle.timestamp,
            volume,
            residual,
            fee_config_hash,
            gross_taker_fee,
            maker_rebate,
            insurance_fee,
            treasury_fee,
        };
        env.storage().persistent().set(&batch_key, &meta);
    }

    pub fn residual_margin(env: Env, intent_commitment: BytesN<32>) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::ResidualMargin(intent_commitment))
            .unwrap_or(0)
    }

    pub fn claimed_residual(env: Env, intent_commitment: BytesN<32>) -> Option<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::ClaimedResidual(intent_commitment))
    }

    pub fn claim_residual(
        env: Env,
        intent_commitment: BytesN<32>,
        commitment: BytesN<32>,
        proof: ProofMeta,
    ) {
        let governance_id: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Governance)
            .unwrap_or_else(|| panic!("not initialized"));
        GovernanceClient::new(&env, &governance_id)
            .admin()
            .require_auth();
        validate_hash(&env, &commitment);
        let registry_id: Address = env
            .storage()
            .persistent()
            .get(&DataKey::IntentRegistry)
            .unwrap_or_else(|| panic!("not initialized"));
        if !IntentRegistryClient::new(&env, &registry_id).is_cancelled(&intent_commitment) {
            panic!("residual intent is not cancelled");
        }
        let key = DataKey::ResidualMargin(intent_commitment.clone());
        let amount: i128 = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic!("residual claim unavailable"));
        if amount <= 0 {
            panic!("invalid residual claim");
        }
        let pool_id: Address = env
            .storage()
            .persistent()
            .get(&DataKey::ShieldedPool)
            .unwrap_or_else(|| panic!("not initialized"));
        let token: Address = env
            .storage()
            .persistent()
            .get(&DataKey::FeeToken)
            .unwrap_or_else(|| panic!("fee token not configured"));
        let writer = env.current_contract_address();
        let _asset=collateral_asset(&env);
        env.storage().persistent().remove(&key);
        env.storage()
            .persistent()
            .set(&DataKey::ClaimedResidual(intent_commitment), &commitment);
        authorize_as_writer(
            &env,
            pool_id.clone(),
            "deposit_claim_secure",
            Vec::from_array(
                &env,
                [
                    writer.clone().into_val(&env),
                    token.clone().into_val(&env),
                    amount.into_val(&env),
                    commitment.clone().into_val(&env),
                    proof.clone().into_val(&env),
                ],
            ),
        );
        ShieldedPoolClient::new(&env, &pool_id).deposit_claim_secure(
            &writer,
            &token,
            &amount,
            &commitment,
            &proof,
        );
    }

    pub fn has_root(env: Env, root: BytesN<32>) -> bool {
        let position_state_id: Address = env
            .storage()
            .persistent()
            .get(&DataKey::PositionState)
            .unwrap_or_else(|| panic!("not initialized"));
        PositionStateClient::new(&env, &position_state_id).has_root(&root)
    }

    pub fn is_settled(env: Env, batch_id: BytesN<32>, market_id: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Batch(batch_id, market_id))
    }

    pub fn is_settled_digest(
        env: Env,
        batch_id: BytesN<32>,
        market_id: BytesN<32>,
        settlement_digest: BytesN<32>,
    ) -> bool {
        env.storage()
            .persistent()
            .get::<_, SettlementMeta>(&DataKey::Batch(batch_id, market_id))
            .is_some_and(|meta| meta.settlement_digest == settlement_digest)
    }

    pub fn settlement_meta(
        env: Env,
        batch_id: BytesN<32>,
        market_id: BytesN<32>,
    ) -> SettlementMeta {
        env.storage()
            .persistent()
            .get(&DataKey::Batch(batch_id, market_id))
            .unwrap_or_else(|| panic!("batch not settled"))
    }
}

fn register_position_pairs(env: &Env, market: &BytesN<32>, commitments: &Vec<BytesN<32>>) {
    let asset=collateral_asset(env);
    let state: Address = env.storage().persistent().get(&DataKey::PositionState).unwrap();
    let writer = env.current_contract_address();
    let client = PositionStateClient::new(env, &state);
    let mut i = 0;
    while i < commitments.len() {
        let first = commitments.get(i).unwrap();
        let second = commitments.get(i + 1).unwrap();
        authorize_as_writer(env, state.clone(), "register_pair", Vec::from_array(env, [
            writer.clone().into_val(env), first.clone().into_val(env), second.clone().into_val(env),
            market.clone().into_val(env), asset.clone().into_val(env)]));
        client.register_pair(&writer, &first, &second, market, &asset);
        i += 2;
    }
}

fn collateral_asset(env:&Env)->BytesN<32> {
    let pool: Address = env.storage().persistent().get(&DataKey::ShieldedPool).unwrap();
    let token: Address = env.storage().persistent().get(&DataKey::FeeToken)
        .unwrap_or_else(|| panic!("collateral token not configured"));
    let asset = ShieldedPoolClient::new(env, &pool).token_digest(&token);
    let registry:Address=env.storage().persistent().get(&DataKey::IntentRegistry).unwrap();
    if IntentRegistryClient::new(env,&registry).collateral_digest()!=asset {
        panic!("collateral asset mismatch");
    }
    asset
}

fn expected_fee_config_hash(env: &Env) -> BytesN<32> {
    let mut fees = Bytes::new(env);
    append_u128_field(env, &mut fees, FEE_EPOCH);
    append_u128_field(env, &mut fees, TAKER_FEE_PPM);
    append_u128_field(env, &mut fees, MAKER_REBATE_PPM);
    append_u128_field(env, &mut fees, INSURANCE_FEE_PPM);
    env.crypto().sha256(&fees).to_bytes()
}

fn validate_execution_priority(
    env: &Env,
    filled_intents: &Vec<BytesN<32>>,
    maker_intents: &Vec<BytesN<32>>,
    taker_intents: &Vec<BytesN<32>>,
) {
    let registry_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::IntentRegistry)
        .unwrap_or_else(|| panic!("not initialized"));
    let registry = IntentRegistryClient::new(env, &registry_id);
    for index in 0..maker_intents.len() {
        let maker = maker_intents.get(index).unwrap();
        let taker = taker_intents.get(index).unwrap();
        if maker == taker || !filled_intents.contains(&maker) || !filled_intents.contains(&taker) {
            panic!("invalid maker/taker pair");
        }
        if registry.submission_sequence(&maker) >= registry.submission_sequence(&taker) {
            panic!("maker must be the resting intent");
        }
    }
}

fn accrue_fees(env: &Env, insurance: i128, treasury: i128) {
    if insurance == 0 && treasury == 0 {
        return;
    }
    let token: Address = env
        .storage()
        .persistent()
        .get(&DataKey::FeeToken)
        .unwrap_or_else(|| panic!("fee token not configured"));
    let pool_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::ShieldedPool)
        .unwrap_or_else(|| panic!("not initialized"));
    let writer = env.current_contract_address();
    authorize_as_writer(
        env,
        pool_id.clone(),
        "accrue_fees",
        Vec::from_array(
            env,
            [
                writer.clone().into_val(env),
                token.clone().into_val(env),
                insurance.into_val(env),
                treasury.into_val(env),
            ],
        ),
    );
    ShieldedPoolClient::new(env, &pool_id).accrue_fees(&writer, &token, &insurance, &treasury);
}

fn spend_margin_nullifiers(env: &Env, nullifiers: &Vec<BytesN<32>>) {
    let shielded_pool_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::ShieldedPool)
        .unwrap_or_else(|| panic!("not initialized"));
    let writer = env.current_contract_address();
    let pool = ShieldedPoolClient::new(env, &shielded_pool_id);
    let registry_id: Address = env.storage().persistent().get(&DataKey::IntentRegistry)
        .unwrap_or_else(|| panic!("not initialized"));
    let registry = IntentRegistryClient::new(env, &registry_id);
    for nullifier in nullifiers.iter() {
        let root = registry.nullifier_root(&nullifier);
        authorize_as_writer(
            env,
            shielded_pool_id.clone(),
            "spend_secure",
            Vec::from_array(
                env,
                [
                    writer.clone().into_val(env),
                    root.clone().into_val(env),
                    nullifier.clone().into_val(env),
                ],
            ),
        );
        pool.spend_secure(&writer, &root, &nullifier);
    }
}

fn validate_active_intents(
    env: &Env,
    filled_intents: &Vec<BytesN<32>>,
    payloads: &Vec<BytesN<32>>,
    nullifiers: &Vec<BytesN<32>>,
) {
    validate_public_items(env, filled_intents, true);

    let registry_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::IntentRegistry)
        .unwrap_or_else(|| panic!("not initialized"));
    let registry = IntentRegistryClient::new(env, &registry_id);
    let mut seen = Vec::<BytesN<32>>::new(env);
    let mut expected_nullifiers = Vec::<BytesN<32>>::new(env);

    for (index, intent) in filled_intents.iter().enumerate() {
        if seen.contains(&intent) {
            panic!("duplicate intent");
        }
        if !registry.is_active_intent(&intent) {
            panic!("inactive intent");
        }
        if registry.matching_payload_commitment(&intent) != payloads.get(index as u32).unwrap() {
            panic!("registered intent payload mismatch");
        }
        let nullifier = registry.intent_nullifier(&intent);
        if !expected_nullifiers.contains(&nullifier) {
            expected_nullifiers.push_back(nullifier);
        }
        seen.push_back(intent);
    }
    if expected_nullifiers.len() != nullifiers.len() {
        panic!("registered note nullifier count mismatch");
    }
    for nullifier in nullifiers.iter() {
        if !expected_nullifiers.contains(&nullifier) {
            panic!("unregistered note nullifier in settlement");
        }
    }
}

fn consume_filled_intents(
    env: &Env,
    filled_intents: &Vec<BytesN<32>>,
    residuals: &Vec<BytesN<32>>,
    residual_margins: &Vec<i128>,
    residual_payloads: &Vec<BytesN<32>>,
) {
    let registry_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::IntentRegistry)
        .unwrap_or_else(|| panic!("not initialized"));
    let registry = IntentRegistryClient::new(env, &registry_id);

    let zero = BytesN::from_array(env, &[0; 32]);
    let writer = env.current_contract_address();
    for (index, intent) in filled_intents.iter().enumerate() {
        let residual = residuals.get(index as u32).unwrap();
        let margin = residual_margins.get(index as u32).unwrap();
        let payload = residual_payloads.get(index as u32).unwrap();
        let previous_margin: Option<i128> = env
            .storage()
            .persistent()
            .get(&DataKey::ResidualMargin(intent.clone()));
        if let Some(previous) = previous_margin {
            if margin >= previous {
                panic!("residual margin must decrease");
            }
            env.storage()
                .persistent()
                .remove(&DataKey::ResidualMargin(intent.clone()));
        }
        if residual == zero {
            if payload != zero || margin != 0 {
                panic!("unexpected residual payload");
            }
            authorize_as_writer(
                env,
                registry_id.clone(),
                "consume",
                Vec::from_array(
                    env,
                    [writer.clone().into_val(env), intent.clone().into_val(env)],
                ),
            );
            registry.consume(&writer, &intent);
        } else {
            if margin <= 0 {
                panic!("invalid residual margin");
            }
            if payload == zero {
                panic!("missing residual payload");
            }
            validate_hash(env, &residual);
            validate_hash(env, &payload);
            env.storage()
                .persistent()
                .set(&DataKey::ResidualMargin(residual.clone()), &margin);
            authorize_as_writer(
                env,
                registry_id.clone(),
                "rollover",
                Vec::from_array(
                    env,
                    [
                        writer.clone().into_val(env),
                        intent.clone().into_val(env),
                        residual.clone().into_val(env),
                        payload.clone().into_val(env),
                    ],
                ),
            );
            registry.rollover(&writer, &intent, &residual, &payload);
        }
    }
}

fn record_margin_changes(env: &Env, commitments: &Vec<BytesN<32>>) {
    let pool_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::ShieldedPool)
        .unwrap_or_else(|| panic!("not initialized"));
    let pool = ShieldedPoolClient::new(env, &pool_id);
    let writer = env.current_contract_address();
    for commitment in commitments.iter() {
        authorize_as_writer(env, pool_id.clone(), "append_secure_note",
            Vec::from_array(env, [writer.clone().into_val(env),
                commitment.clone().into_val(env)]));
        pool.append_secure_note(&writer, &commitment);
    }
}

fn validate_public_items(env: &Env, values: &Vec<BytesN<32>>, require_non_empty: bool) {
    if require_non_empty && values.is_empty() {
        panic!("missing public items");
    }
    if values.len() > MAX_PUBLIC_ITEMS {
        panic!("too many public items");
    }

    for value in values.iter() {
        validate_hash(env, &value);
    }
}

fn append_positions(env: &Env, commitments: &Vec<BytesN<32>>) -> AppendReceipt {
    let position_state_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::PositionState)
        .unwrap_or_else(|| panic!("not initialized"));
    let writer = env.current_contract_address();
    authorize_as_writer(
        env,
        position_state_id.clone(),
        "append_many",
        Vec::from_array(
            env,
            [
                writer.clone().into_val(env),
                commitments.clone().into_val(env),
            ],
        ),
    );
    PositionStateClient::new(env, &position_state_id).append_many(&writer, commitments)
}

fn authorize_as_writer(env: &Env, contract: Address, fn_name: &str, args: Vec<Val>) {
    let invocation = InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract,
            fn_name: Symbol::new(env, fn_name),
            args,
        },
        sub_invocations: Vec::new(env),
    });
    env.authorize_as_current_contract(Vec::from_array(env, [invocation]));
}

fn validate_proof(env: &Env, proof: &ProofMeta) {
    validate_hash(env, &proof.circuit_id);
    validate_hash(env, &proof.circuit_hash);
    validate_hash(env, &proof.verifier_hash);
    validate_hash(env, &proof.public_input_hash);
    validate_hash(env, &proof.proof_digest);

    let circuit_id: BytesN<32> = env
        .storage()
        .persistent()
        .get(&DataKey::Circuit)
        .unwrap_or_else(|| panic!("not initialized"));
    if proof.circuit_id != circuit_id {
        panic!("circuit mismatch");
    }

    let governance_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Governance)
        .unwrap_or_else(|| panic!("not initialized"));
    let governance = GovernanceClient::new(env, &governance_id);
    if governance.paused() {
        panic!("paused");
    }

    let expected = governance.verifier(&circuit_id);
    if proof.verifier_hash != expected {
        panic!("verifier mismatch");
    }

    let proof_ledger_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::ProofLedger)
        .unwrap_or_else(|| panic!("not initialized"));
    let proof_ledger = ProofLedgerClient::new(env, &proof_ledger_id);
    if !proof_ledger.has_proof(
        &proof.circuit_id,
        &proof.verifier_hash,
        &proof.public_input_hash,
        &proof.proof_digest,
    ) {
        panic!("unverified proof");
    }
}

fn checked_market_price(env: &Env, market_id: &BytesN<32>) -> MarketPrice {
    let market_id_contract: Address = env
        .storage()
        .persistent()
        .get(&DataKey::MarketContract)
        .unwrap_or_else(|| panic!("not initialized"));
    let market = MarketClient::new(env, &market_id_contract);
    if !market.is_active(market_id) {
        panic!("inactive market");
    }
    let price = market.mark_price(market_id);
    if price.price <= 0 {
        panic!("invalid oracle price");
    }
    price
}

fn validate_public_inputs(
    env: &Env,
    batch_id: &BytesN<32>,
    market_id: &BytesN<32>,
    settlement_digest: &BytesN<32>,
    filled_intents: &Vec<BytesN<32>>,
    new_commitments: &Vec<BytesN<32>>,
    margin_change_commitments: &Vec<BytesN<32>>,
    spent_nullifiers: &Vec<BytesN<32>>,
    matching_payload_commitments: &Vec<BytesN<32>>,
    residual_commitments: &Vec<BytesN<32>>,
    residual_margins: &Vec<i128>,
    residual_payload_commitments: &Vec<BytesN<32>>,
    residual: i128,
    volume: i128,
    fee_config_hash: &BytesN<32>,
    gross_taker_fee: i128,
    maker_rebate: i128,
    insurance_fee: i128,
    treasury_fee: i128,
    maker_intents: &Vec<BytesN<32>>,
    taker_intents: &Vec<BytesN<32>>,
    proof: &ProofMeta,
) {
    let expected = batch_public_input_hash(
        env,
        batch_id,
        market_id,
        settlement_digest,
        filled_intents,
        new_commitments,
        margin_change_commitments,
        spent_nullifiers,
        matching_payload_commitments,
        residual_commitments,
        residual_margins,
        residual_payload_commitments,
        residual as u128,
        volume as u128,
        fee_config_hash,
        gross_taker_fee as u128,
        maker_rebate as u128,
        insurance_fee as u128,
        treasury_fee as u128,
        maker_intents,
        taker_intents,
    );
    if proof.public_input_hash != expected {
        panic!("public input mismatch");
    }
}

fn batch_public_input_hash(
    env: &Env,
    batch_id: &BytesN<32>,
    market_id: &BytesN<32>,
    settlement_digest: &BytesN<32>,
    filled_intents: &Vec<BytesN<32>>,
    new_commitments: &Vec<BytesN<32>>,
    margin_change_commitments: &Vec<BytesN<32>>,
    spent_nullifiers: &Vec<BytesN<32>>,
    matching_payload_commitments: &Vec<BytesN<32>>,
    residual_commitments: &Vec<BytesN<32>>,
    residual_margins: &Vec<i128>,
    residual_payload_commitments: &Vec<BytesN<32>>,
    residual: u128,
    volume: u128,
    fee_config_hash: &BytesN<32>,
    gross_taker_fee: u128,
    maker_rebate: u128,
    insurance_fee: u128,
    treasury_fee: u128,
    maker_intents: &Vec<BytesN<32>>,
    taker_intents: &Vec<BytesN<32>>,
) -> BytesN<32> {
    let mut public_inputs = Bytes::new(env);
    append_field(env, &mut public_inputs, batch_id);
    append_field(env, &mut public_inputs, market_id);
    append_field(env, &mut public_inputs, settlement_digest);
    append_public_vec(env, &mut public_inputs, filled_intents);
    append_public_vec(env, &mut public_inputs, new_commitments);
    append_public_vec(env, &mut public_inputs, margin_change_commitments);
    append_public_vec(env, &mut public_inputs, spent_nullifiers);
    append_public_vec(env, &mut public_inputs, matching_payload_commitments);
    append_public_vec(env, &mut public_inputs, residual_commitments);
    append_public_amounts(env, &mut public_inputs, residual_margins);
    append_public_vec(env, &mut public_inputs, residual_payload_commitments);
    append_u128_field(env, &mut public_inputs, residual);
    append_u128_field(env, &mut public_inputs, volume);
    append_field(env, &mut public_inputs, fee_config_hash);
    append_u128_field(env, &mut public_inputs, gross_taker_fee);
    append_u128_field(env, &mut public_inputs, maker_rebate);
    append_u128_field(env, &mut public_inputs, insurance_fee);
    append_u128_field(env, &mut public_inputs, treasury_fee);
    append_public_vec(env, &mut public_inputs, maker_intents);
    append_public_vec(env, &mut public_inputs, taker_intents);
    env.crypto().sha256(&public_inputs).to_bytes()
}

fn append_public_vec(env: &Env, out: &mut Bytes, values: &Vec<BytesN<32>>) {
    append_u128_field(env, out, values.len() as u128);
    let zero = BytesN::from_array(env, &[0; 32]);
    let mut index = 0u32;
    while index < MAX_PUBLIC_ITEMS {
        if index < values.len() {
            append_field(env, out, &values.get(index).unwrap());
        } else {
            append_field(env, out, &zero);
        }
        index += 1;
    }
}

fn append_public_amounts(env: &Env, out: &mut Bytes, values: &Vec<i128>) {
    append_u128_field(env, out, values.len() as u128);
    let mut index = 0u32;
    while index < MAX_PUBLIC_ITEMS {
        let amount = if index < values.len() {
            values.get(index).unwrap()
        } else {
            0
        };
        if amount < 0 {
            panic!("negative residual margin");
        }
        append_u128_field(env, out, amount as u128);
        index += 1;
    }
}

fn append_u128_field(env: &Env, out: &mut Bytes, value: u128) {
    let encoded = U256::from_u128(env, value).to_be_bytes();
    out.append(&encoded);
}

fn append_field(env: &Env, out: &mut Bytes, value: &BytesN<32>) {
    out.append(&field_bytes(env, value));
}

fn field_bytes(env: &Env, value: &BytesN<32>) -> Bytes {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_SCALAR_MODULUS_BE));
    U256::from_be_bytes(env, &Bytes::from_array(env, &value.to_array()))
        .rem_euclid(&modulus)
        .to_be_bytes()
}

fn validate_hash(env: &Env, value: &BytesN<32>) {
    if *value == BytesN::from_array(env, &[0; 32]) {
        panic!("invalid proof");
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{BatchSettlement, BatchSettlementClient, DataKey, ProofMeta};
    use governance::{Governance, GovernanceClient};
    use intent_registry::{IntentRegistry, IntentRegistryClient};
    use market::{Market, MarketClient};
    use oracle_interface::OracleAsset;
    use position_state::{PositionState, PositionStateClient};
    use proof_ledger::{ProofLedger, ProofLedgerClient};
    use shielded_pool::{ShieldedPool, ShieldedPoolClient};
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        token::StellarAssetClient,
        Address, Bytes, BytesN, Env, Symbol, Vec,
    };
    use test_oracle::{TestOracle, TestOracleClient};

    #[test]
    fn settles_batch() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let shielded_pool = setup_shielded_pool(&env, &id);
        let intent_registry = setup_intent_registry(&env, &id, &shielded_pool, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &shielded_pool,
            &intent_registry,
            &circuit(&env),
        );
        client.configure_fee_token(&fixture_collateral_token(&env,&intent_registry));

        let filled = filled_intents(&env);
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled,
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled),
            &zero_residuals(&env, &filled),
            &zero_residual_margins(&env, &filled),
            &zero_residuals(&env, &filled),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
        assert!(client.is_settled(&batch, &market));
        let registry = IntentRegistryClient::new(&env, &intent_registry);
        for intent in filled.iter() {
            assert!(!registry.is_active_intent(&intent));
            assert!(registry.is_cancelled(&intent));
        }
        let pool = ShieldedPoolClient::new(&env, &shielded_pool);
        for nullifier in spent_nullifiers(&env).iter() {
            assert!(pool.is_spent(&nullifier));
        }
    }

    #[test]
    fn measures_execution_capacity_under_default_resource_limits() {
        for executions in 1..=4u8 {
            let env=Env::default();env.mock_all_auths();
            let id=env.register(BatchSettlement,());
            let client=BatchSettlementClient::new(&env,&id);
            let pool_id=setup_shielded_pool(&env,&id);
            let registry_id=setup_intent_registry(&env,&id,&pool_id,false);
            let registry=IntentRegistryClient::new(&env,&registry_id);
            let ledger_id:Address=env.as_contract(&registry_id,||env.storage().persistent().get(&intent_registry::DataKey::ProofLedger).unwrap());
            let ledger=ProofLedgerClient::new(&env,&ledger_id);
            let batch=BytesN::from_array(&env,&[1;32]);let market=BytesN::from_array(&env,&[2;32]);
            let root=ShieldedPoolClient::new(&env,&pool_id).secure_note_root();
            let collateral=registry.collateral_digest();
            let mut filled=filled_intents(&env);let mut nullifiers=spent_nullifiers(&env);
            let mut payloads=payloads(&env,&filled);
            for index in 2..executions*2 {
                env.cost_estimate().budget().reset_default();
                let intent=BytesN::from_array(&env,&[50+index;32]);
                let payload=BytesN::from_array(&env,&[70+index;32]);
                let nullifier=BytesN::from_array(&env,&[90+index;32]);
                let change=BytesN::from_array(&env,&[0;32]);
                let mut fields=Bytes::new(&env);super::append_field(&env,&mut fields,&collateral);
                super::append_u128_field(&env,&mut fields,1);
                for value in [&batch,&market,&intent,&root,&nullifier,&change,&payload]{super::append_field(&env,&mut fields,value);}
                let validity=intent_registry::ProofMeta{circuit_id:BytesN::from_array(&env,&[40;32]),
                    verifier_hash:BytesN::from_array(&env,&[41;32]),circuit_hash:BytesN::from_array(&env,&[43;32]),
                    public_input_hash:env.crypto().sha256(&fields).to_bytes(),proof_digest:BytesN::from_array(&env,&[44;32])};
                ledger.record(&registry.operator(),&validity.circuit_id,&validity.verifier_hash,&validity.public_input_hash,&validity.proof_digest);
                registry.submit(&batch,&market,&intent,&payload,&root,&nullifier,&1,&change,&validity);
                filled.push_back(intent);payloads.push_back(payload);nullifiers.push_back(nullifier);
            }
            let mut commitments=Vec::new(&env);let mut makers=Vec::new(&env);let mut takers=Vec::new(&env);
            env.cost_estimate().budget().reset_default();
            for index in 0..executions*2 {
                let mut value=[0u8;32];value[31]=110+index;
                commitments.push_back(BytesN::from_array(&env,&value));
                if index%2==0{makers.push_back(filled.get_unchecked(index as u32));}
                else{takers.push_back(filled.get_unchecked(index as u32));}
            }
            let zeros=zero_residuals(&env,&filled);let margins=zero_residual_margins(&env,&filled);
            let changes=Vec::new(&env);
            let mut proved=proof(&env);
            proved.public_input_hash=super::batch_public_input_hash(&env,&batch,&market,&settlement_digest(&env),
                &filled,&commitments,&changes,&nullifiers,&payloads,&zeros,&margins,&zeros,0,2,
                &super::expected_fee_config_hash(&env),0,0,0,0,&makers,&takers);
            client.init(&setup_governance(&env),&setup_proof_ledger(&env,Some(&proved)),
                &setup_market(&env,&market,50_000_00000000,950,true),&setup_position_state(&env,&id),
                &pool_id,&registry_id,&circuit(&env));
            client.configure_fee_token(&fixture_collateral_token(&env,&registry_id));
            env.cost_estimate().budget().reset_default();
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||client.try_settle(&batch,&market,&settlement_digest(&env),&proved,&filled,&commitments,
                &changes,&nullifiers,&payloads,&zeros,&margins,&zeros,&2,&0,&super::expected_fee_config_hash(&env),
                &0,&0,&0,&0,&makers,&takers)));
            let accepted=result.map(|value|value.is_ok()).unwrap_or(false);
            let cpu=env.cost_estimate().budget().cpu_instruction_cost();
            std::println!("default-budget executions={} accepted={} cpu={}",executions,accepted,cpu);
            env.cost_estimate().budget().reset_default();
            assert_eq!(accepted,executions<=2);
        }
    }

    #[test]
    fn partial_fill_registers_cancellable_residual_margin_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let filled = filled_intents(&env);
        let residual = BytesN::from_array(&env, &[41; 32]);
        let residual_payload = BytesN::from_array(&env, &[42; 32]);
        let residuals =
            Vec::from_array(&env, [residual.clone(), BytesN::from_array(&env, &[0; 32])]);
        let residual_payloads = Vec::from_array(
            &env,
            [residual_payload.clone(), BytesN::from_array(&env, &[0; 32])],
        );
        let change = BytesN::from_array(&env, &[43; 32]);
        let second_change=BytesN::from_array(&env,&[44;32]);
        let changes = Vec::from_array(&env, [change.clone(),second_change.clone()]);
        let mut proved = proof(&env);
        proved.public_input_hash = super::batch_public_input_hash(
            &env,
            &batch,
            &market,
            &settlement_digest(&env),
            &filled,
            &new_commitments(&env),
            &changes,
            &spent_nullifiers(&env),
            &payloads(&env, &filled),
            &residuals,
            &Vec::from_array(&env, [5i128, 0]),
            &residual_payloads,
            1,
            2,
            &super::expected_fee_config_hash(&env),
            0,
            0,
            0,
            0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        let registry = IntentRegistryClient::new(&env, &registry_id);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proved)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );
        client.configure_fee_token(&fixture_collateral_token(&env,&registry_id));
        let source_sequence = registry.submission_sequence(&intent_a(&env));
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proved,
            &filled,
            &new_commitments(&env),
            &changes,
            &spent_nullifiers(&env),
            &payloads(&env, &filled),
            &residuals,
            &Vec::from_array(&env, [5i128, 0]),
            &residual_payloads,
            &2,
            &1,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
        assert!(registry.is_cancelled(&intent_a(&env)));
        assert!(registry.is_active_intent(&residual));
        assert_eq!(client.residual_margin(&residual), 5);
        assert_eq!(registry.submission_sequence(&residual), source_sequence);
        assert_eq!(
            registry.matching_payload_commitment(&residual),
            residual_payload
        );
        assert!(ShieldedPoolClient::new(&env, &pool_id).has_commitment(&change));
        registry.cancel(&residual);
        assert!(!registry.is_active_intent(&residual));
    }

    #[test]
    fn cancelled_residual_claim_mints_one_proven_note() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let governance_id = setup_governance(&env);
        let governance = GovernanceClient::new(&env, &governance_id);
        let authority = Address::generate(&env);
        let deposit_circuit = BytesN::from_array(&env, &[31; 32]);
        governance.set_verifier(&deposit_circuit, &verifier(&env), &authority);
        let ledger_id = env.register(ProofLedger, ());
        let ledger = ProofLedgerClient::new(&env, &ledger_id);
        ledger.init(&governance_id);
        let pool_id = env.register(ShieldedPool, ());
        let pool = ShieldedPoolClient::new(&env, &pool_id);
        pool.init(
            &governance_id,
            &ledger_id,
            &deposit_circuit,
            &BytesN::from_array(&env, &[32; 32]),
        );
        pool.set_writer(&id, &true);
        pool.configure_secure_note_circuits(&deposit_circuit, &BytesN::from_array(&env, &[34; 32]));
        pool.disable_legacy_notes();
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        let registry = IntentRegistryClient::new(&env, &registry_id);
        let token=fixture_collateral_token(&env,&registry_id);
        client.init(
            &governance_id,
            &ledger_id,
            &Address::generate(&env),
            &Address::generate(&env),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );
        client.configure_fee_token(&token);
        let residual = intent_a(&env);
        env.as_contract(&id, || {
            env.storage()
                .persistent()
                .set(&DataKey::ResidualMargin(residual.clone()), &5i128);
        });
        let commitment = BytesN::from_array(&env, &[17; 32]);
        let mut inputs = Bytes::new(&env);
        super::append_u128_field(&env, &mut inputs, 5);
        super::append_field(&env, &mut inputs, &pool.token_digest(&token));
        super::append_field(&env, &mut inputs, &commitment);
        let deposit_proof = ProofMeta {
            circuit_id: deposit_circuit,
            circuit_hash: BytesN::from_array(&env, &[6; 32]),
            verifier_hash: verifier(&env),
            public_input_hash: env.crypto().sha256(&inputs).to_bytes(),
            proof_digest: BytesN::from_array(&env, &[12; 32]),
        };
        ledger.record(
            &authority,
            &deposit_proof.circuit_id,
            &deposit_proof.verifier_hash,
            &deposit_proof.public_input_hash,
            &deposit_proof.proof_digest,
        );
        assert!(client
            .try_claim_residual(&residual, &commitment, &deposit_proof)
            .is_err());
        assert_eq!(client.residual_margin(&residual), 5);
        registry.cancel(&residual);
        client.claim_residual(&residual, &commitment, &deposit_proof);
        assert_eq!(client.residual_margin(&residual), 0);
        assert_eq!(client.claimed_residual(&residual), Some(commitment.clone()));
        assert!(pool.has_commitment(&commitment));
        assert!(client
            .try_claim_residual(&residual, &commitment, &deposit_proof)
            .is_err());
    }

    #[test]
    #[should_panic(expected = "registered intent payload mismatch")]
    fn rejects_proved_payload_that_differs_from_registered_intent() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let filled = filled_intents(&env);
        let mut payloads = payloads(&env, &filled);
        payloads.set(0, BytesN::from_array(&env, &[44; 32]));
        let mut proved = proof(&env);
        proved.public_input_hash = super::batch_public_input_hash(
            &env,
            &batch,
            &market,
            &settlement_digest(&env),
            &filled,
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads,
            &zero_residuals(&env, &filled),
            &zero_residual_margins(&env, &filled),
            &zero_residuals(&env, &filled),
            0,
            2,
            &super::expected_fee_config_hash(&env),
            0,
            0,
            0,
            0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
        let pool_id = setup_shielded_pool(&env, &id);
        let registry = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proved)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry,
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proved,
            &filled,
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads,
            &zero_residuals(&env, &filled),
            &zero_residual_margins(&env, &filled),
            &zero_residuals(&env, &filled),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    fn accrues_proven_fee_reserves_with_settlement() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let filled = filled_intents(&env);
        let commitments = new_commitments(&env);
        let changes = margin_change_commitments(&env);
        let nullifiers = spent_nullifiers(&env);
        let mut proof = proof(&env);
        proof.public_input_hash = super::batch_public_input_hash(
            &env,
            &batch,
            &market,
            &settlement_digest(&env),
            &filled,
            &commitments,
            &changes,
            &nullifiers,
            &payloads(&env, &filled),
            &zero_residuals(&env, &filled),
            &zero_residual_margins(&env, &filled),
            &zero_residuals(&env, &filled),
            0,
            2,
            &super::expected_fee_config_hash(&env),
            50,
            15,
            10,
            25,
            &fee_makers(&env),
            &fee_takers(&env),
        );
        let pool_id = setup_shielded_pool(&env, &id);
        let registry = setup_intent_registry(&env, &id, &pool_id, false);
        let token=fixture_collateral_token(&env,&registry);
        StellarAssetClient::new(&env, &token).mint(&pool_id, &100);
        ShieldedPoolClient::new(&env, &pool_id).configure_fee_destinations(
            &Address::generate(&env),
            &Address::generate(&env),
        );
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry,
            &circuit(&env),
        );
        client.configure_fee_token(&token);
        client.configure_fee_token(&token);
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled,
            &commitments,
            &changes,
            &nullifiers,
            &payloads(&env, &filled),
            &zero_residuals(&env, &filled),
            &zero_residual_margins(&env, &filled),
            &zero_residuals(&env, &filled),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &50,
            &15,
            &10,
            &25,
            &fee_makers(&env),
            &fee_takers(&env),
        );
        let reserve = ShieldedPoolClient::new(&env, &pool_id).fee_reserve(&token);
        assert_eq!(reserve.insurance, 10);
        assert_eq!(reserve.treasury, 25);
        assert!(client.is_settled(&batch, &market));
        assert!(client.is_settled_digest(&batch, &market, &settlement_digest(&env)));
        assert!(!client.is_settled_digest(&batch, &market, &BytesN::from_array(&env, &[9; 32])));
        let meta = client.settlement_meta(&batch, &market);
        assert_eq!(meta.settlement_digest, settlement_digest(&env));
        assert_eq!(meta.gross_taker_fee, 50);
        assert_eq!(meta.maker_rebate, 15);
        assert_eq!(meta.insurance_fee, 10);
        assert_eq!(meta.treasury_fee, 25);
    }

    #[test]
    #[should_panic(expected = "maker must be the resting intent")]
    fn rejects_reversed_maker_priority() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let pool_id = setup_shielded_pool(&env, &id);
        let registry = setup_intent_registry(&env, &id, &pool_id, false);
        env.as_contract(&id, || {
            env.storage()
                .persistent()
                .set(&super::DataKey::IntentRegistry, &registry);
            super::validate_execution_priority(
                &env,
                &filled_intents(&env),
                &fee_takers(&env),
                &fee_makers(&env),
            );
        });
    }

    #[test]
    fn settles_batch_with_high_byte_nonfield_inputs() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = high_bytes(&env, 0);
        let market = high_bytes(&env, 1);
        let settlement_digest = high_bytes(&env, 4);
        let filled = filled_intents(&env);
        let commitments = new_commitments(&env);
        let margin_changes = margin_change_commitments(&env);
        let spent = high_vec(&env, 7, 2);
        let proof = proof_with_inputs(
            &env,
            &batch,
            &market,
            &settlement_digest,
            &filled,
            &commitments,
            &margin_changes,
            &spent,
            0,
            2,
        );
        let pool_id = setup_shielded_pool(&env, &id);
        let intent_registry = setup_intent_registry_with_nullifiers(
            &env, &id, &pool_id, false, &spent.get(0).unwrap(), &spent.get(1).unwrap());
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &intent_registry,
            &circuit(&env),
        );
        client.configure_fee_token(&fixture_collateral_token(&env,&intent_registry));

        client.settle(
            &batch,
            &market,
            &settlement_digest,
            &proof,
            &filled,
            &commitments,
            &margin_changes,
            &spent,
            &payloads(&env, &filled),
            &zero_residuals(&env, &filled),
            &zero_residual_margins(&env, &filled),
            &zero_residuals(&env, &filled),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );

        assert!(client.is_settled(&batch, &market));
    }

    #[test]
    #[should_panic(expected = "public input mismatch")]
    fn rejects_settlement_argument_mismatch() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &3,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "batch settled")]
    fn rejects_duplicate_batch() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );
        client.configure_fee_token(&fixture_collateral_token(&env,&registry_id));

        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "invalid proof")]
    fn rejects_empty_proof() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = empty_proof(&env);
        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "verifier mismatch")]
    fn rejects_wrong_verifier() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);

        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance_with_verifier(&env, &BytesN::from_array(&env, &[10; 32])),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "circuit mismatch")]
    fn rejects_wrong_circuit() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);

        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &BytesN::from_array(&env, &[11; 32]),
        );
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "paused")]
    fn rejects_paused_protocol() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let governance = setup_governance(&env);
        let proof_ledger = setup_proof_ledger(&env, Some(&proof));
        let governance_client = GovernanceClient::new(&env, &governance);

        governance_client.set_paused(&true);
        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &governance,
            &proof_ledger,
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "unverified proof")]
    fn rejects_unregistered_proof() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);

        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, None),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "stale oracle price")]
    fn rejects_stale_market_oracle() {
        let env = Env::default();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);

        let market_contract = setup_market(&env, &market, 50_000_00000000, 950, true);
        set_market_oracle_price(&env, &market_contract, &market, 50_000_00000000, 700);
        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &market_contract,
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "inactive market")]
    fn rejects_inactive_market() {
        let env = Env::default();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);

        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, false),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );
        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "inactive intent")]
    fn rejects_cancelled_intent() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let proof = proof(&env);
        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, true);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &filled_intents(&env),
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &zero_residual_margins(&env, &filled_intents(&env)),
            &zero_residuals(&env, &filled_intents(&env)),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    #[test]
    #[should_panic(expected = "duplicate intent")]
    fn rejects_duplicate_filled_intent() {
        let env = Env::default();
        let id = env.register(BatchSettlement, ());
        let client = BatchSettlementClient::new(&env, &id);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let duplicate_intents = duplicate_filled_intents(&env);
        let proof = proof_with_intents(&env, &duplicate_intents);
        let pool_id = setup_shielded_pool(&env, &id);
        let registry_id = setup_intent_registry(&env, &id, &pool_id, false);
        client.init(
            &setup_governance(&env),
            &setup_proof_ledger(&env, Some(&proof)),
            &setup_market(&env, &market, 50_000_00000000, 950, true),
            &setup_position_state(&env, &id),
            &pool_id,
            &registry_id,
            &circuit(&env),
        );

        client.settle(
            &batch,
            &market,
            &settlement_digest(&env),
            &proof,
            &duplicate_intents,
            &new_commitments(&env),
            &margin_change_commitments(&env),
            &spent_nullifiers(&env),
            &payloads(&env, &duplicate_intents),
            &zero_residuals(&env, &duplicate_intents),
            &zero_residual_margins(&env, &duplicate_intents),
            &zero_residuals(&env, &duplicate_intents),
            &2,
            &0,
            &super::expected_fee_config_hash(&env),
            &0,
            &0,
            &0,
            &0,
            &fee_makers(&env),
            &fee_takers(&env),
        );
    }

    fn proof(env: &Env) -> ProofMeta {
        proof_with_intents(env, &filled_intents(env))
    }

    fn proof_with_intents(env: &Env, filled_intents: &Vec<BytesN<32>>) -> ProofMeta {
        let batch = BytesN::from_array(env, &[1; 32]);
        let market = BytesN::from_array(env, &[2; 32]);
        proof_with_inputs(
            env,
            &batch,
            &market,
            &settlement_digest(env),
            filled_intents,
            &new_commitments(env),
            &margin_change_commitments(env),
            &spent_nullifiers(env),
            0,
            2,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn proof_with_inputs(
        env: &Env,
        batch: &BytesN<32>,
        market: &BytesN<32>,
        settlement_digest: &BytesN<32>,
        filled_intents: &Vec<BytesN<32>>,
        new_commitments: &Vec<BytesN<32>>,
        margin_change_commitments: &Vec<BytesN<32>>,
        spent_nullifiers: &Vec<BytesN<32>>,
        residual: u128,
        volume: u128,
    ) -> ProofMeta {
        ProofMeta {
            circuit_id: circuit(env),
            circuit_hash: BytesN::from_array(env, &[6; 32]),
            verifier_hash: verifier(env),
            public_input_hash: super::batch_public_input_hash(
                env,
                batch,
                market,
                settlement_digest,
                filled_intents,
                new_commitments,
                margin_change_commitments,
                spent_nullifiers,
                &payloads(env, filled_intents),
                &zero_residuals(env, filled_intents),
                &zero_residual_margins(env, filled_intents),
                &zero_residuals(env, filled_intents),
                residual,
                volume,
                &super::expected_fee_config_hash(env),
                0,
                0,
                0,
                0,
                &fee_makers(env),
                &fee_takers(env),
            ),
            proof_digest: BytesN::from_array(env, &[9; 32]),
        }
    }

    fn settlement_digest(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[10; 32])
    }

    fn circuit(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[5; 32])
    }

    fn verifier(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[7; 32])
    }

    fn high_bytes(env: &Env, last: u8) -> BytesN<32> {
        let mut value = [0xff; 32];
        value[31] = last;
        BytesN::from_array(env, &value)
    }

    fn filled_intents(env: &Env) -> Vec<BytesN<32>> {
        let mut intents = Vec::new(env);
        intents.push_back(intent_a(env));
        intents.push_back(intent_b(env));
        intents
    }

    fn payloads(env: &Env, intents: &Vec<BytesN<32>>) -> Vec<BytesN<32>> {
        let mut result = Vec::new(env);
        for intent in intents.iter() {
            result.push_back(if intent == intent_a(env) {
                BytesN::from_array(env, &[21; 32])
            } else if intent == intent_b(env) {
                BytesN::from_array(env, &[22; 32])
            } else {
                BytesN::from_array(env, &[23; 32])
            });
        }
        result
    }

    fn zero_residual_margins(env: &Env, intents: &Vec<BytesN<32>>) -> Vec<i128> {
        let mut result = Vec::new(env);
        for _ in intents.iter() {
            result.push_back(0);
        }
        result
    }

    fn zero_residuals(env: &Env, intents: &Vec<BytesN<32>>) -> Vec<BytesN<32>> {
        let mut result = Vec::new(env);
        for _ in intents.iter() {
            result.push_back(BytesN::from_array(env, &[0; 32]));
        }
        result
    }

    fn fee_makers(env: &Env) -> Vec<BytesN<32>> {
        Vec::from_array(env, [intent_a(env)])
    }

    fn fee_takers(env: &Env) -> Vec<BytesN<32>> {
        Vec::from_array(env, [intent_b(env)])
    }

    fn duplicate_filled_intents(env: &Env) -> Vec<BytesN<32>> {
        let mut intents = Vec::new(env);
        intents.push_back(intent_a(env));
        intents.push_back(intent_a(env));
        intents
    }

    fn new_commitments(env: &Env) -> Vec<BytesN<32>> {
        let mut commitments = Vec::new(env);
        commitments.push_back(BytesN::from_array(env, &[13; 32]));
        commitments.push_back(BytesN::from_array(env, &[14; 32]));
        commitments
    }

    fn margin_change_commitments(env: &Env) -> Vec<BytesN<32>> {
        Vec::new(env)
    }

    fn spent_nullifiers(env: &Env) -> Vec<BytesN<32>> {
        let mut nullifiers = Vec::new(env);
        nullifiers.push_back(BytesN::from_array(env, &[15; 32]));
        nullifiers.push_back(BytesN::from_array(env, &[16; 32]));
        nullifiers
    }

    fn high_vec(env: &Env, first_last_byte: u8, len: u8) -> Vec<BytesN<32>> {
        let mut values = Vec::new(env);
        let mut index = 0u8;
        while index < len {
            values.push_back(high_bytes(env, first_last_byte + index));
            index += 1;
        }
        values
    }

    fn intent_a(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[11; 32])
    }

    fn intent_b(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[12; 32])
    }

    fn setup_governance(env: &Env) -> Address {
        setup_governance_with_verifier(env, &verifier(env))
    }

    fn setup_position_state(env: &Env, writer: &Address) -> Address {
        env.mock_all_auths();
        let state_id = env.register(PositionState, ());
        let state = PositionStateClient::new(env, &state_id);
        state.init(&setup_governance(env));
        state.set_writer(writer, &true);
        state_id
    }

    fn setup_shielded_pool(env: &Env, writer: &Address) -> Address {
        env.mock_all_auths();
        let pool_id = env.register(ShieldedPool, ());
        let pool = ShieldedPoolClient::new(env, &pool_id);
        pool.init(
            &setup_governance(env),
            &Address::generate(env),
            &BytesN::from_array(env, &[31; 32]),
            &BytesN::from_array(env, &[32; 32]),
        );
        pool.set_writer(writer, &true);
        pool.configure_secure_note_circuits(
            &BytesN::from_array(env, &[33; 32]),
            &BytesN::from_array(env, &[34; 32]),
        );
        pool.disable_legacy_notes();
        pool_id
    }

    fn setup_intent_registry(env: &Env, settler: &Address, pool_id: &Address, cancel_first: bool) -> Address {
        setup_intent_registry_with_nullifiers(env, settler, pool_id, cancel_first,
            &BytesN::from_array(env, &[15; 32]), &BytesN::from_array(env, &[16; 32]))
    }

    fn setup_intent_registry_with_nullifiers(env: &Env, settler: &Address, pool_id: &Address,
        cancel_first: bool, nullifier_a: &BytesN<32>, nullifier_b: &BytesN<32>) -> Address {
        let registry_id = env.register(IntentRegistry, ());
        let registry = IntentRegistryClient::new(env, &registry_id);
        env.mock_all_auths();
        let operator = Address::generate(env);
        registry.init(&operator, settler);
        registry.configure_secure_pool(pool_id);
        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        governance.init(&operator);
        let validity_circuit = BytesN::from_array(env, &[40;32]);
        let validity_verifier = BytesN::from_array(env, &[41;32]);
        let token=env.register_stellar_asset_contract_v2(Address::generate(env)).address();
        let collateral=ShieldedPoolClient::new(env,pool_id).token_digest(&token);
        env.as_contract(&registry_id,||env.storage().instance().set(&symbol_short!("testtoken"),&token));
        governance.set_verifier(&validity_circuit, &validity_verifier, &operator);
        let ledger_id = env.register(ProofLedger, ());
        let ledger = ProofLedgerClient::new(env, &ledger_id);
        ledger.init(&governance_id);
        registry.configure_validity(&governance_id, &ledger_id, &validity_circuit, &collateral);
        let root = ShieldedPoolClient::new(env, pool_id).secure_note_root();
        let batch = BytesN::from_array(env, &[1; 32]);
        let market = BytesN::from_array(env, &[2; 32]);
        let shares_a = BytesN::from_array(env, &[21; 32]);
        let shares_b = BytesN::from_array(env, &[22; 32]);

        let change = BytesN::from_array(env, &[0;32]);
        for (intent, shares, nullifier) in [(intent_a(env),shares_a,nullifier_a),(intent_b(env),shares_b,nullifier_b)] {
            let mut public_inputs=Bytes::new(env);
            super::append_field(env,&mut public_inputs,&collateral);
            super::append_u128_field(env,&mut public_inputs,1);
            for value in [&batch,&market,&intent,&root,nullifier,&change,&shares] {
                super::append_field(env,&mut public_inputs,value);
            }
            let proof=intent_registry::ProofMeta {circuit_id:validity_circuit.clone(),
                circuit_hash:BytesN::from_array(env,&[43;32]),verifier_hash:validity_verifier.clone(),
                public_input_hash:env.crypto().sha256(&public_inputs).to_bytes(),proof_digest:BytesN::from_array(env,&[44;32])};
            ledger.record(&operator,&proof.circuit_id,&proof.verifier_hash,&proof.public_input_hash,&proof.proof_digest);
            registry.submit(&batch,&market,&intent,&shares,&root,nullifier,&1,&change,&proof);
        }
        if cancel_first {
            registry.cancel(&intent_a(env));
        }
        registry_id
    }

    fn fixture_collateral_token(env:&Env,registry:&Address)->Address {
        env.as_contract(registry,||env.storage().instance().get(&symbol_short!("testtoken")).unwrap())
    }

    fn setup_governance_with_verifier(env: &Env, verifier_hash: &BytesN<32>) -> Address {
        env.mock_all_auths();
        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        let admin = Address::generate(env);
        let authority = Address::generate(env);

        governance.init(&admin);
        governance.set_verifier(&circuit(env), verifier_hash, &authority);
        governance_id
    }

    fn setup_proof_ledger(env: &Env, proof: Option<&ProofMeta>) -> Address {
        env.mock_all_auths();
        let authority = Address::generate(env);
        let governance = match proof {
            Some(proof) => setup_governance_with_authority(env, &proof.verifier_hash, &authority),
            None => setup_governance_with_authority(env, &verifier(env), &authority),
        };
        let ledger_id = env.register(ProofLedger, ());
        let ledger = ProofLedgerClient::new(env, &ledger_id);

        ledger.init(&governance);
        if let Some(proof) = proof {
            ledger.record(
                &authority,
                &proof.circuit_id,
                &proof.verifier_hash,
                &proof.public_input_hash,
                &proof.proof_digest,
            );
        }
        ledger_id
    }

    fn setup_market(
        env: &Env,
        market_id: &BytesN<32>,
        price: i128,
        timestamp: u64,
        active: bool,
    ) -> Address {
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle_id = env.register(TestOracle, ());
        let oracle = TestOracleClient::new(env, &oracle_id);
        oracle.init(&8);
        oracle.set_price(
            &OracleAsset::Other(Symbol::new(env, "BTC")),
            &price,
            &timestamp,
        );

        let market_contract = env.register(Market, ());
        let market = MarketClient::new(env, &market_contract);
        market.init(&setup_governance(env));
        market.upsert_other(
            market_id,
            &oracle_id,
            &symbol_short!("sep40"),
            &Symbol::new(env, "BTC"),
            &120,
            &1,
            &8,
            &5,
            &200_000,
            &100_000,
            &0,
            &active,
        );
        market_contract
    }

    fn set_market_oracle_price(
        env: &Env,
        market_contract: &Address,
        market_id: &BytesN<32>,
        price: i128,
        timestamp: u64,
    ) {
        let market = MarketClient::new(env, market_contract);
        let config = market.get(market_id);
        let oracle = TestOracleClient::new(env, &config.oracle_contract);
        oracle.set_price(
            &OracleAsset::Other(Symbol::new(env, "BTC")),
            &price,
            &timestamp,
        );
    }

    fn setup_governance_with_authority(
        env: &Env,
        verifier_hash: &BytesN<32>,
        authority: &Address,
    ) -> Address {
        env.mock_all_auths();
        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        let admin = Address::generate(env);

        governance.init(&admin);
        governance.set_verifier(&circuit(env), verifier_hash, authority);
        governance_id
    }

    fn empty_proof(env: &Env) -> ProofMeta {
        ProofMeta {
            circuit_id: BytesN::from_array(env, &[0; 32]),
            circuit_hash: BytesN::from_array(env, &[0; 32]),
            verifier_hash: BytesN::from_array(env, &[0; 32]),
            public_input_hash: BytesN::from_array(env, &[0; 32]),
            proof_digest: BytesN::from_array(env, &[0; 32]),
        }
    }
}
