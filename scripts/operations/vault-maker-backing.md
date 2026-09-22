# Vault-backed maker notes (Testnet)

The configured maker wallet does not make a note match-eligible by itself. The API selects only available notes linked to an outstanding allocation from the configured vault. Existing notes retain their recorded status and are excluded until separately recovered; do not relabel them as spent.

1. Deposit USDC into the existing vault while it is unpaused, then pause it. Confirm the vault reports the intended shares and liquid assets.
2. Run `bun run maker:allocate-vault --amount <base-units> --operator-source <operator-cli-alias>`. This invokes the vault's `allocate`, checks the exact principal, liquid-asset, and maker-balance deltas, then records the transaction in `vault_maker_allocations`.
3. Use `smoke:custody` with the maker CLI alias as `--source` and the maker address as `--from` to deposit some or all of that allocation into the shielded pool. Record the new note commitment and deposit transaction hash.
4. Run `bun run maker:register-vault-note --allocation-tx <hash> --commitment <commitment>`. Registration requires the recorded allocation, a later confirmed deposit transaction, the live vault principal, and an unspent pool commitment. Total registered root-note amounts cannot exceed the allocation.
5. After trades, recover the maker's remaining notes and settle the vault through its existing operator flow. When deployed principal is zero and no linked note remains available, locked, or withdrawing, run `bun run maker:close-vault-allocation --allocation-tx <hash>`.

If the allocation command prints `submitted` but not `recorded`, the on-chain transfer may have completed while database recording failed. Do not run the allocation command again with the same amount. Keep matching closed for that allocation and reconcile the printed transaction hash and balances before recording or settling it. If the default Stellar RPC no longer retains a transaction, registration fails closed.
