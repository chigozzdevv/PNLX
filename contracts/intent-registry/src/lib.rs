#![no_std]

use governance_interface::GovernanceClient;
use proof_ledger_interface::ProofLedgerClient;
use soroban_poseidon::Poseidon2Sponge;
use soroban_sdk::{contract, contractclient, contractimpl, contracttype, crypto::bn254::Bn254Fr, Address, Bytes, BytesN, Env, U256};

const BN254_SCALAR_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];
const RESIDUAL_NULLIFIER_DOMAIN: u128 = 0x504e4c585245534e554c;

#[derive(Clone)]
#[contracttype]
pub struct ProofMeta {
    pub circuit_id: BytesN<32>,
    pub circuit_hash: BytesN<32>,
    pub verifier_hash: BytesN<32>,
    pub public_input_hash: BytesN<32>,
    pub proof_digest: BytesN<32>,
}

#[contractclient(name = "SecurePoolClient")]
pub trait SecurePoolInterface {
    fn has_secure_note_root(env: &Env, root: &BytesN<32>) -> bool;
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Intent(BytesN<32>),
    Batch(BytesN<32>, BytesN<32>),
    Cancelled(BytesN<32>),
    NextSubmissionSequence,
    SubmissionSequence(BytesN<32>),
    Settler,
    Operator,
    UpgradeAuthority,
    SecurePool,
    NullifierRoot(BytesN<32>),
    NullifierIntent(BytesN<32>),
    IntentNullifier(BytesN<32>),
    Governance,
    ProofLedger,
    ValidityCircuit,
    CollateralDigest,
}

#[derive(Clone)]
#[contracttype]
pub struct IntentMeta {
    pub batch_id: BytesN<32>,
    pub market_id: BytesN<32>,
    pub matching_payload_commitment: BytesN<32>,
}

#[contract]
pub struct IntentRegistry;

#[contractimpl]
impl IntentRegistry {
    pub fn collateral_digest(env:Env)->BytesN<32> {
        env.storage().persistent().get(&DataKey::CollateralDigest)
            .unwrap_or_else(||panic!("validity verifier not configured"))
    }
    pub fn configure_validity(env: Env, governance: Address, proof_ledger: Address,
        circuit_id: BytesN<32>, collateral_digest: BytesN<32>) {
        require_operator(&env);
        if env.storage().persistent().has(&DataKey::ValidityCircuit)
            || GovernanceClient::new(&env, &governance).admin() != Self::operator(env.clone())
            || circuit_id == BytesN::from_array(&env, &[0; 32])
            || collateral_digest == BytesN::from_array(&env, &[0; 32]) {
            panic!("invalid validity configuration");
        }
        env.storage().persistent().set(&DataKey::Governance, &governance);
        env.storage().persistent().set(&DataKey::ProofLedger, &proof_ledger);
        env.storage().persistent().set(&DataKey::ValidityCircuit, &circuit_id);
        env.storage().persistent().set(&DataKey::CollateralDigest, &collateral_digest);
    }

    pub fn init(env: Env, admin: Address, settler: Address) {
        admin.require_auth();
        if env.storage().persistent().has(&DataKey::Settler) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&DataKey::Settler, &settler);
        env.storage().persistent().set(&DataKey::Operator, &admin);
    }

    pub fn submit(
        env: Env,
        batch_id: BytesN<32>,
        market_id: BytesN<32>,
        intent_commitment: BytesN<32>,
        matching_payload_commitment: BytesN<32>,
        margin_root: BytesN<32>,
        note_nullifier: BytesN<32>,
        current_batch: u128,
        note_change_commitment: BytesN<32>,
        proof: ProofMeta,
    ) {
        require_operator(&env);
        validate_validity_proof(&env, &batch_id, &market_id, &intent_commitment,
            &matching_payload_commitment, &margin_root, &note_nullifier,
            current_batch, &note_change_commitment, &proof);
        let intent_key = DataKey::Intent(intent_commitment.clone());
        if env.storage().persistent().has(&intent_key) {
            panic!("duplicate intent");
        }
        let pool_id: Address = env.storage().persistent().get(&DataKey::SecurePool)
            .unwrap_or_else(|| panic!("secure pool not configured"));
        if !SecurePoolClient::new(&env, &pool_id).has_secure_note_root(&margin_root) ||
            note_nullifier == BytesN::from_array(&env, &[0; 32]) {
            panic!("invalid secure note root or nullifier");
        }
        let nullifier_intent = DataKey::NullifierIntent(note_nullifier.clone());
        if let Some(previous) = env.storage().persistent().get::<_, BytesN<32>>(&nullifier_intent) {
            if Self::is_active_intent(env.clone(), previous) {
                panic!("note already committed to an active intent");
            }
        }
        let meta = IntentMeta {
            batch_id: batch_id.clone(),
            market_id: market_id.clone(),
            matching_payload_commitment,
        };
        env.storage().persistent().set(&intent_key, &meta);
        env.storage().persistent().set(&DataKey::NullifierRoot(note_nullifier.clone()), &margin_root);
        env.storage().persistent().set(&nullifier_intent, &intent_commitment);
        env.storage().persistent().set(&DataKey::IntentNullifier(intent_commitment.clone()), &note_nullifier);
        let sequence: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::NextSubmissionSequence)
            .unwrap_or(0);
        let next = sequence
            .checked_add(1)
            .expect("submission sequence overflow");
        env.storage()
            .persistent()
            .set(&DataKey::NextSubmissionSequence, &next);
        env.storage()
            .persistent()
            .set(&DataKey::SubmissionSequence(intent_commitment), &next);
        env.storage()
            .persistent()
            .set(&DataKey::Batch(batch_id, market_id), &true);
    }

    pub fn cancel(env: Env, intent_commitment: BytesN<32>) {
        require_operator(&env);
        mark_cancelled(&env, intent_commitment);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::upgrade_authority(env.clone()).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn set_upgrade_authority(env: Env, authority: Address) {
        require_operator(&env);
        if env.storage().persistent().has(&DataKey::UpgradeAuthority)
            || authority == Self::operator(env.clone())
        {
            panic!("invalid upgrade authority");
        }
        env.storage().persistent().set(&DataKey::UpgradeAuthority, &authority);
    }

    pub fn rotate_upgrade_authority(env: Env, authority: Address) {
        Self::upgrade_authority(env.clone()).require_auth();
        if authority == Self::operator(env.clone()) {
            panic!("upgrade authority must differ from operator");
        }
        env.storage().persistent().set(&DataKey::UpgradeAuthority, &authority);
    }

    pub fn upgrade_authority(env: Env) -> Address {
        env.storage().persistent().get(&DataKey::UpgradeAuthority)
            .unwrap_or_else(|| panic!("upgrade authority not configured"))
    }

    pub fn operator(env: Env) -> Address {
        env.storage().persistent().get(&DataKey::Operator)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn configure_secure_pool(env: Env, pool: Address) {
        require_operator(&env);
        if env.storage().persistent().has(&DataKey::SecurePool) {
            panic!("secure pool already configured");
        }
        env.storage().persistent().set(&DataKey::SecurePool, &pool);
    }

    pub fn nullifier_root(env: Env, nullifier: BytesN<32>) -> BytesN<32> {
        env.storage().persistent().get(&DataKey::NullifierRoot(nullifier))
            .unwrap_or_else(|| panic!("unregistered note nullifier"))
    }

    pub fn intent_nullifier(env: Env, intent: BytesN<32>) -> BytesN<32> {
        env.storage().persistent().get(&DataKey::IntentNullifier(intent))
            .unwrap_or_else(|| panic!("intent note nullifier unavailable"))
    }

    pub fn consume(env: Env, settler: Address, intent_commitment: BytesN<32>) {
        require_settler(&env, &settler);
        mark_cancelled(&env, intent_commitment);
    }

    pub fn rollover(
        env: Env,
        settler: Address,
        source: BytesN<32>,
        residual: BytesN<32>,
        matching_payload_commitment: BytesN<32>,
    ) {
        require_settler(&env, &settler);
        if source == residual || !Self::is_active_intent(env.clone(), source.clone()) {
            panic!("inactive source intent");
        }
        let residual_key = DataKey::Intent(residual.clone());
        if env.storage().persistent().has(&residual_key) {
            panic!("duplicate residual intent");
        }
        let source_meta: IntentMeta = env
            .storage()
            .persistent()
            .get(&DataKey::Intent(source.clone()))
            .unwrap();
        let sequence = Self::submission_sequence(env.clone(), source.clone());
        let source_nullifier: Option<BytesN<32>> = env.storage().persistent()
            .get(&DataKey::IntentNullifier(source.clone()));
        env.storage()
            .persistent()
            .set(&DataKey::Cancelled(source), &true);
        if let Some(nullifier) = source_nullifier {
            let root: BytesN<32> = env.storage().persistent().get(&DataKey::NullifierRoot(nullifier))
                .unwrap_or_else(|| panic!("source collateral lineage unavailable"));
            let residual_nullifier = residual_nullifier(&env, &residual);
            if env.storage().persistent().has(&DataKey::NullifierIntent(residual_nullifier.clone())) {
                panic!("residual collateral already registered");
            }
            env.storage().persistent().set(&DataKey::IntentNullifier(residual.clone()), &residual_nullifier);
            env.storage().persistent().set(&DataKey::NullifierIntent(residual_nullifier.clone()), &residual);
            env.storage().persistent().set(&DataKey::NullifierRoot(residual_nullifier), &root);
        }
        env.storage().persistent().set(
            &residual_key,
            &IntentMeta {
                batch_id: source_meta.batch_id,
                market_id: source_meta.market_id,
                matching_payload_commitment,
            },
        );
        env.storage()
            .persistent()
            .set(&DataKey::SubmissionSequence(residual), &sequence);
    }

    pub fn matching_payload_commitment(env: Env, intent_commitment: BytesN<32>) -> BytesN<32> {
        env.storage()
            .persistent()
            .get::<_, IntentMeta>(&DataKey::Intent(intent_commitment))
            .unwrap_or_else(|| panic!("unknown intent"))
            .matching_payload_commitment
    }

    pub fn has_intent(env: Env, intent_commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Intent(intent_commitment))
    }

    pub fn submission_sequence(env: Env, intent_commitment: BytesN<32>) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::SubmissionSequence(intent_commitment))
            .unwrap_or_else(|| panic!("intent submission sequence unavailable"))
    }

    pub fn is_cancelled(env: Env, intent_commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Cancelled(intent_commitment))
    }

    pub fn is_active_intent(env: Env, intent_commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Intent(intent_commitment.clone()))
            && !env
                .storage()
                .persistent()
                .has(&DataKey::Cancelled(intent_commitment))
    }

    pub fn has_batch(env: Env, batch_id: BytesN<32>, market_id: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Batch(batch_id, market_id))
    }
}

fn validity_public_input_hash(env: &Env, collateral: &BytesN<32>, current_batch: u128,
    batch: &BytesN<32>, market: &BytesN<32>, intent: &BytesN<32>, root: &BytesN<32>,
    nullifier: &BytesN<32>, change: &BytesN<32>, payload: &BytesN<32>) -> BytesN<32> {
    let mut encoded = Bytes::new(env);
    encoded.append(&field_bytes(env, collateral));
    encoded.append(&U256::from_u128(env, current_batch).to_be_bytes());
    for value in [batch, market, intent, root, nullifier, change, payload] {
        encoded.append(&field_bytes(env, value));
    }
    env.crypto().sha256(&encoded).to_bytes()
}

fn validate_validity_proof(env: &Env, batch: &BytesN<32>, market: &BytesN<32>,
    intent: &BytesN<32>, payload: &BytesN<32>, root: &BytesN<32>, nullifier: &BytesN<32>,
    current_batch: u128, change: &BytesN<32>, proof: &ProofMeta) {
    let store = env.storage().persistent();
    let circuit: BytesN<32> = store.get(&DataKey::ValidityCircuit)
        .unwrap_or_else(|| panic!("validity verifier not configured"));
    let governance: Address = store.get(&DataKey::Governance).unwrap();
    let governor = GovernanceClient::new(env, &governance);
    if governor.paused() || proof.circuit_id != circuit
        || proof.verifier_hash != governor.verifier(&circuit) {
        panic!("invalid validity verifier");
    }
    let collateral: BytesN<32> = store.get(&DataKey::CollateralDigest).unwrap();
    let expected = validity_public_input_hash(env, &collateral, current_batch,
        batch, market, intent, root, nullifier, change, payload);
    if proof.public_input_hash != expected { panic!("validity public input mismatch"); }
    let ledger: Address = store.get(&DataKey::ProofLedger).unwrap();
    if !ProofLedgerClient::new(env, &ledger).has_proof(&circuit, &proof.verifier_hash,
        &proof.public_input_hash, &proof.proof_digest) { panic!("unverified intent validity"); }
}

fn field_bytes(env: &Env, value: &BytesN<32>) -> Bytes {
    let modulus = U256::from_be_bytes(env, &Bytes::from_array(env, &BN254_SCALAR_MODULUS_BE));
    U256::from_be_bytes(env, &Bytes::from_array(env, &value.to_array()))
        .rem_euclid(&modulus).to_be_bytes()
}

fn residual_nullifier(env: &Env, residual: &BytesN<32>) -> BytesN<32> {
    let mut hasher = Poseidon2Sponge::<4, Bn254Fr>::new(env);
    let inputs = soroban_sdk::vec![env, U256::from_u128(env, RESIDUAL_NULLIFIER_DOMAIN),
        U256::from_be_bytes(env, &field_bytes(env, residual))];
    Bn254Fr::from_u256(hasher.compute_hash(&inputs)).to_bytes()
}

fn require_operator(env: &Env) {
    let operator: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Operator)
        .unwrap_or_else(|| panic!("not initialized"));
    operator.require_auth();
}

fn require_settler(env: &Env, settler: &Address) {
    settler.require_auth();
    let configured: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Settler)
        .unwrap_or_else(|| panic!("not initialized"));
    if *settler != configured {
        panic!("unauthorized settler");
    }
}

fn mark_cancelled(env: &Env, intent_commitment: BytesN<32>) {
    let intent_key = DataKey::Intent(intent_commitment.clone());
    if !env.storage().persistent().has(&intent_key) {
        panic!("unknown intent");
    }

    let cancelled_key = DataKey::Cancelled(intent_commitment);
    if env.storage().persistent().has(&cancelled_key) {
        panic!("intent already cancelled");
    }

    env.storage().persistent().set(&cancelled_key, &true);
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{DataKey, IntentRegistry, IntentRegistryClient, ProofMeta};
    use governance::{Governance, GovernanceClient};
    use proof_ledger::{ProofLedger, ProofLedgerClient};
    use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, BytesN, Env};

    #[contract]
    struct RootPool;

    #[contractimpl]
    impl RootPool {
        pub fn has_secure_note_root(_env: Env, _root: BytesN<32>) -> bool { true }
    }

    fn configure_pool(env: &Env, client: &IntentRegistryClient<'_>) {
        client.configure_secure_pool(&env.register(RootPool, ()));
        let governance_id = env.register(Governance, ());
        let governance = GovernanceClient::new(env, &governance_id);
        governance.init(&client.operator());
        governance.set_verifier(&validity_circuit(env), &BytesN::from_array(env, &[11;32]), &client.operator());
        let ledger_id = env.register(ProofLedger, ());
        ProofLedgerClient::new(env, &ledger_id).init(&governance_id);
        client.configure_validity(&governance_id, &ledger_id, &validity_circuit(env), &collateral(env));
    }

    fn validity_circuit(env: &Env) -> BytesN<32> { BytesN::from_array(env, &[10;32]) }
    fn collateral(env: &Env) -> BytesN<32> { BytesN::from_array(env, &[12;32]) }

    fn valid_proof(env: &Env, batch: &BytesN<32>, market: &BytesN<32>,
        intent: &BytesN<32>, payload: &BytesN<32>) -> ProofMeta {
        ProofMeta { circuit_id: validity_circuit(env), circuit_hash: BytesN::from_array(env, &[13;32]),
            verifier_hash: BytesN::from_array(env, &[11;32]), proof_digest: BytesN::from_array(env, &[14;32]),
            public_input_hash: super::validity_public_input_hash(env, &collateral(env), 1,
                batch, market, intent, &BytesN::from_array(env, &[8;32]),
                &BytesN::from_array(env, &[9;32]), &BytesN::from_array(env, &[0;32]), payload) }
    }

    fn record_proof(env: &Env, client: &IntentRegistryClient<'_>, proof: &ProofMeta) {
        let ledger: Address = env.as_contract(&client.address, ||
            env.storage().persistent().get(&DataKey::ProofLedger).unwrap());
        ProofLedgerClient::new(env, &ledger).record(&client.operator(), &proof.circuit_id,
            &proof.verifier_hash, &proof.public_input_hash, &proof.proof_digest);
    }

    fn submit(
        env: &Env, client: &IntentRegistryClient<'_>, batch: &BytesN<32>,
        market: &BytesN<32>, intent: &BytesN<32>, payload: &BytesN<32>,
    ) {
        let proof = valid_proof(env, batch, market, intent, payload);
        record_proof(env, client, &proof);
        client.submit(batch, market, intent, payload,
            &BytesN::from_array(env, &[8; 32]), &BytesN::from_array(env, &[9; 32]),
            &1, &BytesN::from_array(env, &[0;32]), &proof);
    }

    #[test]
    fn verified_validity_is_required_and_bound_to_all_matching_economics() {
        let env = Env::default(); env.mock_all_auths();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
        client.init(&Address::generate(&env), &Address::generate(&env));
        configure_pool(&env, &client);
        let batch = BytesN::from_array(&env, &[1;32]);
        let market = BytesN::from_array(&env, &[2;32]);
        let intent = BytesN::from_array(&env, &[3;32]);
        let payload = BytesN::from_array(&env, &[4;32]);
        let proof = valid_proof(&env, &batch, &market, &intent, &payload);
        let root = BytesN::from_array(&env, &[8;32]);
        let nullifier = BytesN::from_array(&env, &[9;32]);
        let change = BytesN::from_array(&env, &[0;32]);
        assert!(client.try_submit(&batch, &market, &intent, &payload, &root, &nullifier, &1, &change, &proof).is_err());
        record_proof(&env, &client, &proof);
        assert!(client.try_submit(&BytesN::from_array(&env, &[5;32]), &market, &intent, &payload, &root, &nullifier, &1, &change, &proof).is_err());
        assert!(client.try_submit(&batch, &BytesN::from_array(&env, &[5;32]), &intent, &payload, &root, &nullifier, &1, &change, &proof).is_err());
        assert!(client.try_submit(&batch, &market, &intent, &BytesN::from_array(&env, &[5;32]), &root, &nullifier, &1, &change, &proof).is_err());
        assert!(client.try_submit(&batch, &market, &intent, &payload, &root, &nullifier, &2, &change, &proof).is_err());
        assert!(client.try_submit(&batch, &market, &intent, &payload, &root, &nullifier, &1, &BytesN::from_array(&env, &[5;32]), &proof).is_err());
        client.submit(&batch, &market, &intent, &payload, &root, &nullifier, &1, &change, &proof);
        assert!(client.is_active_intent(&intent));
    }

    #[test]
    fn operator_cannot_be_the_upgrade_authority() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
        let operator = Address::generate(&env);
        let settler = Address::generate(&env);
        let upgrade = Address::generate(&env);
        client.init(&operator, &settler);
        assert!(client.try_set_upgrade_authority(&operator).is_err());
        client.set_upgrade_authority(&upgrade);
        assert_eq!(client.upgrade_authority(), upgrade);
        assert!(client.try_set_upgrade_authority(&Address::generate(&env)).is_err());
    }

    #[test]
    fn submits_intent() {
        let env = Env::default();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
        env.mock_all_auths();
        client.init(&Address::generate(&env), &Address::generate(&env));
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let intent = BytesN::from_array(&env, &[3; 32]);
        let shares = BytesN::from_array(&env, &[4; 32]);

        configure_pool(&env, &client);
        submit(&env, &client, &batch, &market, &intent, &shares);
        assert!(client.has_intent(&intent));
        assert!(client.is_active_intent(&intent));
        assert!(!client.is_cancelled(&intent));
        assert!(client.has_batch(&batch, &market));
    }

    #[test]
    fn rollover_preserves_priority_and_rejects_unapproved_settler() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
        let settler = Address::generate(&env);
        client.init(&Address::generate(&env), &settler);
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let source = BytesN::from_array(&env, &[3; 32]);
        let residual = BytesN::from_array(&env, &[4; 32]);
        let payload = BytesN::from_array(&env, &[5; 32]);
        configure_pool(&env, &client);
        submit(&env, &client, &batch, &market, &source, &payload);
        let sequence = client.submission_sequence(&source);
        assert!(client
            .try_rollover(&Address::generate(&env), &source, &residual, &payload)
            .is_err());
        assert!(client.is_active_intent(&source));
        client.rollover(&settler, &source, &residual, &payload);
        assert!(client.is_cancelled(&source));
        assert!(client.is_active_intent(&residual));
        assert_eq!(client.submission_sequence(&residual), sequence);
        assert_eq!(client.matching_payload_commitment(&residual), payload);
        let residual_nullifier = client.intent_nullifier(&residual);
        assert_eq!(residual_nullifier, super::residual_nullifier(&env, &residual));
        assert_ne!(residual_nullifier, client.intent_nullifier(&source));
        assert!(client
            .try_rollover(
                &settler,
                &source,
                &BytesN::from_array(&env, &[6; 32]),
                &payload
            )
            .is_err());
    }

    #[test]
    fn cancels_intent() {
        let env = Env::default();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
        env.mock_all_auths();
        client.init(&Address::generate(&env), &Address::generate(&env));
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let intent = BytesN::from_array(&env, &[3; 32]);
        let shares = BytesN::from_array(&env, &[4; 32]);

        configure_pool(&env, &client);
        submit(&env, &client, &batch, &market, &intent, &shares);
        client.cancel(&intent);

        assert!(client.has_intent(&intent));
        assert!(client.is_cancelled(&intent));
        assert!(!client.is_active_intent(&intent));
    }

    #[test]
    #[should_panic(expected = "unknown intent")]
    fn rejects_unknown_cancel() {
        let env = Env::default();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
        env.mock_all_auths();
        client.init(&Address::generate(&env), &Address::generate(&env));
        let intent = BytesN::from_array(&env, &[3; 32]);

        client.cancel(&intent);
    }

    #[test]
    #[should_panic(expected = "intent already cancelled")]
    fn rejects_duplicate_cancel() {
        let env = Env::default();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
        env.mock_all_auths();
        client.init(&Address::generate(&env), &Address::generate(&env));
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let intent = BytesN::from_array(&env, &[3; 32]);
        let shares = BytesN::from_array(&env, &[4; 32]);

        configure_pool(&env, &client);
        submit(&env, &client, &batch, &market, &intent, &shares);
        client.cancel(&intent);
        client.cancel(&intent);
    }

    #[test]
    #[should_panic(expected = "duplicate intent")]
    fn rejects_duplicate_intent() {
        let env = Env::default();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
        env.mock_all_auths();
        client.init(&Address::generate(&env), &Address::generate(&env));
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let intent = BytesN::from_array(&env, &[3; 32]);
        let shares = BytesN::from_array(&env, &[4; 32]);

        configure_pool(&env, &client);
        submit(&env, &client, &batch, &market, &intent, &shares);
        submit(&env, &client, &batch, &market, &intent, &shares);
    }
}
