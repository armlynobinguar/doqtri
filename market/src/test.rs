#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env, IntoVal, String, Symbol,
};

struct Setup<'a> {
    env: Env,
    market: TemplateMarketClient<'a>,
    token: Address,
    admin: Address,
    treasury: Address,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let market_id = env.register(
        TemplateMarket,
        (admin.clone(), treasury.clone(), 8500u32, 500u32, 1000u32),
    );
    let market = TemplateMarketClient::new(&env, &market_id);

    let issuer = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(issuer).address();
    market.set_token(&token, &true);

    Setup {
        env,
        market,
        token,
        admin,
        treasury,
    }
}

impl Setup<'_> {
    fn id(&self, s: &str) -> String {
        String::from_str(&self.env, s)
    }

    fn hash(&self, seed: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[seed; 32])
    }

    fn funded(&self, amount: i128) -> Address {
        let who = Address::generate(&self.env);
        if amount > 0 {
            StellarAssetClient::new(&self.env, &self.token).mint(&who, &amount);
        }
        who
    }

    fn balance(&self, who: &Address) -> i128 {
        TokenClient::new(&self.env, &self.token).balance(who)
    }

    fn list(&self, creator: &Address, id: &str, price: i128, parent: Option<&str>) {
        self.market.list_template(
            creator,
            &self.id(id),
            &self.hash(1),
            &self.token,
            &price,
            &parent.map(|p| self.id(p)),
        );
    }
}

#[test]
fn test_constructor_stores_config() {
    let s = setup();
    let config = s.market.get_config();
    assert_eq!(config.admin, s.admin);
    assert_eq!(config.treasury, s.treasury);
    assert_eq!(
        (config.creator_bps, config.parent_bps, config.treasury_bps),
        (8500, 500, 1000)
    );
    assert!(!config.paused);
}

#[test]
#[should_panic]
fn test_constructor_rejects_bad_fees() {
    let env = Env::default();
    let admin = Address::generate(&env);
    env.register(
        TemplateMarket,
        (admin.clone(), admin, 8500u32, 500u32, 999u32),
    );
}

#[test]
fn test_list_template() {
    let s = setup();
    let creator = s.funded(0);
    s.list(&creator, "t1", 30_000_000, None);

    let t = s.market.get_template(&s.id("t1"));
    assert_eq!(t.creator, creator);
    assert_eq!(t.content_hash, s.hash(1));
    assert_eq!(t.token, s.token);
    assert_eq!(t.price, 30_000_000);
    assert_eq!(t.parent, None);
    assert_eq!(t.parent_creator, None);
    assert!(t.listed);
    assert_eq!((t.sales, t.earned, t.tips), (0, 0, 0));
    assert_eq!(t.created_at, 1_000);
}

#[test]
fn test_list_errors() {
    let s = setup();
    let creator = s.funded(0);
    s.list(&creator, "t1", 0, None);

    let dup = s
        .market
        .try_list_template(&creator, &s.id("t1"), &s.hash(2), &s.token, &0, &None);
    assert_eq!(dup, Err(Ok(Error::TemplateExists)));

    let negative =
        s.market
            .try_list_template(&creator, &s.id("t2"), &s.hash(2), &s.token, &-1, &None);
    assert_eq!(negative, Err(Ok(Error::InvalidPrice)));

    let orphan = s.market.try_list_template(
        &creator,
        &s.id("t3"),
        &s.hash(2),
        &s.token,
        &0,
        &Some(s.id("missing")),
    );
    assert_eq!(orphan, Err(Ok(Error::ParentNotFound)));

    let other = s
        .env
        .register_stellar_asset_contract_v2(Address::generate(&s.env))
        .address();
    let bad_token =
        s.market
            .try_list_template(&creator, &s.id("t4"), &s.hash(2), &other, &0, &None);
    assert_eq!(bad_token, Err(Ok(Error::TokenNotAllowed)));
}

#[test]
fn test_buy_without_parent() {
    let s = setup();
    let creator = s.funded(0);
    let buyer = s.funded(100_000_000);
    s.list(&creator, "t1", 30_000_000, None);

    s.market.buy(&buyer, &s.id("t1"), &30_000_000);

    // No parent: the creator gets creator + parent share (90%).
    assert_eq!(s.balance(&creator), 27_000_000);
    assert_eq!(s.balance(&s.treasury), 3_000_000);
    assert_eq!(s.balance(&buyer), 70_000_000);
    assert!(s.market.has_purchased(&s.id("t1"), &buyer));

    let t = s.market.get_template(&s.id("t1"));
    assert_eq!((t.sales, t.earned), (1, 27_000_000));
}

#[test]
fn test_buy_with_parent() {
    let s = setup();
    let ben = s.funded(0);
    let ana = s.funded(0);
    let buyer = s.funded(100_000_000);
    s.list(&ben, "original", 10_000_000, None);
    s.list(&ana, "derived", 30_000_000, Some("original"));

    let t = s.market.get_template(&s.id("derived"));
    assert_eq!(t.parent_creator, Some(ben.clone()));

    s.market.buy(&buyer, &s.id("derived"), &30_000_000);

    // "you pay 3 USDC: 2.55 to Ana, 0.15 to Ben, 0.30 to Doqtri"
    assert_eq!(s.balance(&ana), 25_500_000);
    assert_eq!(s.balance(&ben), 1_500_000);
    assert_eq!(s.balance(&s.treasury), 3_000_000);
    assert_eq!(s.market.get_template(&s.id("derived")).earned, 25_500_000);
    // The parent's own counters don't change.
    assert_eq!(s.market.get_template(&s.id("original")).sales, 0);
}

#[test]
fn test_buy_auth_tree_is_buy_then_transfers() {
    let s = setup();
    let ben = s.funded(0);
    let ana = s.funded(0);
    let buyer = s.funded(100_000_000);
    s.list(&ben, "original", 0, None);
    s.list(&ana, "derived", 30_000_000, Some("original"));

    s.market.buy(&buyer, &s.id("derived"), &30_000_000);

    // The relay validates exactly this shape: buy → transfer ×3, all from the buyer.
    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    let (addr, invocation) = &auths[0];
    assert_eq!(*addr, buyer);
    assert_eq!(
        invocation.function,
        AuthorizedFunction::Contract((
            s.market.address.clone(),
            Symbol::new(&s.env, "buy"),
            (buyer.clone(), s.id("derived"), 30_000_000i128).into_val(&s.env),
        ))
    );
    let transfers: std::vec::Vec<_> = invocation
        .sub_invocations
        .iter()
        .map(|i| i.function.clone())
        .collect();
    let transfer = |to: &Address, amount: i128| {
        AuthorizedFunction::Contract((
            s.token.clone(),
            Symbol::new(&s.env, "transfer"),
            (buyer.clone(), to.clone(), amount).into_val(&s.env),
        ))
    };
    assert_eq!(
        transfers,
        std::vec![
            transfer(&ana, 25_500_000),
            transfer(&ben, 1_500_000),
            transfer(&s.treasury, 3_000_000),
        ]
    );
}

#[test]
fn test_split_rounding_adds_up() {
    let s = setup();
    let parent_creator = s.funded(0);
    s.list(&parent_creator, "parent", 0, None);

    for price in [1i128, 2, 3, 7, 19, 21, 99, 101, 9_999, 10_001, 123_456_789] {
        for with_parent in [false, true] {
            let creator = s.funded(0);
            let buyer = s.funded(price);
            let id = std::format!("t-{price}-{with_parent}");
            let treasury_before = s.balance(&s.treasury);
            let parent_before = s.balance(&parent_creator);
            s.list(&creator, &id, price, with_parent.then_some("parent"));

            s.market.buy(&buyer, &s.id(&id), &price);

            let to_treasury = s.balance(&s.treasury) - treasury_before;
            let to_parent = s.balance(&parent_creator) - parent_before;
            let to_creator = s.balance(&creator);
            assert_eq!(s.balance(&buyer), 0, "price {price}");
            assert_eq!(to_creator + to_parent + to_treasury, price, "price {price}");
            assert_eq!(to_treasury, price * 1000 / 10_000);
            assert_eq!(
                to_parent,
                if with_parent { price * 500 / 10_000 } else { 0 }
            );
            assert_eq!(s.market.get_template(&s.id(&id)).earned, to_creator);
        }
    }
}

#[test]
fn test_parent_creator_is_creator() {
    let s = setup();
    let ana = s.funded(0);
    let buyer = s.funded(100_000_000);
    s.list(&ana, "v1", 0, None);
    s.list(&ana, "v2", 30_000_000, Some("v1"));

    s.market.buy(&buyer, &s.id("v2"), &30_000_000);
    // One transfer to Ana, one to the treasury.
    assert_eq!(s.env.auths()[0].1.sub_invocations.len(), 2);

    assert_eq!(s.balance(&ana), 27_000_000);
    assert_eq!(s.balance(&s.treasury), 3_000_000);
    assert_eq!(s.market.get_template(&s.id("v2")).earned, 27_000_000);
}

#[test]
fn test_buyer_is_parent_creator_skips_self_transfer() {
    let s = setup();
    let ben = s.funded(100_000_000);
    let ana = s.funded(0);
    s.list(&ben, "original", 0, None);
    s.list(&ana, "derived", 30_000_000, Some("original"));

    s.market.buy(&ben, &s.id("derived"), &30_000_000);

    // Ben keeps his own 5%.
    assert_eq!(s.balance(&ben), 100_000_000 - 25_500_000 - 3_000_000);
    assert_eq!(s.balance(&ana), 25_500_000);
}

#[test]
fn test_delisted_parent_still_paid() {
    let s = setup();
    let ben = s.funded(0);
    let ana = s.funded(0);
    let buyer = s.funded(100_000_000);
    s.list(&ben, "original", 0, None);
    s.list(&ana, "derived", 30_000_000, Some("original"));
    s.market.set_listed(&s.id("original"), &false);

    s.market.buy(&buyer, &s.id("derived"), &30_000_000);
    assert_eq!(s.balance(&ben), 1_500_000);
}

#[test]
fn test_free_template_records_without_transfers() {
    let s = setup();
    let creator = s.funded(0);
    let buyer = s.funded(0);
    s.list(&creator, "free", 0, None);

    s.market.buy(&buyer, &s.id("free"), &0);
    assert_eq!(s.env.auths()[0].1.sub_invocations.len(), 0);

    assert!(s.market.has_purchased(&s.id("free"), &buyer));
    let t = s.market.get_template(&s.id("free"));
    assert_eq!((t.sales, t.earned), (1, 0));
}

#[test]
fn test_buy_errors() {
    let s = setup();
    let creator = s.funded(0);
    let buyer = s.funded(100_000_000);
    s.list(&creator, "t1", 30_000_000, None);

    assert_eq!(
        s.market.try_buy(&creator, &s.id("t1"), &30_000_000),
        Err(Ok(Error::SelfPurchase))
    );
    assert_eq!(
        s.market.try_buy(&buyer, &s.id("t1"), &29_999_999),
        Err(Ok(Error::PriceTooHigh))
    );
    assert_eq!(
        s.market.try_buy(&buyer, &s.id("nope"), &30_000_000),
        Err(Ok(Error::TemplateNotFound))
    );

    s.market.buy(&buyer, &s.id("t1"), &30_000_000);
    assert_eq!(
        s.market.try_buy(&buyer, &s.id("t1"), &30_000_000),
        Err(Ok(Error::AlreadyPurchased))
    );

    let other = s.funded(100_000_000);
    s.market.set_listed(&s.id("t1"), &false);
    assert_eq!(
        s.market.try_buy(&other, &s.id("t1"), &30_000_000),
        Err(Ok(Error::NotListed))
    );
    s.market.set_listed(&s.id("t1"), &true);

    s.market.set_paused(&true);
    assert_eq!(
        s.market.try_buy(&other, &s.id("t1"), &30_000_000),
        Err(Ok(Error::Paused))
    );
    s.market.set_paused(&false);

    s.market.set_token(&s.token, &false);
    assert_eq!(
        s.market.try_buy(&other, &s.id("t1"), &30_000_000),
        Err(Ok(Error::TokenNotAllowed))
    );
}

#[test]
fn test_insufficient_balance_records_nothing() {
    let s = setup();
    let creator = s.funded(0);
    let buyer = s.funded(29_999_999);
    s.list(&creator, "t1", 30_000_000, None);

    assert!(s.market.try_buy(&buyer, &s.id("t1"), &30_000_000).is_err());

    assert!(!s.market.has_purchased(&s.id("t1"), &buyer));
    assert_eq!(s.balance(&buyer), 29_999_999);
    assert_eq!(s.balance(&creator), 0);
    assert_eq!(s.market.get_template(&s.id("t1")).sales, 0);
}

#[test]
fn test_update_price_and_listing() {
    let s = setup();
    let creator = s.funded(0);
    s.list(&creator, "t1", 30_000_000, None);

    s.env.ledger().set_timestamp(2_000);
    s.market.update_price(&s.id("t1"), &50_000_000);
    let t = s.market.get_template(&s.id("t1"));
    assert_eq!(
        (t.price, t.updated_at, t.created_at),
        (50_000_000, 2_000, 1_000)
    );

    assert_eq!(
        s.market.try_update_price(&s.id("t1"), &-5),
        Err(Ok(Error::InvalidPrice))
    );

    s.market.set_listed(&s.id("t1"), &false);
    assert!(!s.market.get_template(&s.id("t1")).listed);
}

#[test]
fn test_creator_auth_required_for_price_and_listing() {
    let s = setup();
    let creator = s.funded(0);
    s.list(&creator, "t1", 30_000_000, None);

    s.market.update_price(&s.id("t1"), &1);
    assert_eq!(s.env.auths()[0].0, creator);
    s.market.set_listed(&s.id("t1"), &false);
    assert_eq!(s.env.auths()[0].0, creator);
}

#[test]
#[should_panic]
fn test_update_price_by_stranger_fails() {
    let s = setup();
    let creator = s.funded(0);
    s.list(&creator, "t1", 30_000_000, None);

    s.env.set_auths(&[]);
    s.market.update_price(&s.id("t1"), &1);
}

#[test]
fn test_admin_auth_required_for_admin_calls() {
    let s = setup();
    s.market.set_fees(&8000, &1000, &1000);
    assert_eq!(s.env.auths()[0].0, s.admin);
    s.market.set_treasury(&s.admin);
    assert_eq!(s.env.auths()[0].0, s.admin);
    s.market.set_paused(&true);
    assert_eq!(s.env.auths()[0].0, s.admin);
    s.market.set_token(&s.token, &false);
    assert_eq!(s.env.auths()[0].0, s.admin);
}

#[test]
#[should_panic]
fn test_set_fees_by_stranger_fails() {
    let s = setup();
    s.env.set_auths(&[]);
    s.market.set_fees(&8000, &1000, &1000);
}

#[test]
fn test_fee_change_applies_to_future_sales_only() {
    let s = setup();
    let creator = s.funded(0);
    s.list(&creator, "t1", 10_000_000, None);
    s.market
        .buy(&s.funded(10_000_000), &s.id("t1"), &10_000_000);
    assert_eq!(s.market.get_template(&s.id("t1")).earned, 9_000_000);

    assert_eq!(
        s.market.try_set_fees(&8000, &1000, &999),
        Err(Ok(Error::InvalidFees))
    );
    s.market.set_fees(&7000, &500, &2500);

    // Already-recorded earnings are untouched; the next sale uses the new split.
    assert_eq!(s.market.get_template(&s.id("t1")).earned, 9_000_000);
    s.market
        .buy(&s.funded(10_000_000), &s.id("t1"), &10_000_000);
    assert_eq!(
        s.market.get_template(&s.id("t1")).earned,
        9_000_000 + 7_500_000
    );
    assert_eq!(s.balance(&s.treasury), 1_000_000 + 2_500_000);
}

#[test]
fn test_set_treasury_redirects_future_cuts() {
    let s = setup();
    let creator = s.funded(0);
    let new_treasury = Address::generate(&s.env);
    s.list(&creator, "t1", 10_000_000, None);
    s.market.set_treasury(&new_treasury);

    s.market
        .buy(&s.funded(10_000_000), &s.id("t1"), &10_000_000);
    assert_eq!(s.balance(&new_treasury), 1_000_000);
    assert_eq!(s.balance(&s.treasury), 0);
}

#[test]
fn test_paused_blocks_list_and_tip() {
    let s = setup();
    let creator = s.funded(0);
    s.list(&creator, "t1", 0, None);
    s.market.set_paused(&true);

    assert_eq!(
        s.market
            .try_list_template(&creator, &s.id("t2"), &s.hash(1), &s.token, &0, &None),
        Err(Ok(Error::Paused))
    );
    let fan = s.funded(10);
    assert_eq!(
        s.market.try_tip(&fan, &s.id("t1"), &10),
        Err(Ok(Error::Paused))
    );
    // Reads still work.
    assert!(s.market.get_template(&s.id("t1")).listed);
}

#[test]
fn test_tip() {
    let s = setup();
    let creator = s.funded(0);
    let fan = s.funded(50_000_000);
    s.list(&creator, "t1", 0, None);

    s.market.tip(&fan, &s.id("t1"), &20_000_000);

    assert_eq!(s.balance(&creator), 20_000_000);
    assert_eq!(s.balance(&s.treasury), 0);
    let t = s.market.get_template(&s.id("t1"));
    assert_eq!((t.tips, t.earned, t.sales), (20_000_000, 0, 0));

    assert_eq!(
        s.market.try_tip(&fan, &s.id("t1"), &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        s.market.try_tip(&creator, &s.id("t1"), &1),
        Err(Ok(Error::SelfPurchase))
    );
}

#[test]
fn test_events() {
    let s = setup();
    let creator = s.funded(0);
    let buyer = s.funded(10_000_000);
    s.list(&creator, "t1", 10_000_000, None);
    s.market.buy(&buyer, &s.id("t1"), &10_000_000);

    // The last event is the market's `sold` (token transfers emit their own first).
    use soroban_sdk::testutils::Events;
    let events = s.env.events().all();
    let (contract, topics, data) = events.last().unwrap();
    assert_eq!(contract, s.market.address);
    assert_eq!(
        topics,
        (symbol_short!("market"), symbol_short!("sold")).into_val(&s.env)
    );
    let data: (String, Address, i128, i128, i128, i128) = data.into_val(&s.env);
    assert_eq!(
        data,
        (s.id("t1"), buyer, 10_000_000, 9_000_000, 0, 1_000_000)
    );
}
