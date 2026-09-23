#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    UpgradeAuthority,
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

    pub fn set_upgrade_authority(env: Env, authority: Address) {
        let admin = Self::admin(env.clone());
        admin.require_auth();
        if authority == admin || env.storage().instance().has(&DataKey::UpgradeAuthority) {
            panic!("invalid upgrade authority");
        }
        env.storage().instance().set(&DataKey::UpgradeAuthority, &authority);
    }

    pub fn rotate_upgrade_authority(env: Env, authority: Address) {
        Self::upgrade_authority(env.clone()).require_auth();
        if authority == Self::admin(env.clone()) {
            panic!("upgrade authority must differ from admin");
        }
        env.storage().instance().set(&DataKey::UpgradeAuthority, &authority);
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        Self::upgrade_authority(env.clone()).require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn upgrade_authority(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::UpgradeAuthority)
            .unwrap_or_else(|| panic!("upgrade authority not configured"))
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
    use soroban_sdk::{
        testutils::{Address as _, MockAuth, MockAuthInvoke}, Address, BytesN, Env, IntoVal,
    };

    #[test]
    fn upgrade_key_is_distinct_and_rotates_without_admin_permission() {
        let env = Env::default();
        let id = env.register(Governance, ());
        let client = GovernanceClient::new(&env, &id);
        let admin = Address::generate(&env);
        let upgrade = Address::generate(&env);
        let replacement = Address::generate(&env);
        client.init(&admin);
        assert!(client.try_upgrade_authority().is_err());
        assert!(client.try_set_upgrade_authority(&upgrade).is_err());
        client.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "set_upgrade_authority",
                args: (&upgrade,).into_val(&env),
                sub_invokes: &[],
            },
        }]).set_upgrade_authority(&upgrade);
        assert_eq!(client.upgrade_authority(), upgrade);
        assert!(client.try_set_upgrade_authority(&replacement).is_err());
        assert!(client.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "rotate_upgrade_authority",
                args: (&replacement,).into_val(&env),
                sub_invokes: &[],
            },
        }]).try_rotate_upgrade_authority(&replacement).is_err());
        client.mock_auths(&[MockAuth {
            address: &upgrade,
            invoke: &MockAuthInvoke {
                contract: &id,
                fn_name: "rotate_upgrade_authority",
                args: (&replacement,).into_val(&env),
                sub_invokes: &[],
            },
        }]).rotate_upgrade_authority(&replacement);
        assert_eq!(client.upgrade_authority(), replacement);
    }

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
