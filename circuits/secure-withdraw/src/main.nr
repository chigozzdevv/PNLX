global SECURE_MARGIN: Field = 0x504e4c5844524f504d4152;
global SECURE_MARGIN_NULLIFIER: Field = 0x504e4c5844524f504d4e554c;

fn hash_pair(left: Field, right: Field) -> Field {
    std::hash::poseidon2_permutation([left, right, 0, 36893488147419103232], 4)[0]
}

fn note_commitment(asset: Field, amount: u128, owner: Field, rho: Field, blinding: Field,
    spend_secret: Field) -> Field {
    hash_pair(SECURE_MARGIN, hash_pair(hash_pair(asset, amount as Field),
        hash_pair(owner, hash_pair(hash_pair(rho, blinding), spend_secret))))
}

fn note_nullifier(spend_secret: Field, rho: Field) -> Field {
    hash_pair(SECURE_MARGIN_NULLIFIER, hash_pair(spend_secret, rho))
}

fn merkle_root(leaf: Field, siblings: [Field; 20], indices: [bool; 20]) -> Field {
    let mut node = leaf;
    for i in 0..20 {
        node = if indices[i] { hash_pair(siblings[i], node) } else { hash_pair(node, siblings[i]) };
    }
    node
}

fn main(
    note_amount: u128,
    withdraw_amount: pub u128,
    root: pub Field,
    nullifier: pub Field,
    token_digest: pub Field,
    recipient_digest: pub Field,
    change_commitment: pub Field,
    asset_digest: Field,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
    spend_secret_digest: Field,
    siblings: [Field; 20],
    indices: [bool; 20],
    change_rho_digest: Field,
    change_blinding: Field,
    change_spend_secret_digest: Field,
) {
    assert(note_amount > 0);
    assert(withdraw_amount > 0);
    assert(withdraw_amount <= note_amount);
    assert(root != 0);
    assert(nullifier != 0);
    assert(token_digest != 0);
    assert(recipient_digest != 0);
    assert(asset_digest == token_digest);
    assert(owner_digest != 0);
    assert(rho_digest != 0);
    assert(blinding != 0);
    assert(spend_secret_digest != 0);

    let note = note_commitment(asset_digest, note_amount, owner_digest, rho_digest,
        blinding, spend_secret_digest);
    assert(merkle_root(note, siblings, indices) == root);
    assert(note_nullifier(spend_secret_digest, rho_digest) == nullifier);

    let change = note_amount - withdraw_amount;
    if change == 0 {
        assert(change_commitment == 0);
    } else {
        assert(change_rho_digest != 0);
        assert(change_blinding != 0);
        assert(change_spend_secret_digest != 0);
        assert(change_commitment == note_commitment(asset_digest, change, owner_digest,
            change_rho_digest, change_blinding, change_spend_secret_digest));
    }
}

fn single_leaf_root() -> Field {
    let mut siblings = [0; 20];
    let mut empty = 0;
    for i in 0..20 {
        siblings[i] = empty;
        empty = hash_pair(empty, empty);
    }
    merkle_root(note_commitment(2, 10_000, 3, 4, 5, 6), siblings, [false; 20])
}

fn single_leaf_siblings() -> [Field; 20] {
    let mut siblings = [0; 20];
    let mut empty = 0;
    for i in 0..20 {
        siblings[i] = empty;
        empty = hash_pair(empty, empty);
    }
    siblings
}

#[test]
fn matches_typescript_note_hashes() {
    assert(note_commitment(2, 10_000, 3, 4, 5, 6) ==
        0x035f78347b7ba43d2a518a2aca73ccb7256d643d436b448cba8ea4ce0308e62b);
    assert(note_nullifier(6, 4) ==
        0x1e5b6784a0b506d867200787b035615801d32818756b0df4caf2263036ca6f82);
}

#[test]
fn valid_full_withdrawal() {
    main(10_000, 10_000, single_leaf_root(), note_nullifier(6, 4), 2, 9, 0,
        2, 3, 4, 5, 6, single_leaf_siblings(), [false; 20], 0, 0, 0);
}

#[test]
fn valid_withdrawal_with_change() {
    main(10_000, 4_000, single_leaf_root(), note_nullifier(6, 4), 2, 9,
        note_commitment(2, 6_000, 3, 7, 8, 10), 2, 3, 4, 5, 6,
        single_leaf_siblings(), [false; 20], 7, 8, 10);
}

#[test(should_fail)]
fn rejects_rotated_spend_secret_and_nullifier_for_same_note() {
    main(10_000, 10_000, single_leaf_root(), note_nullifier(7, 4), 2, 9, 0,
        2, 3, 4, 5, 7, single_leaf_siblings(), [false; 20], 0, 0, 0);
}
