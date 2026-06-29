fn main(
    size: u128,
    price: pub u128,
    margin: u128,
    initial_rate: pub u128,
    max_leverage: pub u128,
    price_scale: pub u128,
    rate_scale: pub u128,
) {
    let notional = (size * price) / price_scale;
    let required = (notional * initial_rate) / rate_scale;
    assert(margin >= required);
    assert(notional <= margin * max_leverage);
}

#[test]
fn valid_margin() {
    main(1, 5_000_000_000_000, 12_000, 200_000, 5, 100_000_000, 1_000_000);
}

#[test(should_fail)]
fn invalid_margin() {
    main(1, 5_000_000_000_000, 9_000, 200_000, 5, 100_000_000, 1_000_000);
}

#[test(should_fail)]
fn invalid_max_leverage() {
    main(1, 5_000_000_000_000, 9_000, 50_000, 5, 100_000_000, 1_000_000);
}
