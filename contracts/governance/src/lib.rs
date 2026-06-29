#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Paused,
    Verifier(BytesN<32>),
    VerifierAuthority(BytesN<32>),
}

#[contract]
pub struct Governance;

#[contractimpl]
impl Governance {
    pub fn init(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
    }

    pub fn set_paused(env: Env, paused: bool) {
        Self::admin(env.clone()).require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
    }

    pub fn set_verifier(
        env: Env,
        circuit_id: BytesN<32>,
        verifier_hash: BytesN<32>,
        authority: Address,
    ) {
        Self::admin(env.clone()).require_auth();
        validate_hash(&env, &circuit_id);
        validate_hash(&env, &verifier_hash);
        env.storage()
            .persistent()
            .set(&DataKey::Verifier(circuit_id.clone()), &verifier_hash);
        env.storage()
            .persistent()
            .set(&DataKey::VerifierAuthority(circuit_id), &authority);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    pub fn verifier(env: Env, circuit_id: BytesN<32>) -> BytesN<32> {
        env.storage()
            .persistent()
            .get(&DataKey::Verifier(circuit_id))
            .unwrap_or_else(|| panic!("unknown verifier"))
    }

    pub fn verifier_authority(env: Env, circuit_id: BytesN<32>) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::VerifierAuthority(circuit_id))
            .unwrap_or_else(|| panic!("unknown verifier"))
    }
}

fn validate_hash(env: &Env, value: &BytesN<32>) {
    if *value == BytesN::from_array(env, &[0; 32]) {
        panic!("invalid hash");
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{Governance, GovernanceClient};
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

    #[test]
    fn manages_pause_and_verifier() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(Governance, ());
        let client = GovernanceClient::new(&env, &id);
        let admin = Address::generate(&env);
        let circuit = BytesN::from_array(&env, &[1; 32]);
        let verifier = BytesN::from_array(&env, &[2; 32]);
        let authority = Address::generate(&env);

        client.init(&admin);
        client.set_paused(&true);
        client.set_verifier(&circuit, &verifier, &authority);

        assert!(client.paused());
        assert_eq!(client.verifier(&circuit), verifier);
        assert_eq!(client.verifier_authority(&circuit), authority);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn rejects_double_init() {
        let env = Env::default();
        let id = env.register(Governance, ());
        let client = GovernanceClient::new(&env, &id);
        let admin = Address::generate(&env);

        client.init(&admin);
        client.init(&admin);
    }

    #[test]
    #[should_panic(expected = "invalid hash")]
    fn rejects_empty_verifier() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(Governance, ());
        let client = GovernanceClient::new(&env, &id);
        let admin = Address::generate(&env);
        let circuit = BytesN::from_array(&env, &[1; 32]);
        let empty = BytesN::from_array(&env, &[0; 32]);

        client.init(&admin);
        client.set_verifier(&circuit, &empty, &Address::generate(&env));
    }

    #[test]
    #[should_panic(expected = "invalid hash")]
    fn rejects_empty_circuit() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(Governance, ());
        let client = GovernanceClient::new(&env, &id);
        let admin = Address::generate(&env);
        let empty = BytesN::from_array(&env, &[0; 32]);
        let verifier = BytesN::from_array(&env, &[2; 32]);
        let authority = Address::generate(&env);

        client.init(&admin);
        client.set_verifier(&empty, &verifier, &authority);
    }
}
