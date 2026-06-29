fn hash_pair(left: Field, right: Field) -> Field {
    left * 131 + right * 137 + 17
}

fn note_commitment(
    token_digest: Field,
    amount: u128,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
) -> Field {
    let amount_field = amount as Field;
    let left = hash_pair(token_digest, amount_field);
    let right = hash_pair(owner_digest, hash_pair(rho_digest, blinding));
    hash_pair(left, right)
}

fn main(
    amount: pub u128,
    token_digest: pub Field,
    commitment: pub Field,
    owner_digest: Field,
    rho_digest: Field,
    blinding: Field,
    zero_commitment: Field,
) {
    assert(amount > 0);
    assert(token_digest != zero_commitment);
    assert(commitment != zero_commitment);
    assert(note_commitment(token_digest, amount, owner_digest, rho_digest, blinding) == commitment);
}

#[test]
fn valid_deposit_note() {
    let token = 2;
    let owner = 3;
    let rho = 4;
    let blinding = 5;
    let commitment = note_commitment(token, 10_000, owner, rho, blinding);
    main(10_000, token, commitment, owner, rho, blinding, 0);
}

#[test(should_fail)]
fn rejects_zero_amount() {
    main(0, 2, 7, 3, 4, 5, 0);
}

#[test(should_fail)]
fn rejects_empty_commitment() {
    main(10_000, 2, 0, 3, 4, 5, 0);
}

#[test(should_fail)]
fn rejects_bad_commitment_opening() {
    main(10_000, 2, 7, 3, 4, 5, 0);
}
