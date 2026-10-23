extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{contract, contractimpl, vec, IntoVal, String};

/// Stands in for the registry: the call the user actually wants to make.
#[contract]
pub struct Target;

#[contractimpl]
impl Target {
    pub fn greet(e: Env, name: String) -> String {
        let _ = name;
        String::from_str(&e, "hello")
    }

    pub fn fail(_e: Env) {
        panic!("target failed");
    }
}

struct Setup {
    env: Env,
    forwarder: FeeForwarderClient<'static>,
    token: TokenClient<'static>,
    target: Address,
    user: Address,
    relayer: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|l| l.sequence_number = 1_000);

    let forwarder_id = env.register(FeeForwarder, ());
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let user = Address::generate(&env);
    let relayer = Address::generate(&env);
    StellarAssetClient::new(&env, &sac.address()).mint(&user, &1_000);

    let target = env.register(Target, ());
    let forwarder = FeeForwarderClient::new(&env, &forwarder_id);
    let token = TokenClient::new(&env, &sac.address());
    Setup { env, forwarder, token, target, user, relayer }
}

fn greet_args(s: &Setup) -> Vec<Val> {
    vec![&s.env, String::from_str(&s.env, "doqtri").into_val(&s.env)]
}

#[test]
fn pays_the_relayer_and_calls_the_target() {
    let s = setup();
    let out = s.forwarder.forward(
        &s.token.address,
        &20,
        &50,
        &1_100,
        &s.target,
        &Symbol::new(&s.env, "greet"),
        &greet_args(&s),
        &s.user,
        &s.relayer,
    );
    let greeting: String = out.into_val(&s.env);
    assert_eq!(greeting, String::from_str(&s.env, "hello"));
    assert_eq!(s.token.balance(&s.relayer), 20);
    assert_eq!(s.token.balance(&s.user), 980);
}

#[test]
fn both_the_user_and_the_relayer_must_authorise() {
    let s = setup();
    s.forwarder.forward(
        &s.token.address,
        &20,
        &50,
        &1_100,
        &s.target,
        &Symbol::new(&s.env, "greet"),
        &greet_args(&s),
        &s.user,
        &s.relayer,
    );
    let signers: std::vec::Vec<Address> = s.env.auths().iter().map(|(a, _)| a.clone()).collect();
    assert!(signers.contains(&s.relayer), "relayer must authorise");
    assert!(signers.contains(&s.user), "user must authorise");
}

#[test]
fn a_fee_above_the_signed_maximum_is_refused() {
    let s = setup();
    let r = s.forwarder.try_forward(
        &s.token.address,
        &51,
        &50,
        &1_100,
        &s.target,
        &Symbol::new(&s.env, "greet"),
        &greet_args(&s),
        &s.user,
        &s.relayer,
    );
    assert!(r.is_err());
    assert_eq!(s.token.balance(&s.user), 1_000);
}

#[test]
fn a_zero_fee_is_refused() {
    let s = setup();
    let r = s.forwarder.try_forward(
        &s.token.address,
        &0,
        &50,
        &1_100,
        &s.target,
        &Symbol::new(&s.env, "greet"),
        &greet_args(&s),
        &s.user,
        &s.relayer,
    );
    assert!(r.is_err());
}

#[test]
fn an_expired_approval_is_refused() {
    let s = setup();
    let r = s.forwarder.try_forward(
        &s.token.address,
        &20,
        &50,
        &999, // before the current ledger (1_000)
        &s.target,
        &Symbol::new(&s.env, "greet"),
        &greet_args(&s),
        &s.user,
        &s.relayer,
    );
    assert!(r.is_err());
    assert_eq!(s.token.balance(&s.relayer), 0);
}

#[test]
fn a_failing_target_reverts_the_fee() {
    let s = setup();
    let r = s.forwarder.try_forward(
        &s.token.address,
        &20,
        &50,
        &1_100,
        &s.target,
        &Symbol::new(&s.env, "fail"),
        &vec![&s.env],
        &s.user,
        &s.relayer,
    );
    assert!(r.is_err());
    assert_eq!(s.token.balance(&s.user), 1_000, "the fee must not be taken when the call fails");
    assert_eq!(s.token.balance(&s.relayer), 0);
}
