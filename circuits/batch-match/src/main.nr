global MAX_EXECUTIONS: u32 = 4;
global MAX_PUBLIC_ITEMS: u32 = 8;

fn notional(size: u128, price: u128, price_scale: u128) -> u128 {
    (size * price) / price_scale
}

fn initial_margin(size: u128, price: u128, initial_margin_rate: u128, price_scale: u128, rate_scale: u128) -> u128 {
    (notional(size, price, price_scale) * initial_margin_rate) / rate_scale
}

fn assert_execution(
    fill_size: u128,
    execution_price: u128,
    long_limit_price: u128,
    short_limit_price: u128,
    maker_is_long: bool,
    long_margin: u128,
    short_margin: u128,
    initial_margin_rate: u128,
    max_leverage: u128,
    price_scale: u128,
    rate_scale: u128,
) {
    assert(fill_size > 0);
    assert(execution_price > 0);
    assert(long_limit_price >= short_limit_price);
    if maker_is_long {
        assert(execution_price == long_limit_price);
    } else {
        assert(execution_price == short_limit_price);
    }

    let trade_notional = notional(fill_size, execution_price, price_scale);
    let required_initial_margin = initial_margin(fill_size, execution_price, initial_margin_rate, price_scale, rate_scale);
    assert(long_margin >= required_initial_margin);
    assert(short_margin >= required_initial_margin);
    assert(trade_notional <= long_margin * max_leverage);
    assert(trade_notional <= short_margin * max_leverage);
}

fn assert_padding(
    fill_size: u128,
    execution_price: u128,
    long_limit_price: u128,
    short_limit_price: u128,
    long_margin: u128,
    short_margin: u128,
) {
    assert(fill_size == 0);
    assert(execution_price == 0);
    assert(long_limit_price == 0);
    assert(short_limit_price == 0);
    assert(long_margin == 0);
    assert(short_margin == 0);
}

fn assert_public_items(count: u128, items: [Field; 8], require_non_empty: bool) {
    assert(count <= MAX_PUBLIC_ITEMS as u128);
    if require_non_empty {
        assert(count > 0);
    }

    for i in 0..MAX_PUBLIC_ITEMS {
        let index = i as u32;
        if (i as u128) < count {
            assert(items[index] != 0);
        } else {
            assert(items[index] == 0);
        }
    }
}

fn assert_execution_identity(
    long_intent: Field,
    short_intent: Field,
    long_nullifier: Field,
    short_nullifier: Field,
    long_position_commitment: Field,
    short_position_commitment: Field,
) {
    assert(long_intent != 0);
    assert(short_intent != 0);
    assert(long_intent != short_intent);
    assert(long_nullifier != 0);
    assert(short_nullifier != 0);
    assert(long_nullifier != short_nullifier);
    assert(long_position_commitment != 0);
    assert(short_position_commitment != 0);
    assert(long_position_commitment != short_position_commitment);
}

fn assert_identity_padding(
    long_intent: Field,
    short_intent: Field,
    long_nullifier: Field,
    short_nullifier: Field,
    long_position_commitment: Field,
    short_position_commitment: Field,
) {
    assert(long_intent == 0);
    assert(short_intent == 0);
    assert(long_nullifier == 0);
    assert(short_nullifier == 0);
    assert(long_position_commitment == 0);
    assert(short_position_commitment == 0);
}

fn contains_execution_item(
    item: Field,
    execution_count: u128,
    long_items: [Field; 4],
    short_items: [Field; 4],
) -> bool {
    let mut found = false;
    for i in 0..MAX_EXECUTIONS {
        let index = i as u32;
        if (i as u128) < execution_count {
            if item == long_items[index] {
                found = true;
            }
            if item == short_items[index] {
                found = true;
            }
        }
    }
    found
}

fn contains_public_item(item: Field, count: u128, items: [Field; 8]) -> bool {
    let mut found = false;
    for i in 0..MAX_PUBLIC_ITEMS {
        let index = i as u32;
        if (i as u128) < count {
            if item == items[index] {
                found = true;
            }
        }
    }
    found
}

fn assert_public_set_matches_executions(
    count: u128,
    public_items: [Field; 8],
    execution_count: u128,
    long_items: [Field; 4],
    short_items: [Field; 4],
) {
    for i in 0..MAX_PUBLIC_ITEMS {
        let index = i as u32;
        if (i as u128) < count {
            assert(contains_execution_item(public_items[index], execution_count, long_items, short_items));
        }
    }

    for i in 0..MAX_EXECUTIONS {
        let index = i as u32;
        if (i as u128) < execution_count {
            assert(contains_public_item(long_items[index], count, public_items));
            assert(contains_public_item(short_items[index], count, public_items));
        }
    }
}

fn assert_position_commitment_bindings(
    execution_count: u128,
    new_commitment_count: u128,
    new_commitments: [Field; 8],
    long_position_commitments: [Field; 4],
    short_position_commitments: [Field; 4],
) {
    assert(new_commitment_count == execution_count * 2);
    for i in 0..MAX_EXECUTIONS {
        let execution_index = i as u32;
        let long_commitment_index = (i * 2) as u32;
        let short_commitment_index = (i * 2 + 1) as u32;
        if (i as u128) < execution_count {
            assert(new_commitments[long_commitment_index] == long_position_commitments[execution_index]);
            assert(new_commitments[short_commitment_index] == short_position_commitments[execution_index]);
        }
    }
}

fn main(
    execution_count: u128,
    execution_sizes: [u128; 4],
    execution_prices: [u128; 4],
    long_limit_prices: [u128; 4],
    short_limit_prices: [u128; 4],
    maker_is_long: [bool; 4],
    long_margins: [u128; 4],
    short_margins: [u128; 4],
    long_intents: [Field; 4],
    short_intents: [Field; 4],
    long_nullifiers: [Field; 4],
    short_nullifiers: [Field; 4],
    long_position_commitments: [Field; 4],
    short_position_commitments: [Field; 4],
    total_long_size: u128,
    total_short_size: u128,
    initial_margin_rate: u128,
    max_leverage: u128,
    price_scale: u128,
    rate_scale: u128,
    batch_id: pub Field,
    market_id: pub Field,
    old_root: pub Field,
    new_root: pub Field,
    settlement_digest: pub Field,
    filled_intent_count: pub u128,
    filled_intents: pub [Field; 8],
    new_commitment_count: pub u128,
    new_commitments: pub [Field; 8],
    margin_change_count: pub u128,
    margin_change_commitments: pub [Field; 8],
    spent_nullifier_count: pub u128,
    spent_nullifiers: pub [Field; 8],
    residual_size: pub u128,
    aggregate_volume: pub u128,
) {
    assert(batch_id != 0);
    assert(market_id != 0);
    assert(old_root != 0);
    assert(new_root != 0);
    assert(new_root != old_root);
    assert(settlement_digest != 0);
    assert(execution_count > 0);
    assert(execution_count <= MAX_EXECUTIONS as u128);
    assert(total_long_size > 0);
    assert(total_short_size > 0);
    assert(initial_margin_rate > 0);
    assert(max_leverage > 0);
    assert(price_scale > 0);
    assert(rate_scale > 0);
    assert_public_items(filled_intent_count, filled_intents, true);
    assert_public_items(new_commitment_count, new_commitments, true);
    assert_public_items(margin_change_count, margin_change_commitments, false);
    assert_public_items(spent_nullifier_count, spent_nullifiers, true);
    assert_public_set_matches_executions(filled_intent_count, filled_intents, execution_count, long_intents, short_intents);
    assert_public_set_matches_executions(spent_nullifier_count, spent_nullifiers, execution_count, long_nullifiers, short_nullifiers);
    assert_position_commitment_bindings(
        execution_count,
        new_commitment_count,
        new_commitments,
        long_position_commitments,
        short_position_commitments,
    );

    let mut filled_size = 0;
    for i in 0..MAX_EXECUTIONS {
        let index = i as u32;
        if (i as u128) < execution_count {
            assert_execution_identity(
                long_intents[index],
                short_intents[index],
                long_nullifiers[index],
                short_nullifiers[index],
                long_position_commitments[index],
                short_position_commitments[index],
            );
            assert_execution(
                execution_sizes[index],
                execution_prices[index],
                long_limit_prices[index],
                short_limit_prices[index],
                maker_is_long[index],
                long_margins[index],
                short_margins[index],
                initial_margin_rate,
                max_leverage,
                price_scale,
                rate_scale,
            );
            filled_size = filled_size + execution_sizes[index];
        } else {
            assert_padding(
                execution_sizes[index],
                execution_prices[index],
                long_limit_prices[index],
                short_limit_prices[index],
                long_margins[index],
                short_margins[index],
            );
            assert_identity_padding(
                long_intents[index],
                short_intents[index],
                long_nullifiers[index],
                short_nullifiers[index],
                long_position_commitments[index],
                short_position_commitments[index],
            );
        }
    }

    assert(aggregate_volume == filled_size * 2);
    assert(filled_size <= total_long_size);
    assert(filled_size <= total_short_size);
    if total_long_size >= total_short_size {
        assert(residual_size == total_long_size - total_short_size);
    } else {
        assert(residual_size == total_short_size - total_long_size);
    }
}

#[test]
fn valid_crossed_batch() {
    main(
        1,
        [1, 0, 0, 0],
        [51_000_000_000_00, 0, 0, 0],
        [51_000_000_000_00, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [true, false, false, false],
        [12_000, 0, 0, 0],
        [12_000, 0, 0, 0],
        [21, 0, 0, 0],
        [22, 0, 0, 0],
        [41, 0, 0, 0],
        [42, 0, 0, 0],
        [31, 0, 0, 0],
        [32, 0, 0, 0],
        1,
        1,
        200_000,
        5,
        100_000_000,
        1_000_000,
        10,
        11,
        12,
        13,
        1,
        2,
        [21, 22, 0, 0, 0, 0, 0, 0],
        2,
        [31, 32, 0, 0, 0, 0, 0, 0],
        0,
        [0, 0, 0, 0, 0, 0, 0, 0],
        2,
        [41, 42, 0, 0, 0, 0, 0, 0],
        0,
        2,
    );
}

#[test]
fn valid_partial_residual() {
    main(
        1,
        [1, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [52_000_000_000_00, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [false, false, false, false],
        [12_000, 0, 0, 0],
        [12_000, 0, 0, 0],
        [21, 0, 0, 0],
        [22, 0, 0, 0],
        [41, 0, 0, 0],
        [42, 0, 0, 0],
        [31, 0, 0, 0],
        [32, 0, 0, 0],
        2,
        1,
        200_000,
        5,
        100_000_000,
        1_000_000,
        10,
        11,
        12,
        13,
        1,
        2,
        [21, 22, 0, 0, 0, 0, 0, 0],
        2,
        [31, 32, 0, 0, 0, 0, 0, 0],
        1,
        [33, 0, 0, 0, 0, 0, 0, 0],
        2,
        [41, 42, 0, 0, 0, 0, 0, 0],
        1,
        2,
    );
}

#[test(should_fail)]
fn rejects_non_crossing_batch() {
    main(
        1,
        [1, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [51_000_000_000_00, 0, 0, 0],
        [true, false, false, false],
        [12_000, 0, 0, 0],
        [12_000, 0, 0, 0],
        [21, 0, 0, 0],
        [22, 0, 0, 0],
        [41, 0, 0, 0],
        [42, 0, 0, 0],
        [31, 0, 0, 0],
        [32, 0, 0, 0],
        1,
        1,
        200_000,
        5,
        100_000_000,
        1_000_000,
        10,
        11,
        12,
        13,
        1,
        2,
        [21, 22, 0, 0, 0, 0, 0, 0],
        2,
        [31, 32, 0, 0, 0, 0, 0, 0],
        0,
        [0, 0, 0, 0, 0, 0, 0, 0],
        2,
        [41, 42, 0, 0, 0, 0, 0, 0],
        0,
        2,
    );
}

#[test(should_fail)]
fn rejects_wrong_maker_price() {
    main(
        1,
        [1, 0, 0, 0],
        [50_000_000_000_00, 0, 0, 0],
        [51_000_000_000_00, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [false, false, false, false],
        [12_000, 0, 0, 0],
        [12_000, 0, 0, 0],
        [21, 0, 0, 0],
        [22, 0, 0, 0],
        [41, 0, 0, 0],
        [42, 0, 0, 0],
        [31, 0, 0, 0],
        [32, 0, 0, 0],
        1,
        1,
        200_000,
        5,
        100_000_000,
        1_000_000,
        10,
        11,
        12,
        13,
        1,
        2,
        [21, 22, 0, 0, 0, 0, 0, 0],
        2,
        [31, 32, 0, 0, 0, 0, 0, 0],
        0,
        [0, 0, 0, 0, 0, 0, 0, 0],
        2,
        [41, 42, 0, 0, 0, 0, 0, 0],
        0,
        2,
    );
}

#[test(should_fail)]
fn rejects_insufficient_margin() {
    main(
        1,
        [1, 0, 0, 0],
        [50_000_000_000_00, 0, 0, 0],
        [51_000_000_000_00, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [true, false, false, false],
        [9_000, 0, 0, 0],
        [12_000, 0, 0, 0],
        [21, 0, 0, 0],
        [22, 0, 0, 0],
        [41, 0, 0, 0],
        [42, 0, 0, 0],
        [31, 0, 0, 0],
        [32, 0, 0, 0],
        1,
        1,
        200_000,
        5,
        100_000_000,
        1_000_000,
        10,
        11,
        12,
        13,
        1,
        2,
        [21, 22, 0, 0, 0, 0, 0, 0],
        2,
        [31, 32, 0, 0, 0, 0, 0, 0],
        0,
        [0, 0, 0, 0, 0, 0, 0, 0],
        2,
        [41, 42, 0, 0, 0, 0, 0, 0],
        0,
        2,
    );
}

#[test(should_fail)]
fn rejects_wrong_residual() {
    main(
        1,
        [1, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [52_000_000_000_00, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [false, false, false, false],
        [12_000, 0, 0, 0],
        [12_000, 0, 0, 0],
        [21, 0, 0, 0],
        [22, 0, 0, 0],
        [41, 0, 0, 0],
        [42, 0, 0, 0],
        [31, 0, 0, 0],
        [32, 0, 0, 0],
        2,
        1,
        200_000,
        5,
        100_000_000,
        1_000_000,
        10,
        11,
        12,
        13,
        1,
        2,
        [21, 22, 0, 0, 0, 0, 0, 0],
        2,
        [31, 32, 0, 0, 0, 0, 0, 0],
        1,
        [33, 0, 0, 0, 0, 0, 0, 0],
        2,
        [41, 42, 0, 0, 0, 0, 0, 0],
        0,
        2,
    );
}

#[test(should_fail)]
fn rejects_unbound_public_commitment() {
    main(
        1,
        [1, 0, 0, 0],
        [51_000_000_000_00, 0, 0, 0],
        [51_000_000_000_00, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [true, false, false, false],
        [12_000, 0, 0, 0],
        [12_000, 0, 0, 0],
        [21, 0, 0, 0],
        [22, 0, 0, 0],
        [41, 0, 0, 0],
        [42, 0, 0, 0],
        [31, 0, 0, 0],
        [32, 0, 0, 0],
        1,
        1,
        200_000,
        5,
        100_000_000,
        1_000_000,
        10,
        11,
        12,
        13,
        1,
        2,
        [21, 22, 0, 0, 0, 0, 0, 0],
        2,
        [31, 99, 0, 0, 0, 0, 0, 0],
        0,
        [0, 0, 0, 0, 0, 0, 0, 0],
        2,
        [41, 42, 0, 0, 0, 0, 0, 0],
        0,
        2,
    );
}

#[test(should_fail)]
fn rejects_unbound_spent_nullifier() {
    main(
        1,
        [1, 0, 0, 0],
        [51_000_000_000_00, 0, 0, 0],
        [51_000_000_000_00, 0, 0, 0],
        [49_000_000_000_00, 0, 0, 0],
        [true, false, false, false],
        [12_000, 0, 0, 0],
        [12_000, 0, 0, 0],
        [21, 0, 0, 0],
        [22, 0, 0, 0],
        [41, 0, 0, 0],
        [42, 0, 0, 0],
        [31, 0, 0, 0],
        [32, 0, 0, 0],
        1,
        1,
        200_000,
        5,
        100_000_000,
        1_000_000,
        10,
        11,
        12,
        13,
        1,
        2,
        [21, 22, 0, 0, 0, 0, 0, 0],
        2,
        [31, 32, 0, 0, 0, 0, 0, 0],
        0,
        [0, 0, 0, 0, 0, 0, 0, 0],
        2,
        [41, 99, 0, 0, 0, 0, 0, 0],
        0,
        2,
    );
}
