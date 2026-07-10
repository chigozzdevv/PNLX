#![no_std]

use core::ops::{Add, Mul};
use governance_interface::GovernanceClient;
use soroban_sdk::{
    contract, contractimpl, contracttype, crypto::bn254::Bn254Fr, Address, BytesN, Env, Vec, U256,
};

const TREE_DEPTH: u32 = 20;
const MAX_APPEND_ITEMS: u32 = 8;
const LEFT_FACTOR: u32 = 131;
const RIGHT_FACTOR: u32 = 137;
const DOMAIN_FACTOR: u32 = 17;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    CurrentRoot,
    Frontier(u32),
    Governance,
    LeafCount,
    Root(BytesN<32>),
    Spent(BytesN<32>),
    Writer(Address),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AppendReceipt {
    pub count: u32,
    pub first_index: u32,
    pub root: BytesN<32>,
}

#[contract]
pub struct PositionState;

#[contractimpl]
impl PositionState {
    pub fn init(env: Env, governance: Address) {
        if env.storage().instance().has(&DataKey::Governance) {
            panic!("already initialized");
        }
        let initial_root = empty_root(&env);
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
        env.storage().persistent().set(&DataKey::LeafCount, &0u32);
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

    pub fn leaf_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LeafCount)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn tree_depth(_env: Env) -> u32 {
        TREE_DEPTH
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

    pub fn append(env: Env, writer: Address, commitment: BytesN<32>) -> AppendReceipt {
        Self::append_many(env.clone(), writer, Vec::from_array(&env, [commitment]))
    }

    pub fn append_many(env: Env, writer: Address, commitments: Vec<BytesN<32>>) -> AppendReceipt {
        require_writer(&env, &writer);
        if commitments.is_empty() || commitments.len() > MAX_APPEND_ITEMS {
            panic!("invalid append count");
        }
        let first_index = Self::leaf_count(env.clone());
        if first_index > (1u32 << TREE_DEPTH) - commitments.len() {
            panic!("position tree is full");
        }

        let mut root = Self::current_root(env.clone());
        for commitment in commitments.iter() {
            validate_commitment(&env, &commitment);
            root = append_one(&env, commitment);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Root(root.clone()), &true);
        env.storage().persistent().set(&DataKey::CurrentRoot, &root);

        AppendReceipt {
            count: commitments.len(),
            first_index,
            root,
        }
    }

    pub fn spend_position(
        env: Env,
        writer: Address,
        membership_root: BytesN<32>,
        position_commitment: BytesN<32>,
        position_nullifier: BytesN<32>,
    ) {
        require_writer(&env, &writer);
        validate_commitment(&env, &position_commitment);
        validate_commitment(&env, &position_nullifier);
        if !Self::has_root(env.clone(), membership_root) {
            panic!("unknown position root");
        }
        let key = DataKey::Spent(position_nullifier);
        if env.storage().persistent().has(&key) {
            panic!("position already spent");
        }
        env.storage().persistent().set(&key, &position_commitment);
    }
}

fn append_one(env: &Env, commitment: BytesN<32>) -> BytesN<32> {
    let index: u32 = env
        .storage()
        .persistent()
        .get(&DataKey::LeafCount)
        .unwrap_or_else(|| panic!("not initialized"));
    let mut cursor = index;
    let mut node = commitment;
    let mut empty = zero(env);

    for level in 0..TREE_DEPTH {
        if cursor & 1 == 0 {
            env.storage()
                .persistent()
                .set(&DataKey::Frontier(level), &node);
            node = field_hash_pair(env, &node, &empty);
        } else {
            let left: BytesN<32> = env
                .storage()
                .persistent()
                .get(&DataKey::Frontier(level))
                .unwrap_or_else(|| panic!("missing position frontier"));
            node = field_hash_pair(env, &left, &node);
        }
        empty = field_hash_pair(env, &empty, &empty);
        cursor >>= 1;
    }

    env.storage()
        .persistent()
        .set(&DataKey::LeafCount, &(index + 1));
    node
}

fn empty_root(env: &Env) -> BytesN<32> {
    let mut root = zero(env);
    for _ in 0..TREE_DEPTH {
        root = field_hash_pair(env, &root, &root);
    }
    root
}

fn field_hash_pair(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let left = Bn254Fr::from_bytes(left.clone());
    let right = Bn254Fr::from_bytes(right.clone());
    let left_factor = Bn254Fr::from_u256(U256::from_u32(env, LEFT_FACTOR));
    let right_factor = Bn254Fr::from_u256(U256::from_u32(env, RIGHT_FACTOR));
    let domain = Bn254Fr::from_u256(U256::from_u32(env, DOMAIN_FACTOR));
    (left
        .mul(left_factor)
        .add(right.mul(right_factor))
        .add(domain))
    .to_bytes()
}

fn zero(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0; 32])
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

fn validate_commitment(env: &Env, value: &BytesN<32>) {
    if *value == zero(env) {
        panic!("invalid commitment");
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{PositionState, PositionStateClient};
    use governance::{Governance, GovernanceClient};
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Vec};

    #[test]
    fn appends_outputs_and_spends_against_historical_roots() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);

        client.init(&setup_governance(&env, &admin));
        env.mock_all_auths();
        client.set_writer(&writer, &true);
        let initial = client.current_root();
        let first = client.append(&writer, &value(&env, 1));
        let second = client.append_many(
            &writer,
            &Vec::from_array(&env, [value(&env, 2), value(&env, 3)]),
        );

        assert_eq!(first.first_index, 0);
        assert_eq!(second.first_index, 1);
        assert_eq!(second.count, 2);
        assert_eq!(client.leaf_count(), 3);
        assert_eq!(client.current_root(), second.root);
        assert!(client.has_root(&initial));
        assert!(client.has_root(&first.root));
        assert!(client.has_root(&second.root));

        let nullifier = value(&env, 9);
        client.spend_position(&writer, &first.root, &value(&env, 1), &nullifier);
        assert!(client.is_spent(&nullifier));
    }

    #[test]
    fn matches_the_shared_depth_twenty_accumulator_vector() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);

        client.init(&setup_governance(&env, &admin));
        env.mock_all_auths();
        client.set_writer(&writer, &true);
        let receipt = client.append(&writer, &BytesN::from_array(&env, &[9; 32]));

        assert_eq!(
            receipt.root,
            BytesN::from_array(
                &env,
                &[
                    0x10, 0xf0, 0xc7, 0x8e, 0x16, 0x5c, 0x67, 0x5e, 0x0f, 0x25, 0x2b, 0xbd, 0x84,
                    0x15, 0xe9, 0x8c, 0x6c, 0xd8, 0xaf, 0xe0, 0xf0, 0xaa, 0x48, 0x5e, 0x53, 0x64,
                    0x86, 0x53, 0x76, 0x6c, 0xd2, 0x0b,
                ],
            ),
        );
    }

    #[test]
    #[should_panic(expected = "unknown position root")]
    fn rejects_unknown_membership_root() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);

        client.init(&setup_governance(&env, &admin));
        env.mock_all_auths();
        client.set_writer(&writer, &true);
        client.spend_position(&writer, &value(&env, 7), &value(&env, 1), &value(&env, 2));
    }

    #[test]
    #[should_panic(expected = "position already spent")]
    fn rejects_duplicate_spend_across_root_versions() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);
        let nullifier = value(&env, 9);

        client.init(&setup_governance(&env, &admin));
        env.mock_all_auths();
        client.set_writer(&writer, &true);
        let first = client.append(&writer, &value(&env, 1));
        let second = client.append(&writer, &value(&env, 2));
        client.spend_position(&writer, &first.root, &value(&env, 1), &nullifier);
        client.spend_position(&writer, &second.root, &value(&env, 1), &nullifier);
    }

    fn setup_governance(env: &Env, admin: &Address) -> Address {
        env.mock_all_auths();
        let id = env.register(Governance, ());
        GovernanceClient::new(env, &id).init(admin);
        id
    }

    fn value(env: &Env, byte: u8) -> BytesN<32> {
        BytesN::from_array(env, &[byte; 32])
    }
}
