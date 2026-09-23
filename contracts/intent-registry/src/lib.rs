#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

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
    ) {
        require_operator(&env);
        let intent_key = DataKey::Intent(intent_commitment.clone());
        if env.storage().persistent().has(&intent_key) {
            panic!("duplicate intent");
        }

        let meta = IntentMeta {
            batch_id: batch_id.clone(),
            market_id: market_id.clone(),
            matching_payload_commitment,
        };
        env.storage().persistent().set(&intent_key, &meta);
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
        env.storage()
            .persistent()
            .set(&DataKey::Cancelled(source), &true);
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

    use super::{IntentRegistry, IntentRegistryClient};
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

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

        client.submit(&batch, &market, &intent, &shares);
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
        client.submit(&batch, &market, &source, &payload);
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

        client.submit(&batch, &market, &intent, &shares);
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

        client.submit(&batch, &market, &intent, &shares);
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

        client.submit(&batch, &market, &intent, &shares);
        client.submit(&batch, &market, &intent, &shares);
    }
}
