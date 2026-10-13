#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env,
    String,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    TemplateExists = 1,
    TemplateNotFound = 2,
    ParentNotFound = 3,
    NotListed = 4,
    AlreadyPurchased = 5,
    SelfPurchase = 6,
    PriceTooHigh = 7,
    InvalidPrice = 8,
    InvalidFees = 9,
    Paused = 10,
    TokenNotAllowed = 11,
    InvalidAmount = 12,
}

/// Marketplace settings. The admin can change the split, the treasury and the
/// pause flag; it can never move user funds or edit a listing.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub treasury: Address,
    pub creator_bps: u32,
    pub parent_bps: u32,
    pub treasury_bps: u32,
    pub paused: bool,
}

/// A listed template. `content_hash` and `created_at` are the authorship proof.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Template {
    pub creator: Address,
    pub content_hash: BytesN<32>,
    /// Stellar Asset Contract the price is paid in. Fixed at listing.
    pub token: Address,
    /// In the token's smallest unit. 0 = free.
    pub price: i128,
    /// Parent template id, for derivatives.
    pub parent: Option<String>,
    /// Parent's creator, copied at listing so `buy` never reads the parent.
    pub parent_creator: Option<Address>,
    pub listed: bool,
    pub sales: u32,
    /// Total paid to the creator from sales (tips excluded).
    pub earned: i128,
    pub tips: i128,
    pub created_at: u64,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Token(Address),
    Template(String),
    Purchase(String, Address),
}

const BPS_DENOMINATOR: u32 = 10_000;

const DAY_IN_LEDGERS: u32 = 17280;
const TTL_THRESHOLD: u32 = DAY_IN_LEDGERS * 30;
const TTL_EXTEND: u32 = DAY_IN_LEDGERS * 90;

const TOPIC: soroban_sdk::Symbol = symbol_short!("market");

fn check_fees(creator_bps: u32, parent_bps: u32, treasury_bps: u32) -> Result<(), Error> {
    let sum = creator_bps
        .checked_add(parent_bps)
        .and_then(|s| s.checked_add(treasury_bps));
    if sum != Some(BPS_DENOMINATOR) {
        return Err(Error::InvalidFees);
    }
    Ok(())
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
}

fn config(env: &Env) -> Config {
    // Set by the constructor, so always present.
    env.storage().instance().get(&DataKey::Config).unwrap()
}

fn save_config(env: &Env, config: &Config) {
    env.storage().instance().set(&DataKey::Config, config);
    bump_instance(env);
}

fn active_config(env: &Env) -> Result<Config, Error> {
    let config = config(env);
    if config.paused {
        return Err(Error::Paused);
    }
    Ok(config)
}

fn require_token(env: &Env, token: &Address) -> Result<(), Error> {
    let allowed: bool = env
        .storage()
        .instance()
        .get(&DataKey::Token(token.clone()))
        .unwrap_or(false);
    if !allowed {
        return Err(Error::TokenNotAllowed);
    }
    Ok(())
}

fn load(env: &Env, template_id: &String) -> Result<Template, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Template(template_id.clone()))
        .ok_or(Error::TemplateNotFound)
}

fn save(env: &Env, template_id: &String, template: &Template) {
    let key = DataKey::Template(template_id.clone());
    env.storage().persistent().set(&key, template);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND);
}

/// `amount * bps / 10000`, or `InvalidPrice` on overflow.
fn share(amount: i128, bps: u32) -> Result<i128, Error> {
    amount
        .checked_mul(bps as i128)
        .map(|v| v / BPS_DENOMINATOR as i128)
        .ok_or(Error::InvalidPrice)
}

/// Transfer unless it is empty or the payer would pay themselves.
fn pay(client: &token::Client, from: &Address, to: &Address, amount: i128) {
    if amount > 0 && from != to {
        client.transfer(from, to, &amount);
    }
}

#[contract]
pub struct TemplateMarket;

#[contractimpl]
impl TemplateMarket {
    /// Runs once at deploy, so the config can't be front-run by another caller.
    pub fn __constructor(
        env: Env,
        admin: Address,
        treasury: Address,
        creator_bps: u32,
        parent_bps: u32,
        treasury_bps: u32,
    ) -> Result<(), Error> {
        check_fees(creator_bps, parent_bps, treasury_bps)?;
        save_config(
            &env,
            &Config {
                admin,
                treasury,
                creator_bps,
                parent_bps,
                treasury_bps,
                paused: false,
            },
        );
        Ok(())
    }

    /// List a new template. `parent` must be an existing template id; its
    /// creator earns `parent_bps` of every sale of this one.
    pub fn list_template(
        env: Env,
        creator: Address,
        template_id: String,
        content_hash: BytesN<32>,
        token: Address,
        price: i128,
        parent: Option<String>,
    ) -> Result<(), Error> {
        creator.require_auth();
        active_config(&env)?;
        require_token(&env, &token)?;
        if price < 0 {
            return Err(Error::InvalidPrice);
        }

        let key = DataKey::Template(template_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::TemplateExists);
        }

        let parent_creator = match &parent {
            Some(parent_id) => Some(
                load(&env, parent_id)
                    .map_err(|_| Error::ParentNotFound)?
                    .creator,
            ),
            None => None,
        };

        let now = env.ledger().timestamp();
        save(
            &env,
            &template_id,
            &Template {
                creator: creator.clone(),
                content_hash,
                token: token.clone(),
                price,
                parent: parent.clone(),
                parent_creator,
                listed: true,
                sales: 0,
                earned: 0,
                tips: 0,
                created_at: now,
                updated_at: now,
            },
        );
        bump_instance(&env);

        env.events().publish(
            (TOPIC, symbol_short!("listed")),
            (template_id, creator, price, token, parent),
        );
        Ok(())
    }

    /// Change the price of future sales. Creator only.
    pub fn update_price(env: Env, template_id: String, price: i128) -> Result<(), Error> {
        let mut template = load(&env, &template_id)?;
        template.creator.require_auth();
        if price < 0 {
            return Err(Error::InvalidPrice);
        }

        template.price = price;
        template.updated_at = env.ledger().timestamp();
        save(&env, &template_id, &template);

        env.events()
            .publish((TOPIC, symbol_short!("price")), (template_id, price));
        Ok(())
    }

    /// Delist or relist. Delisted templates can't be bought. Creator only.
    pub fn set_listed(env: Env, template_id: String, listed: bool) -> Result<(), Error> {
        let mut template = load(&env, &template_id)?;
        template.creator.require_auth();

        template.listed = listed;
        template.updated_at = env.ledger().timestamp();
        save(&env, &template_id, &template);

        env.events()
            .publish((TOPIC, symbol_short!("listing")), (template_id, listed));
        Ok(())
    }

    /// Pay for a template and record the purchase. Money moves straight from
    /// the buyer to the creator, the parent's creator and the treasury.
    /// Fails with `PriceTooHigh` if the price rose above `max_price`.
    pub fn buy(
        env: Env,
        buyer: Address,
        template_id: String,
        max_price: i128,
    ) -> Result<(), Error> {
        buyer.require_auth();
        let config = active_config(&env)?;
        let mut template = load(&env, &template_id)?;

        if !template.listed {
            return Err(Error::NotListed);
        }
        if buyer == template.creator {
            return Err(Error::SelfPurchase);
        }
        if template.price > max_price {
            return Err(Error::PriceTooHigh);
        }
        let purchase_key = DataKey::Purchase(template_id.clone(), buyer.clone());
        if env.storage().persistent().has(&purchase_key) {
            return Err(Error::AlreadyPurchased);
        }

        let price = template.price;
        let mut creator_cut = 0;
        let mut parent_cut = 0;
        let mut treasury_cut = 0;
        if price > 0 {
            require_token(&env, &template.token)?;
            treasury_cut = share(price, config.treasury_bps)?;
            if template.parent_creator.is_some() {
                parent_cut = share(price, config.parent_bps)?;
            }
            // The rounding remainder goes to the creator.
            creator_cut = price - treasury_cut - parent_cut;

            let client = token::Client::new(&env, &template.token);
            match &template.parent_creator {
                // Same person: one transfer, and it's all the creator's.
                Some(parent_creator) if *parent_creator == template.creator => {
                    pay(&client, &buyer, &template.creator, creator_cut + parent_cut);
                }
                Some(parent_creator) => {
                    pay(&client, &buyer, &template.creator, creator_cut);
                    pay(&client, &buyer, parent_creator, parent_cut);
                }
                None => pay(&client, &buyer, &template.creator, creator_cut),
            }
            pay(&client, &buyer, &config.treasury, treasury_cut);

            if template.parent_creator.as_ref() == Some(&template.creator) {
                template.earned += creator_cut + parent_cut;
            } else {
                template.earned += creator_cut;
            }
        }

        env.storage()
            .persistent()
            .set(&purchase_key, &env.ledger().timestamp());
        env.storage()
            .persistent()
            .extend_ttl(&purchase_key, TTL_THRESHOLD, TTL_EXTEND);
        template.sales += 1;
        save(&env, &template_id, &template);

        env.events().publish(
            (TOPIC, symbol_short!("sold")),
            (
                template_id,
                buyer,
                price,
                creator_cut,
                parent_cut,
                treasury_cut,
            ),
        );
        Ok(())
    }

    /// Send `amount` of the template's token straight to its creator.
    pub fn tip(env: Env, from: Address, template_id: String, amount: i128) -> Result<(), Error> {
        from.require_auth();
        active_config(&env)?;
        let mut template = load(&env, &template_id)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if from == template.creator {
            return Err(Error::SelfPurchase);
        }
        require_token(&env, &template.token)?;

        token::Client::new(&env, &template.token).transfer(&from, &template.creator, &amount);
        template.tips += amount;
        save(&env, &template_id, &template);

        env.events()
            .publish((TOPIC, symbol_short!("tip")), (template_id, from, amount));
        Ok(())
    }

    pub fn has_purchased(env: Env, template_id: String, buyer: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Purchase(template_id, buyer))
    }

    pub fn get_template(env: Env, template_id: String) -> Result<Template, Error> {
        load(&env, &template_id)
    }

    pub fn get_config(env: Env) -> Config {
        config(&env)
    }

    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        require_token(&env, &token).is_ok()
    }

    /// Change the split for future sales. Past sales are never recomputed.
    pub fn set_fees(
        env: Env,
        creator_bps: u32,
        parent_bps: u32,
        treasury_bps: u32,
    ) -> Result<(), Error> {
        let mut config = config(&env);
        config.admin.require_auth();
        check_fees(creator_bps, parent_bps, treasury_bps)?;
        config.creator_bps = creator_bps;
        config.parent_bps = parent_bps;
        config.treasury_bps = treasury_bps;
        save_config(&env, &config);
        Ok(())
    }

    pub fn set_treasury(env: Env, treasury: Address) {
        let mut config = config(&env);
        config.admin.require_auth();
        config.treasury = treasury;
        save_config(&env, &config);
    }

    /// Stop listing, buying and tipping. Reads, price and listing changes still work.
    pub fn set_paused(env: Env, paused: bool) {
        let mut config = config(&env);
        config.admin.require_auth();
        config.paused = paused;
        save_config(&env, &config);
    }

    /// Allow or disallow a token for new listings, sales and tips.
    pub fn set_token(env: Env, token: Address, allowed: bool) {
        let config = config(&env);
        config.admin.require_auth();
        let key = DataKey::Token(token);
        if allowed {
            env.storage().instance().set(&key, &true);
        } else {
            env.storage().instance().remove(&key);
        }
        bump_instance(&env);
    }
}

mod test;
