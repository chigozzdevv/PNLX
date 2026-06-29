#![no_std]

use soroban_sdk::{contractclient, contracttype, Address, Env, Symbol, Vec};

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum OracleAsset {
    Stellar(Address),
    Other(Symbol),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contractclient(name = "Sep40OracleClient")]
pub trait Sep40OracleInterface {
    fn decimals(env: Env) -> u32;
    fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData>;
    fn prices(env: Env, asset: OracleAsset, records: u32) -> Option<Vec<PriceData>>;
}

#[contractclient(name = "ReflectorBeamOracleClient")]
pub trait ReflectorBeamOracleInterface {
    fn decimals(env: Env) -> u32;
    fn estimate_cost(env: Env, periods: u32) -> i128;
    fn lastprice(env: Env, caller: Address, asset: OracleAsset) -> Option<PriceData>;
    fn prices(
        env: Env,
        caller: Address,
        asset: OracleAsset,
        records: u32,
    ) -> Option<Vec<PriceData>>;
}
