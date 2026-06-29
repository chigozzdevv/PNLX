#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, BytesN, Env};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Intent(BytesN<32>),
    Batch(BytesN<32>, BytesN<32>),
    Cancelled(BytesN<32>),
}

#[derive(Clone)]
#[contracttype]
pub struct IntentMeta {
    pub batch_id: BytesN<32>,
    pub market_id: BytesN<32>,
    pub share_commitment: BytesN<32>,
}

#[contract]
pub struct IntentRegistry;

#[contractimpl]
impl IntentRegistry {
    pub fn submit(
        env: Env,
        batch_id: BytesN<32>,
        market_id: BytesN<32>,
        intent_commitment: BytesN<32>,
        share_commitment: BytesN<32>,
    ) {
        let intent_key = DataKey::Intent(intent_commitment.clone());
        if env.storage().persistent().has(&intent_key) {
            panic!("duplicate intent");
        }

        let meta = IntentMeta {
            batch_id: batch_id.clone(),
            market_id: market_id.clone(),
            share_commitment,
        };
        env.storage().persistent().set(&intent_key, &meta);
        env.storage()
            .persistent()
            .set(&DataKey::Batch(batch_id, market_id), &true);
    }

    pub fn cancel(env: Env, intent_commitment: BytesN<32>) {
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

    pub fn has_intent(env: Env, intent_commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Intent(intent_commitment))
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

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{IntentRegistry, IntentRegistryClient};
    use soroban_sdk::{BytesN, Env};

    #[test]
    fn submits_intent() {
        let env = Env::default();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
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
    fn cancels_intent() {
        let env = Env::default();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
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
        let intent = BytesN::from_array(&env, &[3; 32]);

        client.cancel(&intent);
    }

    #[test]
    #[should_panic(expected = "intent already cancelled")]
    fn rejects_duplicate_cancel() {
        let env = Env::default();
        let id = env.register(IntentRegistry, ());
        let client = IntentRegistryClient::new(&env, &id);
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
        let batch = BytesN::from_array(&env, &[1; 32]);
        let market = BytesN::from_array(&env, &[2; 32]);
        let intent = BytesN::from_array(&env, &[3; 32]);
        let shares = BytesN::from_array(&env, &[4; 32]);

        client.submit(&batch, &market, &intent, &shares);
        client.submit(&batch, &market, &intent, &shares);
    }
}
