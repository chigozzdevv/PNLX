#![no_std]

use oracle_interface::{OracleAsset, PriceData};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Decimals,
    Price(OracleAsset),
    Prices(OracleAsset),
}

#[contract]
pub struct TestOracle;

#[contractimpl]
impl TestOracle {
    pub fn init(env: Env, decimals: u32) {
        env.storage()
            .persistent()
            .set(&DataKey::Decimals, &decimals);
    }

    pub fn set_price(env: Env, asset: OracleAsset, price: i128, timestamp: u64) {
        env.storage().persistent().set(
            &DataKey::Price(asset.clone()),
            &PriceData { price, timestamp },
        );
        env.storage().persistent().set(
            &DataKey::Prices(asset.clone()),
            &Vec::from_array(&env, [PriceData { price, timestamp }]),
        );
    }

    pub fn set_prices(env: Env, asset: OracleAsset, prices: Vec<PriceData>) {
        if prices.len() == 0 {
            panic!("empty prices");
        }
        let last = prices.get(prices.len() - 1).unwrap();
        env.storage()
            .persistent()
            .set(&DataKey::Price(asset.clone()), &last);
        env.storage()
            .persistent()
            .set(&DataKey::Prices(asset), &prices);
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::Decimals)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn lastprice(env: Env, asset: OracleAsset) -> Option<PriceData> {
        env.storage().persistent().get(&DataKey::Price(asset))
    }

    pub fn prices(env: Env, asset: OracleAsset, records: u32) -> Option<Vec<PriceData>> {
        let stored: Option<Vec<PriceData>> =
            env.storage().persistent().get(&DataKey::Prices(asset));
        let prices = stored?;
        if prices.len() < records {
            return None;
        }

        let start = prices.len() - records;
        let mut out = Vec::new(&env);
        let mut index = start;
        while index < prices.len() {
            out.push_back(prices.get(index).unwrap());
            index += 1;
        }
        Some(out)
    }

    pub fn beam_lastprice(env: Env, _caller: Address, asset: OracleAsset) -> Option<PriceData> {
        Self::lastprice(env, asset)
    }

    pub fn beam_prices(
        env: Env,
        _caller: Address,
        asset: OracleAsset,
        records: u32,
    ) -> Option<Vec<PriceData>> {
        Self::prices(env, asset, records)
    }
}
