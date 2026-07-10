global RATE_SCALE: u128 = 1_000_000;

fn funding_delta(
    mark_price: u128,
    premium_rate_abs: u128,
    elapsed_ms: u128,
    interval_ms: u128,
    max_delta: u128,
    max_delta_enabled: u128,
) -> u128 {
    assert(mark_price > 0);
    assert(interval_ms > 0);
    if max_delta_enabled != 0 {
        assert(max_delta_enabled == 1);
    }

    let raw = (mark_price * premium_rate_abs * elapsed_ms) / (RATE_SCALE * interval_ms);
    if max_delta_enabled == 1 {
        if raw > max_delta {
            max_delta
        } else {
            raw
        }
    } else {
        raw
    }
}

fn assert_normalized(abs_value: u128, is_negative: bool) {
    if abs_value == 0 {
        assert(!is_negative);
    }
}

fn assert_signed_add(
    old_abs: u128,
    old_is_negative: bool,
    delta_abs: u128,
    delta_is_negative: bool,
    new_abs: u128,
    new_is_negative: bool,
) {
    assert_normalized(old_abs, old_is_negative);
    assert_normalized(new_abs, new_is_negative);

    if old_is_negative == delta_is_negative {
        assert(new_abs == old_abs + delta_abs);
        if new_abs == 0 {
            assert(!new_is_negative);
        } else {
            assert(new_is_negative == old_is_negative);
        }
    } else {
        if old_abs >= delta_abs {
            assert(new_abs == old_abs - delta_abs);
            if new_abs == 0 {
                assert(!new_is_negative);
            } else {
                assert(new_is_negative == old_is_negative);
            }
        } else {
            assert(new_abs == delta_abs - old_abs);
            assert(new_is_negative == delta_is_negative);
        }
    }
}

fn main(
    market_id: pub Field,
    old_index_abs: pub u128,
    old_index_is_negative: pub bool,
    new_index_abs: pub u128,
    new_index_is_negative: pub bool,
    mark_price: pub u128,
    premium_rate_abs: pub u128,
    premium_rate_is_negative: pub bool,
    elapsed_ms: pub u128,
    interval_ms: pub u128,
    max_delta: pub u128,
    max_delta_enabled: pub u128,
) {
    assert(market_id != 0);
    let delta = funding_delta(
        mark_price,
        premium_rate_abs,
        elapsed_ms,
        interval_ms,
        max_delta,
        max_delta_enabled,
    );
    assert(delta > 0);
    assert_signed_add(
        old_index_abs,
        old_index_is_negative,
        delta,
        premium_rate_is_negative,
        new_index_abs,
        new_index_is_negative,
    );
}

#[test]
fn valid_funding_update() {
    main(9, 1_000, false, 50_000_001_000, false, 50_000_00000000, 10_000, false, 3_600_000, 3_600_000, 0, 0);
}

#[test]
fn valid_negative_funding_update() {
    main(9, 50_000_001_000, false, 1_000, false, 50_000_00000000, 10_000, true, 3_600_000, 3_600_000, 0, 0);
}

#[test]
fn crosses_zero_with_negative_funding_update() {
    main(9, 100, false, 49_999_999_900, true, 50_000_00000000, 10_000, true, 3_600_000, 3_600_000, 0, 0);
}

#[test]
fn caps_funding_delta() {
    main(9, 1_000, false, 1_050, false, 50_000_00000000, 10_000, false, 3_600_000, 3_600_000, 50, 1);
}

#[test(should_fail)]
fn rejects_bad_delta() {
    main(9, 1_000, false, 50_000_000_999, false, 50_000_00000000, 10_000, false, 3_600_000, 3_600_000, 0, 0);
}

#[test(should_fail)]
fn rejects_bad_cap_flag() {
    main(9, 1_000, false, 50_000_001_000, false, 50_000_00000000, 10_000, false, 3_600_000, 3_600_000, 0, 2);
}

#[test(should_fail)]
fn rejects_non_normalized_negative_zero() {
    main(9, 0, true, 50_000_000_000, false, 50_000_00000000, 10_000, false, 3_600_000, 3_600_000, 0, 0);
}
