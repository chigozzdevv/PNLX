#![no_std]

use soroban_sdk::{contractclient, contracttype, Address, BytesN, Env, Vec};

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct AppendReceipt {
    pub count: u32,
    pub first_index: u32,
    pub root: BytesN<32>,
}

#[contractclient(name = "PositionStateClient")]
pub trait PositionStateInterface {
    fn current_root(env: Env) -> BytesN<32>;
    fn leaf_count(env: Env) -> u32;
    fn tree_depth(env: Env) -> u32;
    fn has_root(env: Env, root: BytesN<32>) -> bool;
    fn is_spent(env: Env, position_nullifier: BytesN<32>) -> bool;
    fn append(env: Env, writer: Address, commitment: BytesN<32>) -> AppendReceipt;
    fn append_many(env: Env, writer: Address, commitments: Vec<BytesN<32>>) -> AppendReceipt;
    fn spend_position(
        env: Env,
        writer: Address,
        membership_root: BytesN<32>,
        position_commitment: BytesN<32>,
        position_nullifier: BytesN<32>,
    );
}
