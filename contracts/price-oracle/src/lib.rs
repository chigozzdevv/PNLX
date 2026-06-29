#![no_std]

use oracle_interface::{OracleAsset, PriceData};
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, Vec};

const MAX_RECORDS: u32 = 64;
const MAX_COMMITTEE_SUBMISSIONS: u32 = 16;
const BPS_SCALE: i128 = 10_000;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    CommitteeConfig,
    Decimals,
    LatestRound(OracleAsset),
    Price(OracleAsset),
    Prices(OracleAsset),
    Publisher(Address),
    RoundSubmissions(OracleAsset, u64),
    Submission(OracleAsset, u64, Address),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct CommitteeConfig {
    pub threshold: u32,
    pub max_deviation_bps: u32,
    pub max_timestamp_age: u64,
}

#[contract]
pub struct PriceOracle;

#[contractimpl]
impl PriceOracle {
    pub fn init(env: Env, admin: Address, decimals: u32) {
        if env.storage().persistent().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        if decimals > 18 {
            panic!("invalid decimals");
        }
        admin.require_auth();
        env.storage().persistent().set(&DataKey::Admin, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::Decimals, &decimals);
        env.storage()
            .persistent()
            .set(&DataKey::CommitteeConfig, &default_committee_config());
        env.storage()
            .persistent()
            .set(&DataKey::Publisher(admin), &true);
    }

    pub fn set_other_price(env: Env, admin: Address, asset: Symbol, price: i128, timestamp: u64) {
        write_price(&env, &admin, OracleAsset::Other(asset), price, timestamp);
    }

    pub fn set_stellar_price(
        env: Env,
        admin: Address,
        asset: Address,
        price: i128,
        timestamp: u64,
    ) {
        write_price(&env, &admin, OracleAsset::Stellar(asset), price, timestamp);
    }

    pub fn configure_committee(
        env: Env,
        admin: Address,
        threshold: u32,
        max_timestamp_age: u64,
        max_deviation_bps: u32,
    ) {
        require_admin(&env, &admin);
        validate_committee_config(threshold, max_timestamp_age, max_deviation_bps);
        env.storage().persistent().set(
            &DataKey::CommitteeConfig,
            &CommitteeConfig {
                threshold,
                max_deviation_bps,
                max_timestamp_age,
            },
        );
    }

    pub fn set_publisher(env: Env, admin: Address, publisher: Address, enabled: bool) {
        require_admin(&env, &admin);
        env.storage()
            .persistent()
            .set(&DataKey::Publisher(publisher), &enabled);
    }

    pub fn submit_other_price(
        env: Env,
        publisher: Address,
        asset: Symbol,
        round: u64,
        price: i128,
        timestamp: u64,
    ) {
        submit_price(
            &env,
            &publisher,
            OracleAsset::Other(asset),
            round,
            price,
            timestamp,
        );
    }

    pub fn submit_stellar_price(
        env: Env,
        publisher: Address,
        asset: Address,
        round: u64,
        price: i128,
        timestamp: u64,
    ) {
        submit_price(
            &env,
            &publisher,
            OracleAsset::Stellar(asset),
            round,
            price,
            timestamp,
        );
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
        if records == 0 || records > MAX_RECORDS {
            return None;
        }
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

    pub fn admin(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    pub fn committee_config(env: Env) -> CommitteeConfig {
        committee_config(&env)
    }

    pub fn is_publisher(env: Env, publisher: Address) -> bool {
        is_publisher(&env, &publisher)
    }
}

fn write_price(env: &Env, admin: &Address, asset: OracleAsset, price: i128, timestamp: u64) {
    validate_price(price);
    require_admin(env, admin);
    append_price(env, asset, PriceData { price, timestamp });
}

fn submit_price(
    env: &Env,
    publisher: &Address,
    asset: OracleAsset,
    round: u64,
    price: i128,
    timestamp: u64,
) {
    validate_price(price);
    if !is_publisher(env, publisher) {
        panic!("unauthorized publisher");
    }
    publisher.require_auth();

    let config = committee_config(env);
    validate_submission_timestamp(env, timestamp, config.max_timestamp_age);
    let latest_round: u64 = env
        .storage()
        .persistent()
        .get(&DataKey::LatestRound(asset.clone()))
        .unwrap_or(0);
    if round <= latest_round {
        panic!("stale round");
    }

    let submission_key = DataKey::Submission(asset.clone(), round, publisher.clone());
    if env.storage().persistent().has(&submission_key) {
        panic!("duplicate submission");
    }

    let data = PriceData { price, timestamp };
    env.storage().persistent().set(&submission_key, &data);

    let mut submissions: Vec<PriceData> = env
        .storage()
        .persistent()
        .get(&DataKey::RoundSubmissions(asset.clone(), round))
        .unwrap_or_else(|| Vec::new(env));
    if submissions.len() >= MAX_COMMITTEE_SUBMISSIONS {
        panic!("too many submissions");
    }
    submissions.push_back(data);
    env.storage().persistent().set(
        &DataKey::RoundSubmissions(asset.clone(), round),
        &submissions,
    );

    if submissions.len() >= config.threshold {
        let aggregated = aggregate_price(env, &submissions, config.max_deviation_bps);
        env.storage()
            .persistent()
            .set(&DataKey::LatestRound(asset.clone()), &round);
        append_price(env, asset, aggregated);
    }
}

fn append_price(env: &Env, asset: OracleAsset, data: PriceData) {
    let mut prices: Vec<PriceData> = env
        .storage()
        .persistent()
        .get(&DataKey::Prices(asset.clone()))
        .unwrap_or_else(|| Vec::new(env));
    prices.push_back(data.clone());
    while prices.len() > MAX_RECORDS {
        prices.pop_front();
    }

    env.storage()
        .persistent()
        .set(&DataKey::Price(asset.clone()), &data);
    env.storage()
        .persistent()
        .set(&DataKey::Prices(asset), &prices);
}

fn aggregate_price(env: &Env, submissions: &Vec<PriceData>, max_deviation_bps: u32) -> PriceData {
    let median = median_price(submissions);
    validate_deviation(submissions, median, max_deviation_bps);
    PriceData {
        price: median,
        timestamp: min_timestamp(env, submissions),
    }
}

fn median_price(submissions: &Vec<PriceData>) -> i128 {
    let target = submissions.len() / 2;
    let mut index = 0;
    while index < submissions.len() {
        let candidate = submissions.get(index).unwrap().price;
        let mut lower = 0;
        let mut equal = 0;
        let mut inner = 0;
        while inner < submissions.len() {
            let price = submissions.get(inner).unwrap().price;
            if price < candidate {
                lower += 1;
            }
            if price == candidate {
                equal += 1;
            }
            inner += 1;
        }
        if lower <= target && target < lower + equal {
            return candidate;
        }
        index += 1;
    }
    panic!("missing median");
}

fn min_timestamp(env: &Env, submissions: &Vec<PriceData>) -> u64 {
    let mut timestamp = env.ledger().timestamp();
    let mut index = 0;
    while index < submissions.len() {
        let candidate = submissions.get(index).unwrap().timestamp;
        if candidate < timestamp {
            timestamp = candidate;
        }
        index += 1;
    }
    timestamp
}

fn validate_deviation(submissions: &Vec<PriceData>, median: i128, max_deviation_bps: u32) {
    let mut index = 0;
    while index < submissions.len() {
        let price = submissions.get(index).unwrap().price;
        let diff = if price >= median {
            price - median
        } else {
            median - price
        };
        if diff * BPS_SCALE > median * max_deviation_bps as i128 {
            panic!("price deviation");
        }
        index += 1;
    }
}

fn validate_price(price: i128) {
    if price <= 0 {
        panic!("invalid price");
    }
}

fn validate_submission_timestamp(env: &Env, timestamp: u64, max_timestamp_age: u64) {
    let now = env.ledger().timestamp();
    if timestamp > now {
        panic!("future price");
    }
    if now - timestamp > max_timestamp_age {
        panic!("stale price");
    }
}

fn require_admin(env: &Env, admin: &Address) {
    let stored_admin: Address = env
        .storage()
        .persistent()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic!("not initialized"));
    if *admin != stored_admin {
        panic!("unauthorized");
    }
    admin.require_auth();
}

fn is_publisher(env: &Env, publisher: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Publisher(publisher.clone()))
        .unwrap_or(false)
}

fn committee_config(env: &Env) -> CommitteeConfig {
    env.storage()
        .persistent()
        .get(&DataKey::CommitteeConfig)
        .unwrap_or_else(|| panic!("not initialized"))
}

fn default_committee_config() -> CommitteeConfig {
    CommitteeConfig {
        threshold: 1,
        max_deviation_bps: 100,
        max_timestamp_age: 300,
    }
}

fn validate_committee_config(threshold: u32, max_timestamp_age: u64, max_deviation_bps: u32) {
    if threshold == 0 || threshold > MAX_COMMITTEE_SUBMISSIONS {
        panic!("invalid threshold");
    }
    if max_timestamp_age == 0 {
        panic!("invalid timestamp age");
    }
    if max_deviation_bps == 0 || max_deviation_bps > 10_000 {
        panic!("invalid deviation");
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::{CommitteeConfig, PriceOracle, PriceOracleClient};
    use oracle_interface::OracleAsset;
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env, Symbol,
    };

    #[test]
    fn stores_last_price_and_history() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(PriceOracle, ());
        let client = PriceOracleClient::new(&env, &id);
        let admin = Address::generate(&env);
        let asset = Symbol::new(&env, "BTC");

        client.init(&admin, &8);
        client.set_other_price(&admin, &asset, &50_000_00000000, &1_000);
        client.set_other_price(&admin, &asset, &50_100_00000000, &1_010);

        let last = client
            .lastprice(&OracleAsset::Other(asset.clone()))
            .unwrap();
        let history = client.prices(&OracleAsset::Other(asset), &2).unwrap();

        assert_eq!(client.decimals(), 8);
        assert_eq!(
            client.committee_config(),
            CommitteeConfig {
                threshold: 1,
                max_deviation_bps: 100,
                max_timestamp_age: 300
            }
        );
        assert!(client.is_publisher(&admin));
        assert_eq!(last.price, 50_100_00000000);
        assert_eq!(last.timestamp, 1_010);
        assert_eq!(history.len(), 2);
    }

    #[test]
    #[should_panic(expected = "unauthorized")]
    fn rejects_wrong_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(PriceOracle, ());
        let client = PriceOracleClient::new(&env, &id);
        let admin = Address::generate(&env);
        let wrong = Address::generate(&env);

        client.init(&admin, &8);
        client.set_other_price(&wrong, &Symbol::new(&env, "BTC"), &50_000_00000000, &1_000);
    }

    #[test]
    fn committee_publishes_median_price_after_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_100);
        let id = env.register(PriceOracle, ());
        let client = PriceOracleClient::new(&env, &id);
        let admin = Address::generate(&env);
        let publisher_a = Address::generate(&env);
        let publisher_b = Address::generate(&env);
        let publisher_c = Address::generate(&env);
        let asset = Symbol::new(&env, "XLM");

        client.init(&admin, &8);
        client.configure_committee(&admin, &3, &300, &100);
        client.set_publisher(&admin, &publisher_a, &true);
        client.set_publisher(&admin, &publisher_b, &true);
        client.set_publisher(&admin, &publisher_c, &true);

        client.submit_other_price(&publisher_a, &asset, &42, &17_900_000, &1_095);
        assert!(client
            .lastprice(&OracleAsset::Other(asset.clone()))
            .is_none());

        client.submit_other_price(&publisher_b, &asset, &42, &17_910_000, &1_096);
        assert!(client
            .lastprice(&OracleAsset::Other(asset.clone()))
            .is_none());

        client.submit_other_price(&publisher_c, &asset, &42, &17_905_000, &1_097);
        let last = client.lastprice(&OracleAsset::Other(asset)).unwrap();

        assert_eq!(last.price, 17_905_000);
        assert_eq!(last.timestamp, 1_095);
    }

    #[test]
    #[should_panic(expected = "duplicate submission")]
    fn rejects_duplicate_committee_submission() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_100);
        let id = env.register(PriceOracle, ());
        let client = PriceOracleClient::new(&env, &id);
        let admin = Address::generate(&env);
        let publisher = Address::generate(&env);
        let asset = Symbol::new(&env, "ETH");

        client.init(&admin, &8);
        client.configure_committee(&admin, &2, &300, &100);
        client.set_publisher(&admin, &publisher, &true);
        client.submit_other_price(&publisher, &asset, &7, &150_000_000000, &1_095);
        client.submit_other_price(&publisher, &asset, &7, &150_000_000000, &1_095);
    }

    #[test]
    #[should_panic(expected = "price deviation")]
    fn rejects_committee_round_with_outlier_price() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_100);
        let id = env.register(PriceOracle, ());
        let client = PriceOracleClient::new(&env, &id);
        let admin = Address::generate(&env);
        let publisher_a = Address::generate(&env);
        let publisher_b = Address::generate(&env);
        let publisher_c = Address::generate(&env);
        let asset = Symbol::new(&env, "BTC");

        client.init(&admin, &8);
        client.configure_committee(&admin, &3, &300, &100);
        client.set_publisher(&admin, &publisher_a, &true);
        client.set_publisher(&admin, &publisher_b, &true);
        client.set_publisher(&admin, &publisher_c, &true);

        client.submit_other_price(&publisher_a, &asset, &9, &50_000_00000000, &1_095);
        client.submit_other_price(&publisher_b, &asset, &9, &50_100_00000000, &1_096);
        client.submit_other_price(&publisher_c, &asset, &9, &55_000_00000000, &1_097);
    }
}
