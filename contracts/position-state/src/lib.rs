#![no_std]

use governance_interface::GovernanceClient;
use soroban_poseidon::Poseidon2Sponge;
use soroban_sdk::{
    contract, contractimpl, contracttype, crypto::bn254::Bn254Fr, Address, BytesN, Env, Vec, U256,
};

const TREE_DEPTH: u32 = 20;
const MAX_APPEND_ITEMS: u32 = 8;
const POSEIDON2_TREE_VERSION: u32 = 2;
type FieldHasher = Poseidon2Sponge<4, Bn254Fr>;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    CurrentRoot,
    Empty(u32),
    Frontier(u32),
    Governance,
    LeafCount,
    Root(BytesN<32>),
    Poseidon2Root(BytesN<32>),
    Spent(BytesN<32>),
    TreeHashVersion,
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
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let governance_id: Address = env.storage().instance().get(&DataKey::Governance)
            .unwrap_or_else(|| panic!("not initialized"));
        GovernanceClient::new(&env, &governance_id).upgrade_authority().require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn init(env: Env, governance: Address) {
        if env.storage().instance().has(&DataKey::Governance) {
            panic!("already initialized");
        }
        let initial_root = store_empty_nodes(&env);
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
        env.storage().persistent().set(&DataKey::LeafCount, &0u32);
        env.storage().persistent().set(&DataKey::TreeHashVersion, &POSEIDON2_TREE_VERSION);
        env.storage()
            .persistent()
            .set(&DataKey::Poseidon2Root(initial_root.clone()), &true);
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

    pub fn reset_for_poseidon2(env: Env) {
        require_admin(&env);
        if env.storage().persistent().has(&DataKey::TreeHashVersion) {
            panic!("tree already uses Poseidon2");
        }
        if !env.storage().instance().has(&DataKey::Governance) {
            panic!("not initialized");
        }
        let initial_root = store_empty_nodes(&env);
        env.storage().persistent().set(&DataKey::LeafCount, &0u32);
        env.storage().persistent().set(&DataKey::CurrentRoot, &initial_root);
        env.storage().persistent().set(&DataKey::Poseidon2Root(initial_root), &true);
        env.storage().persistent().set(&DataKey::TreeHashVersion, &POSEIDON2_TREE_VERSION);
    }

    pub fn current_root(env: Env) -> BytesN<32> {
        require_poseidon2_tree(&env);
        env.storage()
            .persistent()
            .get(&DataKey::CurrentRoot)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn leaf_count(env: Env) -> u32 {
        require_poseidon2_tree(&env);
        env.storage()
            .persistent()
            .get(&DataKey::LeafCount)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn tree_depth(_env: Env) -> u32 {
        TREE_DEPTH
    }

    pub fn has_root(env: Env, root: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Poseidon2Root(root))
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

        let mut hasher = FieldHasher::new(&env);
        let mut index = first_index;
        let mut full_root = None;
        for commitment in commitments.iter() {
            validate_commitment(&env, &commitment);
            full_root = append_frontier(&env, &mut hasher, index, commitment);
            index += 1;
        }
        let root = full_root.unwrap_or_else(|| root_from_frontier(&env, &mut hasher, index));
        env.storage().persistent().set(&DataKey::LeafCount, &index);
        env.storage()
            .persistent()
            .set(&DataKey::Poseidon2Root(root.clone()), &true);
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

fn append_frontier(
    env: &Env,
    hasher: &mut FieldHasher,
    index: u32,
    commitment: BytesN<32>,
) -> Option<BytesN<32>> {
    let mut cursor = index;
    let mut node = commitment;

    for level in 0..TREE_DEPTH {
        if cursor & 1 == 0 {
            env.storage()
                .persistent()
                .set(&DataKey::Frontier(level), &node);
            return None;
        } else {
            let left: BytesN<32> = env
                .storage()
                .persistent()
                .get(&DataKey::Frontier(level))
                .unwrap_or_else(|| panic!("missing position frontier"));
            node = field_hash_pair(env, hasher, &left, &node);
        }
        cursor >>= 1;
    }
    Some(node)
}

fn root_from_frontier(env: &Env, hasher: &mut FieldHasher, count: u32) -> BytesN<32> {
    let mut cursor = count;
    let mut node = zero(env);
    for level in 0..TREE_DEPTH {
        let empty: BytesN<32> = env.storage().persistent().get(&DataKey::Empty(level))
            .unwrap_or_else(|| panic!("missing empty position node"));
        node = if cursor & 1 == 0 {
            field_hash_pair(env, hasher, &node, &empty)
        } else {
            let left: BytesN<32> = env.storage().persistent().get(&DataKey::Frontier(level))
                .unwrap_or_else(|| panic!("missing position frontier"));
            field_hash_pair(env, hasher, &left, &node)
        };
        cursor >>= 1;
    }
    node
}

fn store_empty_nodes(env: &Env) -> BytesN<32> {
    let mut root = zero(env);
    let mut hasher = FieldHasher::new(env);
    for level in 0..TREE_DEPTH {
        env.storage().persistent().set(&DataKey::Empty(level), &root);
        root = field_hash_pair(env, &mut hasher, &root, &root);
    }
    root
}

fn field_hash_pair(
    env: &Env,
    hasher: &mut FieldHasher,
    left: &BytesN<32>,
    right: &BytesN<32>,
) -> BytesN<32> {
    let inputs = soroban_sdk::vec![
        env,
        U256::from_be_bytes(env, &left.clone().into()),
        U256::from_be_bytes(env, &right.clone().into()),
    ];
    Bn254Fr::from_u256(hasher.compute_hash(&inputs)).to_bytes()
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

fn require_poseidon2_tree(env: &Env) {
    let version: Option<u32> = env.storage().persistent().get(&DataKey::TreeHashVersion);
    if version != Some(POSEIDON2_TREE_VERSION) {
        panic!("position tree requires Poseidon2 reset");
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

    use super::{field_hash_pair, DataKey, FieldHasher, PositionState, PositionStateClient};
    use governance::{Governance, GovernanceClient};
    use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Vec};

    #[test]
    fn hash_pair_matches_noir_and_typescript() {
        let env = Env::default();
        let one = super::Bn254Fr::from_u256(super::U256::from_u32(&env, 1)).to_bytes();
        let two = super::Bn254Fr::from_u256(super::U256::from_u32(&env, 2)).to_bytes();
        let mut hasher = FieldHasher::new(&env);
        assert_eq!(
            field_hash_pair(&env, &mut hasher, &one, &two),
            BytesN::from_array(&env, &[
                0x03, 0x86, 0x82, 0xaa, 0x1c, 0xb5, 0xae, 0x4e,
                0x0a, 0x3f, 0x13, 0xda, 0x43, 0x2a, 0x95, 0xc7,
                0x7c, 0x5c, 0x11, 0x1f, 0x6f, 0x03, 0x0f, 0xaf,
                0x9c, 0xad, 0x64, 0x1c, 0xe1, 0xed, 0x73, 0x83,
            ]),
        );
    }

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
    fn legacy_tree_cannot_append_until_one_time_reset() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);
        let old_root = value(&env, 7);
        let old_nullifier = value(&env, 8);

        client.init(&setup_governance(&env, &admin));
        env.mock_all_auths();
        client.set_writer(&writer, &true);
        env.as_contract(&id, || {
            let storage = env.storage().persistent();
            storage.remove(&DataKey::TreeHashVersion);
            storage.set(&DataKey::LeafCount, &6u32);
            storage.set(&DataKey::CurrentRoot, &old_root);
            storage.set(&DataKey::Root(old_root.clone()), &true);
            storage.set(&DataKey::Frontier(0), &value(&env, 3));
            storage.set(&DataKey::Spent(old_nullifier.clone()), &value(&env, 4));
        });

        assert!(client.try_append(&writer, &value(&env, 9)).is_err());
        assert!(!client.has_root(&old_root));
        client.reset_for_poseidon2();
        assert_eq!(client.leaf_count(), 0);
        assert_ne!(client.current_root(), old_root);
        assert!(!client.has_root(&old_root));
        assert!(client.has_root(&client.current_root()));
        assert!(client.is_spent(&old_nullifier));
        assert_eq!(client.append(&writer, &value(&env, 9)).first_index, 0);
        assert!(client.try_reset_for_poseidon2().is_err());
    }

    #[test]
    fn replays_twelve_leaves_across_append_batches() {
        let env = Env::default();
        let id = env.register(PositionState, ());
        let client = PositionStateClient::new(&env, &id);
        let admin = Address::generate(&env);
        let writer = Address::generate(&env);
        client.init(&setup_governance(&env, &admin));
        env.mock_all_auths();
        client.set_writer(&writer, &true);
        env.as_contract(&id, || env.storage().persistent().remove(&DataKey::TreeHashVersion));
        client.reset_for_poseidon2();

        let first = Vec::from_array(&env, [
            value(&env, 1), value(&env, 2), value(&env, 3), value(&env, 4),
            value(&env, 5), value(&env, 6), value(&env, 7), value(&env, 8),
        ]);
        let second = Vec::from_array(&env, [
            value(&env, 9), value(&env, 10), value(&env, 11), value(&env, 12),
        ]);
        env.cost_estimate().budget().reset_default();
        assert_eq!(client.append_many(&writer, &first).first_index, 0);
        env.cost_estimate().budget().reset_default();
        assert_eq!(client.append_many(&writer, &second).first_index, 8);
        assert_eq!(client.leaf_count(), 12);
        assert_eq!(client.current_root(), BytesN::from_array(&env, &[
            0x29, 0x9b, 0x9c, 0xf0, 0x7a, 0x4c, 0x0f, 0x75,
            0x6d, 0x55, 0xf0, 0xec, 0x8c, 0x64, 0x0d, 0x3a,
            0x0c, 0xac, 0x80, 0xad, 0xc6, 0x39, 0x6a, 0xae,
            0x30, 0x24, 0xb2, 0x5a, 0x81, 0x45, 0x48, 0xb4,
        ]));
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
                    0x2d, 0xb0, 0xec, 0x1d, 0x70, 0x02, 0x78, 0xf1, 0x83, 0x5a, 0xf5, 0xf7, 0x61,
                    0x50, 0x6e, 0xd1, 0x27, 0x03, 0x2b, 0xc9, 0x0e, 0x0b, 0xe6, 0xfc, 0x4e, 0x79,
                    0xaa, 0x3f, 0x18, 0x50, 0x96, 0xee,
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
