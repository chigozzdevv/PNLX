#![no_std]

use governance_interface::GovernanceClient;
use market_interface::{MarketClient, MarketPrice};
use position_state_interface::{AppendReceipt, PositionStateClient};
use proof_ledger_interface::ProofLedgerClient;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN,
    Env, IntoVal, Symbol, Val, Vec, U256,
};

const PAIR_COUNT: u32 = 3;
const FIELD_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AllowedPair {
    pub market_id: BytesN<32>,
    pub asset_digest: BytesN<32>,
    pub position_commitments: Vec<BytesN<32>>,
    pub position_nullifiers: Vec<BytesN<32>>,
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
pub struct PairCloseArgs {
    pub market_id: BytesN<32>,
    pub mark_price: i128,
    pub liquidation: bool,
    pub position_root: BytesN<32>,
    pub position_commitments: Vec<BytesN<32>>,
    pub position_nullifiers: Vec<BytesN<32>>,
    pub close_commitments: Vec<BytesN<32>>,
    pub new_position_commitments: Vec<BytesN<32>>,
    pub margin_output_commitments: Vec<BytesN<32>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct CloseReceipt {
    pub ledger: u32,
    pub market_id: BytesN<32>,
    pub position_commitment: BytesN<32>,
    pub position_nullifier: BytesN<32>,
    pub new_position_commitment: BytesN<32>,
    pub margin_output_commitment: BytesN<32>,
    pub output_position_index: u32,
    pub output_position_root: BytesN<32>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct ExitReceipt {
    pub appended: AppendReceipt,
    pub ledger: u32,
    pub market_id: BytesN<32>,
    pub position_commitments: Vec<BytesN<32>>,
    pub position_nullifiers: Vec<BytesN<32>>,
    pub close_commitments: Vec<BytesN<32>>,
    pub new_position_commitments: Vec<BytesN<32>>,
    pub margin_output_commitments: Vec<BytesN<32>>,
    pub proof_digest: BytesN<32>,
}

#[derive(Clone)]
#[contracttype]
pub struct Configuration {
    pub governance: Address,
    pub proof_ledger: Address,
    pub market_contract: Address,
    pub position_state: Address,
    pub secure_pool: Address,
    pub circuit_id: BytesN<32>,
}

// The existing testnet Market exposes get(), rather than maintenance_rate().
#[derive(Clone)]
#[contracttype]
pub enum LegacyOracleAsset {
    Stellar(Address),
    Other(Symbol),
}

#[derive(Clone)]
#[contracttype]
pub struct LegacyMarketConfig {
    pub oracle_contract: Address,
    pub oracle_kind: Symbol,
    pub oracle_asset: LegacyOracleAsset,
    pub beam_fee_token: Option<Address>,
    pub oracle_max_age: u64,
    pub oracle_twap_records: u32,
    pub price_decimals: u32,
    pub max_leverage: i128,
    pub initial_rate: i128,
    pub maintenance_rate: i128,
    pub funding_index: i128,
    pub active: bool,
}

#[contractclient(name = "LegacyMarketClient")]
pub trait LegacyMarketInterface {
    fn get(env: Env, market_id: BytesN<32>) -> LegacyMarketConfig;
}

#[contractclient(name = "PoolClient")]
pub trait PoolInterface {
    fn append_secure_note(env: Env, writer: Address, commitment: BytesN<32>);
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Governance,
    ProofLedger,
    Market,
    PositionState,
    Pool,
    Circuit,
    AllowedPairs,
    Receipt(BytesN<32>),
    Close(BytesN<32>),
    Completed,
}

#[contract]
pub struct LegacyPairExit;

#[contractimpl]
impl LegacyPairExit {
    pub fn __constructor(
        env: Env, governance: Address, proof_ledger: Address, market_contract: Address,
        position_state: Address, secure_pool: Address, circuit_id: BytesN<32>, pairs: Vec<AllowedPair>,
    ) {
        GovernanceClient::new(&env, &governance).admin().require_auth();
        validate_hash(&env, &circuit_id);
        if pairs.len() != PAIR_COUNT { panic!("exactly three legacy pairs required"); }
        let mut commitments = Vec::<BytesN<32>>::new(&env);
        let mut nullifiers = Vec::<BytesN<32>>::new(&env);
        for pair in pairs.iter() {
            validate_hash(&env, &pair.market_id);
            validate_field(&env, &pair.asset_digest);
            validate_pair_values(&env, &pair.position_commitments);
            validate_pair_values(&env, &pair.position_nullifiers);
            for value in pair.position_commitments.iter() {
                if commitments.contains(&value) { panic!("legacy positions overlap"); }
                commitments.push_back(value);
            }
            for value in pair.position_nullifiers.iter() {
                if nullifiers.contains(&value) { panic!("legacy nullifiers overlap"); }
                nullifiers.push_back(value);
            }
        }
        let storage = env.storage().instance();
        storage.set(&DataKey::Governance, &governance);
        storage.set(&DataKey::ProofLedger, &proof_ledger);
        storage.set(&DataKey::Market, &market_contract);
        storage.set(&DataKey::PositionState, &position_state);
        storage.set(&DataKey::Pool, &secure_pool);
        storage.set(&DataKey::Circuit, &circuit_id);
        storage.set(&DataKey::AllowedPairs, &pairs);
        storage.set(&DataKey::Completed, &0u32);
    }

    pub fn allowed_pairs(env: Env) -> Vec<AllowedPair> {
        env.storage().instance().get(&DataKey::AllowedPairs).unwrap()
    }

    pub fn completed_pairs(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Completed).unwrap()
    }

    pub fn configuration(env: Env) -> Configuration {
        Configuration {
            governance: address(&env, DataKey::Governance),
            proof_ledger: address(&env, DataKey::ProofLedger),
            market_contract: address(&env, DataKey::Market),
            position_state: address(&env, DataKey::PositionState),
            secure_pool: address(&env, DataKey::Pool),
            circuit_id: env.storage().instance().get(&DataKey::Circuit).unwrap(),
        }
    }

    pub fn receipt(env: Env, first_position: BytesN<32>) -> Option<ExitReceipt> {
        env.storage().persistent().get(&DataKey::Receipt(first_position))
    }

    pub fn close_receipt(env: Env, close_commitment: BytesN<32>) -> Option<CloseReceipt> {
        env.storage().persistent().get(&DataKey::Close(close_commitment))
    }

    pub fn receipt_by_close(env: Env, close_commitment: BytesN<32>) -> Option<ExitReceipt> {
        for pair in Self::allowed_pairs(env.clone()).iter() {
            if let Some(receipt) = Self::receipt(env.clone(), pair.position_commitments.get_unchecked(0)) {
                if receipt.close_commitments.contains(&close_commitment) { return Some(receipt); }
            }
        }
        None
    }

    pub fn is_settled(env: Env, close_commitment: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Close(close_commitment))
    }

    pub fn closed_ledger(env: Env, close_commitment: BytesN<32>) -> u32 {
        let receipt: Option<CloseReceipt> = env.storage().persistent().get(&DataKey::Close(close_commitment));
        receipt.map(|value| value.ledger).unwrap_or(0)
    }

    pub fn output_position_index(env: Env, close_commitment: BytesN<32>) -> u32 {
        let receipt: CloseReceipt = env.storage().persistent().get(&DataKey::Close(close_commitment))
            .unwrap_or_else(|| panic!("unknown legacy close"));
        receipt.output_position_index
    }

    pub fn exit_pair(env: Env, args: PairCloseArgs, proof: ProofMeta) -> AppendReceipt {
        let governance_id = address(&env, DataKey::Governance);
        let governance = GovernanceClient::new(&env, &governance_id);
        governance.admin().require_auth();
        // Ordinary proof acceptance stays paused during this narrowly authorized recovery.
        if !governance.paused() { panic!("legacy exit requires paused protocol"); }
        if args.mark_price <= 0 { panic!("invalid mark price"); }
        validate_hash(&env, &args.market_id);
        validate_field(&env, &args.position_root);
        for values in [&args.position_commitments, &args.position_nullifiers, &args.close_commitments,
            &args.new_position_commitments, &args.margin_output_commitments] {
            validate_pair_values(&env, values);
        }
        let allowed = Self::allowed_pairs(env.clone()).iter().find(|pair|
            pair.market_id == args.market_id && pair.position_commitments == args.position_commitments
                && pair.position_nullifiers == args.position_nullifiers)
            .unwrap_or_else(|| panic!("legacy pair is not allowlisted"));
        let first = args.position_commitments.get_unchecked(0);
        if Self::receipt(env.clone(), first.clone()).is_some() { panic!("legacy pair already exited"); }
        for close in args.close_commitments.iter() {
            if Self::is_settled(env.clone(), close) { panic!("legacy close already used"); }
        }
        let market_id = address(&env, DataKey::Market);
        let config = LegacyMarketClient::new(&env, &market_id).get(&args.market_id);
        if !config.active || config.maintenance_rate <= 0 || config.maintenance_rate > 1_000_000
            || config.funding_index == i128::MIN { panic!("invalid market risk configuration"); }
        let MarketPrice { price, .. } = MarketClient::new(&env, &market_id).mark_price(&args.market_id);
        if price != args.mark_price { panic!("mark price mismatch"); }
        let circuit: BytesN<32> = env.storage().instance().get(&DataKey::Circuit).unwrap();
        for value in [&proof.circuit_id, &proof.circuit_hash, &proof.verifier_hash,
            &proof.public_input_hash, &proof.proof_digest] { validate_hash(&env, value); }
        if proof.circuit_id != circuit { panic!("legacy circuit mismatch"); }
        if governance.verifier(&circuit) != proof.verifier_hash { panic!("legacy verifier mismatch"); }
        let expected = pair_public_input_hash(&env, &args, &allowed.asset_digest,
            config.funding_index.unsigned_abs(), config.funding_index < 0, config.maintenance_rate as u128);
        if proof.public_input_hash != expected { panic!("legacy public input mismatch"); }
        if !ProofLedgerClient::new(&env, &address(&env, DataKey::ProofLedger)).has_proof(
            &circuit, &proof.verifier_hash, &proof.public_input_hash, &proof.proof_digest,
        ) { panic!("unverified legacy proof"); }
        let state_id = address(&env, DataKey::PositionState);
        let state = PositionStateClient::new(&env, &state_id);
        if !state.has_root(&args.position_root) { panic!("unknown legacy position root"); }
        let writer = env.current_contract_address();
        for i in 0..2 {
            let position = args.position_commitments.get_unchecked(i);
            let nullifier = args.position_nullifiers.get_unchecked(i);
            authorize(&env, &state_id, "spend_position", Vec::from_array(&env, [writer.clone().into_val(&env),
                args.position_root.clone().into_val(&env), position.clone().into_val(&env), nullifier.clone().into_val(&env)]));
            state.spend_position(&writer, &args.position_root, &position, &nullifier);
        }
        authorize(&env, &state_id, "append_many", Vec::from_array(&env, [writer.clone().into_val(&env),
            args.new_position_commitments.clone().into_val(&env)]));
        let appended = state.append_many(&writer, &args.new_position_commitments);
        let pool_id = address(&env, DataKey::Pool);
        let pool = PoolClient::new(&env, &pool_id);
        for i in 0..2 {
            let output = args.margin_output_commitments.get_unchecked(i);
            authorize(&env, &pool_id, "append_secure_note", Vec::from_array(&env,
                [writer.clone().into_val(&env), output.clone().into_val(&env)]));
            pool.append_secure_note(&writer, &output);
            let close = args.close_commitments.get_unchecked(i);
            env.storage().persistent().set(&DataKey::Close(close.clone()), &CloseReceipt {
                ledger: env.ledger().sequence(), market_id: args.market_id.clone(),
                position_commitment: args.position_commitments.get_unchecked(i),
                position_nullifier: args.position_nullifiers.get_unchecked(i),
                new_position_commitment: args.new_position_commitments.get_unchecked(i),
                margin_output_commitment: output,
                output_position_index: appended.first_index + i,
                output_position_root: appended.root.clone(),
            });
            env.events().publish((symbol_short!("pairclose"), close), args.position_nullifiers.get_unchecked(i));
        }
        env.storage().persistent().set(&DataKey::Receipt(first), &ExitReceipt {
            appended: appended.clone(), ledger: env.ledger().sequence(), market_id: args.market_id,
            position_commitments: args.position_commitments, position_nullifiers: args.position_nullifiers,
            close_commitments: args.close_commitments, new_position_commitments: args.new_position_commitments,
            margin_output_commitments: args.margin_output_commitments, proof_digest: proof.proof_digest,
        });
        let completed = Self::completed_pairs(env.clone()) + 1;
        if completed > PAIR_COUNT { panic!("legacy exit exhausted"); }
        env.storage().instance().set(&DataKey::Completed, &completed);
        appended
    }
}

fn address(env: &Env, key: DataKey) -> Address { env.storage().instance().get(&key).unwrap() }

fn authorize(env: &Env, contract: &Address, function: &str, args: Vec<Val>) {
    env.authorize_as_current_contract(Vec::from_array(env, [InvokerContractAuthEntry::Contract(
        SubContractInvocation { context: ContractContext { contract: contract.clone(),
            fn_name: Symbol::new(env, function), args }, sub_invocations: Vec::new(env) },
    )]));
}

fn validate_hash(env: &Env, value: &BytesN<32>) {
    if *value == BytesN::from_array(env, &[0; 32]) { panic!("invalid legacy hash"); }
}

fn validate_pair_values(env: &Env, values: &Vec<BytesN<32>>) {
    if values.len() != 2 { panic!("exactly two legacy values required"); }
    for value in values.iter() { validate_field(env, &value); }
    if values.get_unchecked(0) == values.get_unchecked(1) { panic!("legacy values overlap"); }
}

fn validate_field(env: &Env, value: &BytesN<32>) {
    validate_hash(env, value);
    if U256::from_be_bytes(env, &Bytes::from_array(env, &value.to_array()))
        >= U256::from_be_bytes(env, &Bytes::from_array(env, &FIELD_MODULUS)) {
        panic!("noncanonical legacy field");
    }
}

fn pair_public_input_hash(env: &Env, args: &PairCloseArgs, asset: &BytesN<32>,
    funding_abs: u128, funding_negative: bool, maintenance: u128) -> BytesN<32> {
    let mut fields = Bytes::new(env);
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &FIELD_MODULUS));
    let field = |out: &mut Bytes, value: &BytesN<32>| {
        out.append(&U256::from_be_bytes(env, &Bytes::from_array(env, &value.to_array()))
            .rem_euclid(&modulus).to_be_bytes());
    };
    field(&mut fields, &args.market_id);
    field(&mut fields, asset);
    for value in [args.mark_price as u128, funding_abs, funding_negative as u128,
        maintenance, args.liquidation as u128] { fields.append(&U256::from_u128(env, value).to_be_bytes()); }
    field(&mut fields, &args.position_root);
    for values in [&args.position_commitments, &args.position_nullifiers, &args.close_commitments,
        &args.new_position_commitments, &args.margin_output_commitments] {
        for value in values.iter() { field(&mut fields, &value); }
    }
    env.crypto().sha256(&fields).to_bytes()
}

#[cfg(test)]
mod tests;
