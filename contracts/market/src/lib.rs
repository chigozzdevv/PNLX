#![no_std]

use governance_interface::GovernanceClient;
use market_interface::MarketPrice;
use oracle_interface::{OracleAsset, PriceData, ReflectorBeamOracleClient, Sep40OracleClient};
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, IntoVal, Symbol, Val,
    Vec,
};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    FundingUpdater(Address),
    Governance,
    Market(BytesN<32>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct MarketConfig {
    pub oracle_contract: Address,
    pub oracle_kind: Symbol,
    pub oracle_asset: OracleAsset,
    pub beam_fee_token: Option<Address>,
    pub oracle_max_age: u64,
    pub oracle_twap_records: u32,
    pub price_decimals: u32,
    pub max_leverage: i128,
    pub initial_rate: i128,
    pub maintenance_rate: i128,
    pub funding_index: i128,
    pub active: bool,
}

#[contract]
pub struct Market;

#[contractimpl]
impl Market {
    pub fn init(env: Env, governance: Address) {
        if env.storage().persistent().has(&DataKey::Governance) {
            panic!("already initialized");
        }
        env.storage()
            .persistent()
            .set(&DataKey::Governance, &governance);
    }

    pub fn upsert(env: Env, market_id: BytesN<32>, config: MarketConfig) {
        require_market_admin(&env);
        validate_config(&env, &config);
        if config.active {
            read_oracle_price(&env, &config);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Market(market_id), &config);
    }

    pub fn set_funding_updater(env: Env, updater: Address, enabled: bool) {
        require_market_admin(&env);
        env.storage()
            .persistent()
            .set(&DataKey::FundingUpdater(updater), &enabled);
    }

    pub fn is_funding_updater(env: Env, updater: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::FundingUpdater(updater))
            .unwrap_or(false)
    }

    pub fn funding_index(env: Env, market_id: BytesN<32>) -> i128 {
        Self::get(env, market_id).funding_index
    }

    pub fn advance_funding(
        env: Env,
        updater: Address,
        market_id: BytesN<32>,
        old_index: i128,
        new_index: i128,
    ) {
        require_funding_updater(&env, &updater);
        if new_index == old_index {
            panic!("funding unchanged");
        }

        let key = DataKey::Market(market_id);
        let mut config: MarketConfig = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic!("unknown market"));
        if !config.active {
            panic!("inactive market");
        }
        if config.funding_index != old_index {
            panic!("stale funding index");
        }

        config.funding_index = new_index;
        env.storage().persistent().set(&key, &config);
    }

    pub fn upsert_other(
        env: Env,
        market_id: BytesN<32>,
        oracle_contract: Address,
        oracle_kind: Symbol,
        oracle_asset: Symbol,
        oracle_max_age: u64,
        oracle_twap_records: u32,
        price_decimals: u32,
        max_leverage: i128,
        initial_rate: i128,
        maintenance_rate: i128,
        funding_index: i128,
        active: bool,
    ) {
        Self::upsert(
            env,
            market_id,
            MarketConfig {
                oracle_contract,
                oracle_kind,
                oracle_asset: OracleAsset::Other(oracle_asset),
                beam_fee_token: None,
                oracle_max_age,
                oracle_twap_records,
                price_decimals,
                max_leverage,
                initial_rate,
                maintenance_rate,
                funding_index,
                active,
            },
        );
    }

    pub fn upsert_stellar(
        env: Env,
        market_id: BytesN<32>,
        oracle_contract: Address,
        oracle_kind: Symbol,
        oracle_asset: Address,
        oracle_max_age: u64,
        oracle_twap_records: u32,
        price_decimals: u32,
        max_leverage: i128,
        initial_rate: i128,
        maintenance_rate: i128,
        funding_index: i128,
        active: bool,
    ) {
        Self::upsert(
            env,
            market_id,
            MarketConfig {
                oracle_contract,
                oracle_kind,
                oracle_asset: OracleAsset::Stellar(oracle_asset),
                beam_fee_token: None,
                oracle_max_age,
                oracle_twap_records,
                price_decimals,
                max_leverage,
                initial_rate,
                maintenance_rate,
                funding_index,
                active,
            },
        );
    }

    pub fn upsert_beam_other(
        env: Env,
        market_id: BytesN<32>,
        oracle_contract: Address,
        oracle_asset: Symbol,
        beam_fee_token: Address,
        oracle_max_age: u64,
        oracle_twap_records: u32,
        price_decimals: u32,
        max_leverage: i128,
        initial_rate: i128,
        maintenance_rate: i128,
        funding_index: i128,
        active: bool,
    ) {
        Self::upsert(
            env,
            market_id,
            MarketConfig {
                oracle_contract,
                oracle_kind: symbol_short!("beam"),
                oracle_asset: OracleAsset::Other(oracle_asset),
                beam_fee_token: Some(beam_fee_token),
                oracle_max_age,
                oracle_twap_records,
                price_decimals,
                max_leverage,
                initial_rate,
                maintenance_rate,
                funding_index,
                active,
            },
        );
    }

    pub fn upsert_beam_stellar(
        env: Env,
        market_id: BytesN<32>,
        oracle_contract: Address,
        oracle_asset: Address,
        beam_fee_token: Address,
        oracle_max_age: u64,
        oracle_twap_records: u32,
        price_decimals: u32,
        max_leverage: i128,
        initial_rate: i128,
        maintenance_rate: i128,
        funding_index: i128,
        active: bool,
    ) {
        Self::upsert(
            env,
            market_id,
            MarketConfig {
                oracle_contract,
                oracle_kind: symbol_short!("beam"),
                oracle_asset: OracleAsset::Stellar(oracle_asset),
                beam_fee_token: Some(beam_fee_token),
                oracle_max_age,
                oracle_twap_records,
                price_decimals,
                max_leverage,
                initial_rate,
                maintenance_rate,
                funding_index,
                active,
            },
        );
    }

    pub fn get(env: Env, market_id: BytesN<32>) -> MarketConfig {
        env.storage()
            .persistent()
            .get(&DataKey::Market(market_id))
            .unwrap_or_else(|| panic!("unknown market"))
    }

    pub fn is_active(env: Env, market_id: BytesN<32>) -> bool {
        Self::get(env, market_id).active
    }

    pub fn mark_price(env: Env, market_id: BytesN<32>) -> MarketPrice {
        let config = Self::get(env.clone(), market_id);
        if !config.active {
            panic!("inactive market");
        }
        read_oracle_price(&env, &config)
    }
}

fn require_market_admin(env: &Env) {
    let governance_id: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Governance)
        .unwrap_or_else(|| panic!("not initialized"));
    let governance = GovernanceClient::new(env, &governance_id);
    if governance.paused() {
        panic!("paused");
    }
    governance.admin().require_auth();
}

fn require_funding_updater(env: &Env, updater: &Address) {
    updater.require_auth();
    if !Market::is_funding_updater(env.clone(), updater.clone()) {
        panic!("unauthorized funding updater");
    }
}

fn validate_config(env: &Env, config: &MarketConfig) {
    if config.oracle_contract == env.current_contract_address() {
        panic!("invalid oracle");
    }
    if config.oracle_kind != symbol_short!("sep40") && config.oracle_kind != symbol_short!("beam") {
        panic!("invalid oracle kind");
    }
    if config.oracle_kind == symbol_short!("beam") && config.beam_fee_token.is_none() {
        panic!("missing beam fee token");
    }
    if config.oracle_max_age == 0 {
        panic!("invalid oracle age");
    }
    if config.price_decimals > 18 {
        panic!("invalid price decimals");
    }
    if config.max_leverage <= 0 {
        panic!("invalid leverage");
    }
    if config.initial_rate <= 0 || config.maintenance_rate <= 0 {
        panic!("invalid margin rate");
    }
    if config.maintenance_rate > config.initial_rate {
        panic!("invalid maintenance rate");
    }
}

fn read_oracle_price(env: &Env, config: &MarketConfig) -> MarketPrice {
    let records = if config.oracle_twap_records < 2 {
        1
    } else {
        config.oracle_twap_records
    };
    let decimals = oracle_decimals(env, config);
    let data = if records == 1 {
        oracle_last_price(env, config)
    } else {
        oracle_twap(env, config, records)
    };

    validate_price_freshness(env, &data, config.oracle_max_age);
    MarketPrice {
        price: scale_price(data.price, decimals, config.price_decimals),
        timestamp: data.timestamp,
    }
}

fn oracle_decimals(env: &Env, config: &MarketConfig) -> u32 {
    if config.oracle_kind == symbol_short!("sep40") {
        Sep40OracleClient::new(env, &config.oracle_contract).decimals()
    } else if config.oracle_kind == symbol_short!("beam") {
        ReflectorBeamOracleClient::new(env, &config.oracle_contract).decimals()
    } else {
        panic!("invalid oracle kind");
    }
}

fn oracle_last_price(env: &Env, config: &MarketConfig) -> PriceData {
    let data = if config.oracle_kind == symbol_short!("sep40") {
        Sep40OracleClient::new(env, &config.oracle_contract).lastprice(&config.oracle_asset)
    } else if config.oracle_kind == symbol_short!("beam") {
        authorize_beam_spend(env, config, 1);
        ReflectorBeamOracleClient::new(env, &config.oracle_contract)
            .lastprice(&env.current_contract_address(), &config.oracle_asset)
    } else {
        panic!("invalid oracle kind");
    };

    data.unwrap_or_else(|| panic!("oracle price unavailable"))
}

fn oracle_twap(env: &Env, config: &MarketConfig, records: u32) -> PriceData {
    let prices = if config.oracle_kind == symbol_short!("sep40") {
        Sep40OracleClient::new(env, &config.oracle_contract).prices(&config.oracle_asset, &records)
    } else if config.oracle_kind == symbol_short!("beam") {
        authorize_beam_spend(env, config, records);
        ReflectorBeamOracleClient::new(env, &config.oracle_contract).prices(
            &env.current_contract_address(),
            &config.oracle_asset,
            &records,
        )
    } else {
        panic!("invalid oracle kind");
    }
    .unwrap_or_else(|| panic!("oracle twap unavailable"));

    if prices.len() < records {
        panic!("oracle twap unavailable");
    }

    let mut index = 0;
    let mut total = 0i128;
    let mut timestamp = 0u64;
    while index < prices.len() {
        let item = prices.get(index).unwrap();
        validate_price_freshness(env, &item, config.oracle_max_age);
        total += item.price;
        if item.timestamp > timestamp {
            timestamp = item.timestamp;
        }
        index += 1;
    }

    PriceData {
        price: total / (prices.len() as i128),
        timestamp,
    }
}

fn authorize_beam_spend(env: &Env, config: &MarketConfig, periods: u32) {
    let token = config
        .beam_fee_token
        .clone()
        .unwrap_or_else(|| panic!("missing beam fee token"));
    let beam = ReflectorBeamOracleClient::new(env, &config.oracle_contract);
    let cost = beam.estimate_cost(&periods);
    if cost <= 0 {
        return;
    }

    let args: Vec<Val> = Vec::from_array(
        env,
        [
            env.current_contract_address().into_val(env),
            cost.into_val(env),
        ],
    );
    let invocation = InvokerContractAuthEntry::Contract(SubContractInvocation {
        context: ContractContext {
            contract: token,
            fn_name: symbol_short!("burn"),
            args,
        },
        sub_invocations: Vec::new(env),
    });
    env.authorize_as_current_contract(Vec::from_array(env, [invocation]));
}

fn validate_price_freshness(env: &Env, data: &PriceData, max_age: u64) {
    if data.price <= 0 {
        panic!("invalid oracle price");
    }

    let now = env.ledger().timestamp();
    if data.timestamp > now {
        panic!("future oracle price");
    }
    if now - data.timestamp > max_age {
        panic!("stale oracle price");
    }
}

fn scale_price(price: i128, source_decimals: u32, target_decimals: u32) -> i128 {
    if source_decimals == target_decimals {
        return price;
    }
    if source_decimals < target_decimals {
        return price * pow10(target_decimals - source_decimals);
    }
    price / pow10(source_decimals - target_decimals)
}

fn pow10(exponent: u32) -> i128 {
    let mut value = 1i128;
    let mut index = 0;
    while index < exponent {
        value *= 10;
        index += 1;
    }
    value
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{Market, MarketClient, MarketConfig};
    use governance::{Governance, GovernanceClient};
    use test_oracle::{TestOracle, TestOracleClient};
    use oracle_interface::{OracleAsset, PriceData};
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Ledger},
        Address, BytesN, Env, Symbol, Vec,
    };

    #[test]
    fn stores_market_and_reads_fresh_sep40_price() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle = setup_oracle(&env, 50_000_00000000, 950);
        let id = env.register(Market, ());
        let client = MarketClient::new(&env, &id);
        client.init(&setup_governance(&env));
        let market = BytesN::from_array(&env, &[8; 32]);

        client.upsert_other(
            &market,
            &oracle,
            &symbol_short!("sep40"),
            &Symbol::new(&env, "BTC"),
            &120,
            &1,
            &8,
            &5,
            &200_000,
            &100_000,
            &0,
            &true,
        );

        let config = client.get(&market);
        let price = client.mark_price(&market);

        assert_eq!(config.active, true);
        assert_eq!(price.price, 50_000_00000000);
        assert_eq!(price.timestamp, 950);
        assert!(client.is_active(&market));
    }

    #[test]
    fn applies_twap_records() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle = env.register(TestOracle, ());
        let oracle_client = TestOracleClient::new(&env, &oracle);
        let asset = OracleAsset::Other(Symbol::new(&env, "BTC"));
        oracle_client.init(&8);
        oracle_client.set_prices(
            &asset,
            &Vec::from_array(
                &env,
                [
                    PriceData {
                        price: 48_000_00000000,
                        timestamp: 920,
                    },
                    PriceData {
                        price: 50_000_00000000,
                        timestamp: 940,
                    },
                    PriceData {
                        price: 52_000_00000000,
                        timestamp: 960,
                    },
                ],
            ),
        );

        let id = env.register(Market, ());
        let client = MarketClient::new(&env, &id);
        client.init(&setup_governance(&env));
        let market = BytesN::from_array(&env, &[8; 32]);
        client.upsert_other(
            &market,
            &oracle,
            &symbol_short!("sep40"),
            &Symbol::new(&env, "BTC"),
            &120,
            &3,
            &8,
            &5,
            &200_000,
            &100_000,
            &0,
            &true,
        );

        let price = client.mark_price(&market);

        assert_eq!(price.price, 50_000_00000000);
        assert_eq!(price.timestamp, 960);
    }

    #[test]
    #[should_panic(expected = "stale oracle price")]
    fn rejects_stale_oracle_price() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle = setup_oracle(&env, 50_000_00000000, 700);
        let id = env.register(Market, ());
        let client = MarketClient::new(&env, &id);
        client.init(&setup_governance(&env));
        let market = BytesN::from_array(&env, &[8; 32]);

        client.upsert_other(
            &market,
            &oracle,
            &symbol_short!("sep40"),
            &Symbol::new(&env, "BTC"),
            &120,
            &1,
            &8,
            &5,
            &200_000,
            &100_000,
            &0,
            &true,
        );
    }

    #[test]
    #[should_panic(expected = "invalid maintenance rate")]
    fn rejects_bad_margin_config() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle = setup_oracle(&env, 50_000_00000000, 950);
        let id = env.register(Market, ());
        let client = MarketClient::new(&env, &id);
        client.init(&setup_governance(&env));
        let market = BytesN::from_array(&env, &[8; 32]);
        let config = MarketConfig {
            oracle_contract: oracle,
            oracle_kind: symbol_short!("sep40"),
            oracle_asset: OracleAsset::Other(Symbol::new(&env, "BTC")),
            beam_fee_token: None,
            oracle_max_age: 120,
            oracle_twap_records: 1,
            price_decimals: 8,
            max_leverage: 5,
            initial_rate: 100_000,
            maintenance_rate: 200_000,
            funding_index: 0,
            active: true,
        };

        client.upsert(&market, &config);
    }

    #[test]
    #[should_panic(expected = "not initialized")]
    fn rejects_upsert_before_init() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle = setup_oracle(&env, 50_000_00000000, 950);
        let id = env.register(Market, ());
        let client = MarketClient::new(&env, &id);
        let market = BytesN::from_array(&env, &[8; 32]);

        client.upsert_other(
            &market,
            &oracle,
            &symbol_short!("sep40"),
            &Symbol::new(&env, "BTC"),
            &120,
            &1,
            &8,
            &5,
            &200_000,
            &100_000,
            &0,
            &true,
        );
    }

    #[test]
    fn funding_updater_advances_only_funding_index() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle = setup_oracle(&env, 50_000_00000000, 950);
        let id = env.register(Market, ());
        let client = MarketClient::new(&env, &id);
        let updater = Address::generate(&env);
        let market = BytesN::from_array(&env, &[8; 32]);
        client.init(&setup_governance(&env));
        client.upsert_other(
            &market,
            &oracle,
            &symbol_short!("sep40"),
            &Symbol::new(&env, "BTC"),
            &120,
            &1,
            &8,
            &5,
            &200_000,
            &100_000,
            &7,
            &true,
        );

        client.set_funding_updater(&updater, &true);
        client.advance_funding(&updater, &market, &7, &11);

        let config = client.get(&market);
        assert_eq!(config.funding_index, 11);
        assert_eq!(config.max_leverage, 5);
        assert!(client.is_funding_updater(&updater));
        assert_eq!(client.funding_index(&market), 11);
    }

    #[test]
    #[should_panic(expected = "unauthorized funding updater")]
    fn rejects_unknown_funding_updater() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle = setup_oracle(&env, 50_000_00000000, 950);
        let id = env.register(Market, ());
        let client = MarketClient::new(&env, &id);
        let updater = Address::generate(&env);
        let market = BytesN::from_array(&env, &[8; 32]);
        client.init(&setup_governance(&env));
        client.upsert_other(
            &market,
            &oracle,
            &symbol_short!("sep40"),
            &Symbol::new(&env, "BTC"),
            &120,
            &1,
            &8,
            &5,
            &200_000,
            &100_000,
            &7,
            &true,
        );

        client.advance_funding(&updater, &market, &7, &11);
    }

    #[test]
    #[should_panic(expected = "stale funding index")]
    fn rejects_stale_funding_index() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);
        let oracle = setup_oracle(&env, 50_000_00000000, 950);
        let id = env.register(Market, ());
        let client = MarketClient::new(&env, &id);
        let updater = Address::generate(&env);
        let market = BytesN::from_array(&env, &[8; 32]);
        client.init(&setup_governance(&env));
        client.upsert_other(
            &market,
            &oracle,
            &symbol_short!("sep40"),
            &Symbol::new(&env, "BTC"),
            &120,
            &1,
            &8,
            &5,
            &200_000,
            &100_000,
            &7,
            &true,
        );

        client.set_funding_updater(&updater, &true);
        client.advance_funding(&updater, &market, &6, &11);
    }

    fn setup_oracle(env: &Env, price: i128, timestamp: u64) -> Address {
        let oracle = env.register(TestOracle, ());
        let client = TestOracleClient::new(env, &oracle);
        client.init(&8);
        client.set_price(
            &OracleAsset::Other(Symbol::new(env, "BTC")),
            &price,
            &timestamp,
        );
        oracle
    }

    fn setup_governance(env: &Env) -> Address {
        let id = env.register(Governance, ());
        let client = GovernanceClient::new(env, &id);
        client.init(&Address::generate(env));
        id
    }
}
