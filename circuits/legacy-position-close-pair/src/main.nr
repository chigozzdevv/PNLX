global POSITION_DOMAIN: Field = 0x504e4c58504f534954494f4e;
global SECURE_MARGIN_DOMAIN: Field = 0x504e4c5844524f504d4152;
global PRICE_SCALE: u128 = 100_000_000;
global RATE_SCALE: u128 = 1_000_000;
global MAX_SIGNED_ABS: u128 = 170141183460469231731687303715884105727;

fn hash_pair(left: Field, right: Field) -> Field {
    std::hash::poseidon2_permutation([left, right, 0, 36893488147419103232], 4)[0]
}

fn signed_index(abs_value: u128, is_negative: bool) -> Field {
    assert(abs_value <= MAX_SIGNED_ABS);
    if abs_value == 0 { assert(!is_negative); }
    if is_negative { -(abs_value as Field) } else { abs_value as Field }
}

fn funding_payment(is_long: bool, size: u128, old_abs: u128, old_negative: bool,
    current_abs: u128, current_negative: bool) -> (u128, bool) {
    let _old = signed_index(old_abs, old_negative);
    let _current = signed_index(current_abs, current_negative);
    let increased = if old_negative != current_negative {
        old_negative
    } else if old_negative {
        old_abs >= current_abs
    } else { current_abs >= old_abs };
    let delta = if old_negative != current_negative { old_abs + current_abs }
        else if old_abs >= current_abs { old_abs - current_abs }
        else { current_abs - old_abs };
    let amount = (size * delta) / PRICE_SCALE;
    (amount, (amount != 0) & (is_long != increased))
}

fn position_commitment(is_long: bool, size: u128, entry_price: u128, margin: u128,
    funding_index: Field, market_digest: Field, owner_digest: Field, rho: Field,
    blinding: Field, spend_secret_digest: Field) -> Field {
    let side = if is_long { 1 as Field } else { 2 as Field };
    let left = hash_pair(hash_pair(market_digest, side), hash_pair(size as Field, entry_price as Field));
    let right = hash_pair(hash_pair(margin as Field, funding_index), hash_pair(owner_digest, hash_pair(rho, blinding)));
    hash_pair(POSITION_DOMAIN, hash_pair(left, hash_pair(right, spend_secret_digest)))
}

fn legacy_position_commitment(is_long: bool, size: u128, entry_price: u128, margin: u128,
    funding_index: Field, market_digest: Field, owner_digest: Field, rho: Field, blinding: Field) -> Field {
    let side = if is_long { 1 as Field } else { 2 as Field };
    let left = hash_pair(hash_pair(market_digest, side), hash_pair(size as Field, entry_price as Field));
    let right = hash_pair(hash_pair(margin as Field, funding_index), hash_pair(owner_digest, hash_pair(rho, blinding)));
    hash_pair(left, right)
}

fn note_commitment(asset: Field, amount: u128, owner: Field, rho: Field,
    blinding: Field, spend_secret_digest: Field) -> Field {
    hash_pair(SECURE_MARGIN_DOMAIN, hash_pair(hash_pair(asset, amount as Field),
        hash_pair(owner, hash_pair(hash_pair(rho, blinding), spend_secret_digest))))
}

fn merkle_root(leaf: Field, siblings: [Field; 20], indices: [bool; 20]) -> Field {
    let mut node = leaf;
    for i in 0..20 { node = if indices[i] { hash_pair(siblings[i], node) } else { hash_pair(node, siblings[i]) }; }
    node
}

fn empty_siblings() -> [Field; 20] {
    let mut siblings = [0; 20];
    let mut node: Field = 0;
    for i in 0..20 { siblings[i] = node; node = hash_pair(node, node); }
    siblings
}

fn pnl(is_long: bool, size: u128, entry: u128, mark: u128) -> (u128, bool) {
    let profit = if is_long { mark >= entry } else { entry >= mark };
    let delta = if mark >= entry { mark - entry } else { entry - mark };
    (size * delta / PRICE_SCALE, profit)
}

fn equity_parts(is_long: bool, size: u128, entry: u128, mark: u128, margin: u128,
    old_abs: u128, old_negative: bool, current_abs: u128, current_negative: bool) -> (u128, u128) {
    let (pnl_amount, profit) = pnl(is_long, size, entry, mark);
    let (funding_amount, credit) = funding_payment(is_long, size, old_abs, old_negative, current_abs, current_negative);
    let credits = margin + (if profit { pnl_amount } else { 0 }) + (if credit { funding_amount } else { 0 });
    let debits = (if profit { 0 } else { pnl_amount }) + (if credit { 0 } else { funding_amount });
    (credits, debits)
}

fn capped_equity(credits: u128, debits: u128, collateral: u128) -> u128 {
    let equity = if credits > debits { credits - debits } else { 0 };
    if equity > collateral { collateral } else { equity }
}

fn main(
    market_digest: pub Field, asset_digest: pub Field, mark_price: pub u128,
    current_funding_index_abs: pub u128, current_funding_index_is_negative: pub bool,
    maintenance_rate: pub u128, liquidation: pub bool, position_root: pub Field,
    position_commitments: pub [Field; 2], position_nullifiers: pub [Field; 2],
    close_commitments: pub [Field; 2], new_position_commitments: pub [Field; 2],
    margin_output_commitments: pub [Field; 2],
    legacy_market_digest: Field, is_long: [bool; 2], size: u128, entry_price: u128, funding_index: Field,
    funding_index_abs: u128, funding_index_is_negative: bool,
    margins: [u128; 2], owner_digests: [Field; 2], rhos: [Field; 2],
    blindings: [Field; 2], spend_secret_digests: [Field; 2], output_amounts: [u128; 2],
    new_position_rhos: [Field; 2], new_position_blindings: [Field; 2],
    output_rhos: [Field; 2], output_blindings: [Field; 2], output_spend_secrets: [Field; 2],
    path_siblings: [[Field; 20]; 2], path_indices: [[bool; 20]; 2],
) {
    assert(market_digest != 0);
    assert(legacy_market_digest != 0);
    assert(asset_digest != 0);
    assert(position_root != 0);
    assert(mark_price > 0);
    assert(entry_price > 0);
    assert(size > 0);
    assert(maintenance_rate > 0);
    assert(maintenance_rate <= RATE_SCALE);
    assert(is_long[0] != is_long[1]);
    assert(position_commitments[0] != position_commitments[1]);
    assert(position_nullifiers[0] != position_nullifiers[1]);
    assert(close_commitments[0] != close_commitments[1]);
    assert(new_position_commitments[0] != new_position_commitments[1]);
    assert(margin_output_commitments[0] != margin_output_commitments[1]);
    assert(funding_index == signed_index(funding_index_abs, funding_index_is_negative));
    let collateral = margins[0] + margins[1];
    let maintenance = ((size * mark_price) / PRICE_SCALE) * maintenance_rate / RATE_SCALE;
    let mut distressed = false;
    for i in 0..2 {
        assert(owner_digests[i] != 0);
        assert(rhos[i] != 0);
        assert(blindings[i] != 0);
        assert(spend_secret_digests[i] != 0);
        assert(close_commitments[i] != 0);
        assert(new_position_rhos[i] != 0);
        assert(new_position_blindings[i] != 0);
        assert(output_rhos[i] != 0);
        assert(output_blindings[i] != 0);
        assert(output_spend_secrets[i] != 0);
        let position = legacy_position_commitment(is_long[i], size, entry_price, margins[i], funding_index,
            legacy_market_digest, owner_digests[i], rhos[i], blindings[i]);
        assert(position == position_commitments[i]);
        assert(merkle_root(position, path_siblings[i], path_indices[i]) == position_root);
        assert(hash_pair(spend_secret_digests[i], rhos[i]) == position_nullifiers[i]);
        let (credits, debits) = equity_parts(is_long[i], size, entry_price, mark_price, margins[i],
            funding_index_abs, funding_index_is_negative, current_funding_index_abs,
            current_funding_index_is_negative);
        let equity = if credits > debits { credits - debits } else { 0 };
        distressed = distressed | (credits <= debits) | (equity < maintenance);
        assert(output_amounts[i] == capped_equity(credits, debits, collateral));
        assert(position_commitment(is_long[i], 0, entry_price, 0, funding_index,
            market_digest, owner_digests[i], new_position_rhos[i], new_position_blindings[i],
            spend_secret_digests[i]) == new_position_commitments[i]);
        assert(note_commitment(asset_digest, output_amounts[i], owner_digests[i],
            output_rhos[i], output_blindings[i], output_spend_secrets[i]) == margin_output_commitments[i]);
    }
    assert(output_amounts[0] + output_amounts[1] == collateral);
    if liquidation { assert(distressed); }
}

fn exercise(mark: u128, current_abs: u128, current_negative: bool, liquidation: bool,
    secret: Field, forged_output: bool, wrong_market: bool, same_side: bool, wrong_legacy_market: bool) {
    let margins: [u128; 2] = [20, 20];
    let sides = [true, same_side];
    let size = 100_000_000;
    let entry = 100;
    let p0 = legacy_position_commitment(true, size, entry, 20, 0, 22, 3, 4, 5);
    let p1 = legacy_position_commitment(false, size, entry, 20, 0, 22, 13, 14, 15);
    let mut siblings0 = empty_siblings();
    let mut siblings1 = empty_siblings();
    siblings0[0] = p1;
    siblings1[0] = p0;
    let indices0 = [false; 20];
    let mut indices1 = [false; 20]; indices1[0] = true;
    let root = merkle_root(p0, siblings0, indices0);
    let (c0, d0) = equity_parts(true, size, entry, mark, 20, 0, false, current_abs, current_negative);
    let (c1, d1) = equity_parts(false, size, entry, mark, 20, 0, false, current_abs, current_negative);
    let a0 = capped_equity(c0, d0, 40) + (if forged_output { 1 } else { 0 });
    let a1 = capped_equity(c1, d1, 40);
    main(if wrong_market { 99 } else { 2 }, 9, mark, current_abs, current_negative, 100_000,
        liquidation, root, [p0,p1], [hash_pair(6,4),hash_pair(16,14)], [23,24],
        [position_commitment(true,0,entry,0,0,2,3,7,8,secret),
            position_commitment(false,0,entry,0,0,2,13,17,18,16)],
        [note_commitment(9,a0,3,10,11,12),note_commitment(9,a1,13,20,21,22)],
        if wrong_legacy_market { 99 } else { 22 },sides,size,entry,0,0,false,margins,[3,13],[4,14],[5,15],[secret,16],[a0,a1],
        [7,17],[8,18],[10,20],[11,21],[12,22],[siblings0,siblings1],[indices0,indices1]);
}

#[test]
fn balanced_close() { exercise(110,0,false,false,6,false,false,false,false); }
#[test]
fn balanced_funding_close() { exercise(100,3,false,false,6,false,false,false,false); }
#[test]
fn negative_funding_close() { exercise(100,3,true,false,6,false,false,false,false); }
#[test]
fn gap_caps_winner_to_paired_capital() { exercise(150,0,false,true,6,false,false,false,false); }
#[test]
fn negative_equity_closes_both_sides() { exercise(1,0,false,true,6,false,false,false,false); }
#[test(should_fail)]
fn rejects_unbacked_output() { exercise(110,0,false,false,6,true,false,false,false); }
#[test(should_fail)]
fn rejects_wrong_authority() { exercise(110,0,false,false,99,false,false,false,false); }
#[test(should_fail)]
fn rejects_wrong_market() { exercise(110,0,false,false,6,false,true,false,false); }
#[test(should_fail)]
fn rejects_two_same_side_positions() { exercise(110,0,false,false,6,false,false,true,false); }
#[test(should_fail)]
fn rejects_healthy_liquidation() { exercise(100,0,false,true,6,false,false,false,false); }

#[test(should_fail)]
fn rejects_wrong_legacy_market() { exercise(110,0,false,false,6,false,false,false,true); }
