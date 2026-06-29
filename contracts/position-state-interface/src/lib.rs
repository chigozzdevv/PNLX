#![no_std]

use soroban_sdk::{contractclient, Address, BytesN, Env};

#[contractclient(name = "PositionStateClient")]
pub trait PositionStateInterface {
    fn current_root(env: Env) -> BytesN<32>;
    fn has_root(env: Env, root: BytesN<32>) -> bool;
    fn is_spent(env: Env, position_nullifier: BytesN<32>) -> bool;
    fn advance_root(env: Env, writer: Address, old_root: BytesN<32>, new_root: BytesN<32>);
    fn spend_position(
        env: Env,
        writer: Address,
        position_root: BytesN<32>,
        position_commitment: BytesN<32>,
        position_nullifier: BytesN<32>,
    );
}
