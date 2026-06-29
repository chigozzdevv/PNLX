fn main(
    old_margin: u128,
    added_margin: u128,
    fee: u128,
    new_margin: u128,
    old_commitment: pub Field,
    new_commitment: pub Field,
    zero_commitment: Field,
) {
    assert(old_commitment != zero_commitment);
    assert(new_commitment != zero_commitment);
    assert(new_commitment != old_commitment);
    assert(old_margin + added_margin >= fee);
    assert(new_margin == old_margin + added_margin - fee);
}

#[test]
fn valid_position_transition() {
    main(10_000, 2_000, 100, 11_900, 44, 45, 0);
}

#[test(should_fail)]
fn rejects_bad_margin_update() {
    main(10_000, 2_000, 100, 12_000, 44, 45, 0);
}

#[test(should_fail)]
fn rejects_same_commitment() {
    main(10_000, 2_000, 100, 11_900, 44, 44, 0);
}
