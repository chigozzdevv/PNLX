#![no_std]

use governance_interface::GovernanceClient;
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    CurrentRoot,
    Governance,
    Root(BytesN<32>),
    Spent(BytesN<32>),
    Writer(Address),
}

#[contract]
pub struct PositionState;

#[contractimpl]
impl PositionState {
    pub fn init(env: Env, governance: Address, initial_root: BytesN<32>) {
        validate_hash(&env, &initial_root);
        if env.storage().instance().has(&DataKey::Governance) {
            panic!("already initialized");
        }
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
        env.storage()
            .persistent()
            .set(&DataKey::Root(initial_root.clone()), &true);
        env.storage()
            .persistent()
            .set(&DataKey::CurrentRoot, &initial_root);
    }

    pub fn set_writer(env: Env, writer: Address, enabled: bool) {
        require_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::Writer(writer), &enabled);
    }

    pub fn current_root(env: Env) -> BytesN<32> {
        env.storage()
            .persistent()
            .get(&DataKey::CurrentRoot)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn has_root(env: Env, root: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Root(root))
    }

    pub fn is_writer(env: Env, writer: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Writer(writer))
            .unwrap_or(false)
    }

    pub fn is_spent(env: Env, position_nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Spent(position_nullifier))
    }

    pub fn advance_root(env: Env, writer: Address, old_root: BytesN<32>, new_root: BytesN<32>) {
        require_writer(&env, &writer);
        validate_hash(&env, &old_root);
        validate_hash(&env, &new_root);
        if old_root == new_root {
            panic!("root unchanged");
        }
        if Self::current_root(env.clone()) != old_root {
            panic!("stale position root");
        }
        env.storage()
            .persistent()
            .set(&DataKey::Root(new_root.clone()), &true);
        env.storage()
            .persistent()
            .set(&DataKey::CurrentRoot, &new_root);
    }

    pub fn spend_position(
        env: Env,
        writer: Address,
        position_root: BytesN<32>,
        position_commitment: BytesN<32>,
        position_nullifier: BytesN<32>,
    ) {
        require_writer(&env, &writer);
        validate_hash(&env, &position_root);
        validate_hash(&env, &position_commitment);
        validate_hash(&env, &position_nullifier);
        if Self::current_root(env.clone()) != position_root {
            panic!("stale position root");
        }
        let key = DataKey::Spent(position_nullifier);
        if env.storage().persistent().has(&key) {
            panic!("position already spent");
        }
        env.storage().persistent().set(&key, &position_commitment);
    }
}

fn require_writer(env: &Env, writer: &Address) {
    writer.require_auth();
    if !PositionState::is_writer(env.clone(), writer.clone()) {
        panic!("unauthorized writer");
    }
}

fn require_admin(env: &Env) {
    let governance_id: Address = env
        .storage()
        .instance()
        .get(&DataKey::Governance)
        .unwrap_or_else(|| panic!("not initialized"));
    GovernanceClient::new(env, &governance_id)
        .admin()
        .require_auth();
}

fn validate_hash(env: &Env, value: &BytesN<32>) {
    if *value == BytesN::from_array(env, &[0; 32]) {
        panic!("invalid root");
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{PositionState, PositionStateClient};
    use governance::{Governance, GovernanceClient};
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

    #[test]
    fn advances_roots_and_spends_positions() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);
        let initial = root(&env, 1);
        let next = root(&env, 2);
        let position = root(&env, 3);
        let nullifier = root(&env, 4);

        client.init(&setup_governance(&env, &admin), &initial);
        env.mock_all_auths();
        client.set_writer(&writer, &true);
        client.advance_root(&writer, &initial, &next);
        client.spend_position(&writer, &next, &position, &nullifier);

        assert_eq!(client.current_root(), next);
        assert!(client.has_root(&initial));
        assert!(client.has_root(&next));
        assert!(client.is_spent(&nullifier));
    }

    #[test]
    #[should_panic(expected = "unauthorized writer")]
    fn rejects_unknown_writer() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);

        client.init(&setup_governance(&env, &admin), &root(&env, 1));
        env.mock_all_auths();
        client.advance_root(&writer, &root(&env, 1), &root(&env, 2));
    }

    #[test]
    #[should_panic(expected = "stale position root")]
    fn rejects_stale_root() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);

        client.init(&setup_governance(&env, &admin), &root(&env, 1));
        env.mock_all_auths();
        client.set_writer(&writer, &true);
        client.advance_root(&writer, &root(&env, 9), &root(&env, 2));
    }

    #[test]
    #[should_panic(expected = "position already spent")]
    fn rejects_duplicate_spend() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);
        let nullifier = root(&env, 4);

        client.init(&setup_governance(&env, &admin), &root(&env, 1));
        env.mock_all_auths();
        client.set_writer(&writer, &true);
        client.spend_position(&writer, &root(&env, 1), &root(&env, 3), &nullifier);
        client.spend_position(&writer, &root(&env, 1), &root(&env, 3), &nullifier);
    }

    fn setup_governance(env: &Env, admin: &Address) -> Address {
        env.mock_all_auths();
        let id = env.register(Governance, ());
        GovernanceClient::new(env, &id).init(admin);
        id
    }

    fn root(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }
}
