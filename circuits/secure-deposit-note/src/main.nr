global SECURE_MARGIN: Field = 0x504e4c5844524f504d4152;

fn hash_pair(left: Field, right: Field) -> Field {
    std::hash::poseidon2_permutation([left, right, 0, 36893488147419103232], 4)[0]
}

fn note_commitment(asset: Field, amount: u128, owner: Field, rho: Field, blinding: Field,
    spend_secret: Field) -> Field {
    hash_pair(SECURE_MARGIN, hash_pair(hash_pair(asset, amount as Field),
        hash_pair(owner, hash_pair(hash_pair(rho, blinding), spend_secret))))
}

fn main(
    amount: pub u128,
    token_digest: pub Field,
    commitment: pub Field,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
    spend_secret_digest: Field,
) {
    assert(amount > 0);
    assert(token_digest != 0);
    assert(commitment != 0);
    assert(owner_digest != 0);
    assert(rho_digest != 0);
    assert(blinding != 0);
    assert(spend_secret_digest != 0);
    assert(note_commitment(token_digest, amount, owner_digest, rho_digest, blinding,
        spend_secret_digest) == commitment);
}

#[test]
fn valid_secure_note() {
    main(10_000, 2, note_commitment(2, 10_000, 3, 4, 5, 6), 3, 4, 5, 6);
}

#[test(should_fail)]
fn rejects_rotated_secret() {
    main(10_000, 2, note_commitment(2, 10_000, 3, 4, 5, 6), 3, 4, 5, 7);
}
