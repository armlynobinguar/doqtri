#![no_std]
//! Doqtri FeeForwarder (progress/003).
//!
//! OpenZeppelin's `fee-forwarder-permissionless` example, unchanged in logic:
//! a user's smart wallet authorizes `forward`, which in one transaction moves
//! `fee_amount` (at most the `max_fee_amount` the user signed) of `fee_token`
//! from the wallet to `relayer`, then calls `target_contract.target_fn`. If
//! either step fails, both revert.
//!
//! "Permissionless" means any relayer may call it, but each call needs that
//! relayer's own authorization and pays the fee to it. Doqtri's server only
//! submits calls naming Doqtri's relayer account (app/api/chain/relay).
use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, Val, Vec};
use stellar_fee_abstraction::{collect_fee_and_invoke, FeeAbstractionApproval};

#[contract]
pub struct FeeForwarder;

#[contractimpl]
impl FeeForwarder {
    /// Requires authorization from both the user (over everything except the
    /// exact fee and relayer) and the relayer.
    #[allow(clippy::too_many_arguments)]
    pub fn forward(
        e: &Env,
        fee_token: Address,
        fee_amount: i128,
        max_fee_amount: i128,
        expiration_ledger: u32,
        target_contract: Address,
        target_fn: Symbol,
        target_args: Vec<Val>,
        user: Address,
        relayer: Address,
    ) -> Val {
        relayer.require_auth();

        collect_fee_and_invoke(
            e,
            &fee_token,
            fee_amount,
            max_fee_amount,
            expiration_ledger,
            &target_contract,
            &target_fn,
            &target_args,
            &user,
            &relayer,
            FeeAbstractionApproval::Eager,
        )
    }
}
