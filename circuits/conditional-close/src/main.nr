fn hash_pair(left: Field, right: Field) -> Field {
    left * 131 + right * 137 + 17
}

fn conditional_commitment(
    market_digest: Field,
    position_nullifier: Field,
    is_long: bool,
    is_take_profit: bool,
    trigger_price: u128,
    size: u128,
    reduce_only: bool,
    salt_digest: Field,
) -> Field {
    let side = if is_long { 1 } else { 2 };
    let kind = if is_take_profit { 1 } else { 2 };
    let reduce = if reduce_only { 1 } else { 0 };
    let scope = hash_pair(
        hash_pair(market_digest, position_nullifier),
        hash_pair(side, kind),
    );
    let trigger = hash_pair(
        hash_pair(trigger_price as Field, size as Field),
        hash_pair(reduce, salt_digest),
    );
    hash_pair(scope, trigger)
}

fn main(
    is_long: bool,
    is_take_profit: bool,
    reduce_only: bool,
    market_digest: Field,
    trigger_price: u128,
    mark_price: pub u128,
    size: u128,
    position_nullifier: pub Field,
    close_commitment: pub Field,
    salt_digest: Field,
    zero_value: Field,
) {
    assert(reduce_only);
    assert(market_digest != zero_value);
    assert(trigger_price > 0);
    assert(mark_price > 0);
    assert(size > 0);
    assert(position_nullifier != zero_value);
    assert(close_commitment != zero_value);
    assert(salt_digest != zero_value);
    assert(conditional_commitment(
        market_digest,
        position_nullifier,
        is_long,
        is_take_profit,
        trigger_price,
        size,
        reduce_only,
        salt_digest,
    ) == close_commitment);

    if is_long {
        if is_take_profit {
            assert(mark_price >= trigger_price);
        } else {
            assert(mark_price <= trigger_price);
        }
    } else {
        if is_take_profit {
            assert(mark_price <= trigger_price);
        } else {
            assert(mark_price >= trigger_price);
        }
    }
}

#[test]
fn valid_long_take_profit() {
    let commitment = conditional_commitment(10, 12, true, true, 55_000_000_000, 1, true, 14);
    main(true, true, true, 10, 55_000_000_000, 56_000_000_000, 1, 12, commitment, 14, 0);
}

#[test]
fn valid_long_stop_loss() {
    let commitment = conditional_commitment(10, 12, true, false, 45_000_000_000, 1, true, 14);
    main(true, false, true, 10, 45_000_000_000, 44_000_000_000, 1, 12, commitment, 14, 0);
}

#[test]
fn valid_short_take_profit() {
    let commitment = conditional_commitment(10, 12, false, true, 45_000_000_000, 1, true, 14);
    main(false, true, true, 10, 45_000_000_000, 44_000_000_000, 1, 12, commitment, 14, 0);
}

#[test]
fn valid_short_stop_loss() {
    let commitment = conditional_commitment(10, 12, false, false, 55_000_000_000, 1, true, 14);
    main(false, false, true, 10, 55_000_000_000, 56_000_000_000, 1, 12, commitment, 14, 0);
}

#[test(should_fail)]
fn untriggered_long_take_profit() {
    let commitment = conditional_commitment(10, 12, true, true, 55_000_000_000, 1, true, 14);
    main(true, true, true, 10, 55_000_000_000, 54_000_000_000, 1, 12, commitment, 14, 0);
}

#[test(should_fail)]
fn not_reduce_only() {
    let commitment = conditional_commitment(10, 12, true, true, 55_000_000_000, 1, false, 14);
    main(true, true, false, 10, 55_000_000_000, 56_000_000_000, 1, 12, commitment, 14, 0);
}

#[test(should_fail)]
fn rejects_bad_close_commitment() {
    main(true, true, true, 10, 55_000_000_000, 56_000_000_000, 1, 12, 999, 14, 0);
}
