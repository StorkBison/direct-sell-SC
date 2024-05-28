pub mod utils;
use crate::utils::*;
use anchor_lang::{
    prelude::*,
    solana_program::{
        program::{invoke, invoke_signed},
        system_instruction, system_program,
    },
};
use anchor_spl::token::{Mint, Token, TokenAccount};
use spl_token::instruction::{approve, revoke};

declare_id!("AYaxfZEX99noQWWUH63nAXkrrNGaDXa3eyP6qXEuY2iT");

const PREFIX: &str = "directsell";
const SALES_TAX: u64 = 99;
const SALES_TAX_RECIPIENT_INTERNAL: &str = "3iYf9hHQPciwgJ1TCjpRUp1A3QW4AfaK7J6vCmETRMuu";
const ADMIN_KEY: &str = "6YDryQHHuDvZnoZgze77GdxijLfCEg7EMwqsPkM33uF6";

#[program]
pub mod direct_sell {
    use super::*;
    pub fn sell(ctx: Context<Sell>, price: u64, bump: u8, bump_authority: u8) -> ProgramResult {
        let sale_info = &mut ctx.accounts.sale_info;
        sale_info.initializer_pubkey = *ctx.accounts.seller.key;
        sale_info.mint_pubkey = *ctx.accounts.mint.to_account_info().key;
        sale_info.expected_amount = price;
        sale_info.bump = bump;

        let token = &ctx.accounts.token;
        let token_amount = 10_u64.pow(*&ctx.accounts.mint.decimals as u32);
        let token_program = &ctx.accounts.token_program;
        let seller = &ctx.accounts.seller;
        let transfer_authority = &ctx.accounts.transfer_authority;

        let authority_seeds = [PREFIX.as_bytes(), &[bump_authority]];

        invoke_signed(
            &approve(
                &token_program.key(),
                &token.key(),
                &transfer_authority.key(),
                &seller.key(),
                &[],
                token_amount,
            )
            .unwrap(),
            &[
                token_program.to_account_info(),
                token.to_account_info(),
                transfer_authority.to_account_info(),
                seller.to_account_info(),
            ],
            &[&authority_seeds],
        )?;
        msg!("Sell");
        Ok(())
    }

    pub fn lower_price(ctx: Context<LowerPrice>, price: u64) -> ProgramResult {
        let sale_info = &mut ctx.accounts.sale_info;
        if sale_info.expected_amount >= price {
            sale_info.expected_amount = price;
        } else {
            return Err(ErrorCode::HigherPrice.into());
        }
        msg!("Lower Price");
        Ok(())
    }

    pub fn cancel(ctx: Context<Cancel>, _bump_authority: u8) -> ProgramResult {
        let token = &ctx.accounts.token;
        let token_program = &ctx.accounts.token_program;
        let seller = &ctx.accounts.seller;

        invoke(
            &revoke(&token_program.key(), &token.key(), &seller.key(), &[]).unwrap(),
            &[
                token_program.to_account_info(),
                token.to_account_info(),
                seller.to_account_info(),
            ],
        )?;
        msg!("Cancel Listing");
        Ok(())
    }

    pub fn cancel_with_authority(_ctx: Context<AuthorityCancel>) -> ProgramResult {
        msg!("Admin Cancel Listing");
        Ok(())
    }

    pub fn buy<'info>(
        ctx: Context<'_, '_, '_, 'info, Buy<'info>>,
        price: u64,
        bump_authority: u8,
    ) -> ProgramResult {
        let buyer = &ctx.accounts.buyer;
        let seller = &ctx.accounts.seller;
        let sales_tax_recipient = &ctx.accounts.sales_tax_recipient;
        let metadata = &ctx.accounts.metadata;
        let system_program = &ctx.accounts.system_program;

        let token = &ctx.accounts.token;
        let sale_info = &ctx.accounts.sale_info;
        let actual_price = sale_info.expected_amount;
        let token_amount = 10_u64.pow(*&ctx.accounts.mint.decimals as u32);

        if price != actual_price {
            return Err(ErrorCode::PriceMismatch.into());
        }

        let (derived_metadata_key, _bump) = Pubkey::find_program_address(
            &[
                "metadata".as_bytes(),
                metaplex_token_metadata::id().as_ref(),
                ctx.accounts.mint.key().as_ref(),
            ],
            &metaplex_token_metadata::id(),
        );

        if metadata.key != &derived_metadata_key {
            return Err(ErrorCode::MetadataMismatch.into());
        }

        let sales_fee = actual_price * SALES_TAX / 10000;

        invoke(
            &system_instruction::transfer(buyer.key, sales_tax_recipient.key, sales_fee),
            &[
                buyer.clone(),
                sales_tax_recipient.clone(),
                system_program.to_account_info(),
            ],
        )?;

        let creators_fee = pay_creator_fees(
            buyer,
            &mut ctx.remaining_accounts.iter(),
            metadata,
            system_program,
            actual_price,
        )?;

        let remaining_fee = actual_price - sales_fee - creators_fee;
        invoke(
            &system_instruction::transfer(buyer.key, seller.key, remaining_fee),
            &[
                buyer.clone(),
                seller.clone(),
                system_program.to_account_info(),
            ],
        )?;

        let token_program = &ctx.accounts.token_program;
        let buyer_token = &ctx.accounts.buyer_token;
        let transfer_authority = &ctx.accounts.transfer_authority;

        let mut authority_seeds = vec![PREFIX.as_bytes()];

        let (new_sell_pda, _) = Pubkey::find_program_address(&[PREFIX.as_bytes()], ctx.program_id);

        if !new_sell_pda.eq(transfer_authority.key) {
            authority_seeds.push(seller.key.as_ref());
        }
        let bump_authority = &[bump_authority];
        authority_seeds.push(bump_authority);

        invoke_signed(
            &spl_token::instruction::transfer(
                token_program.key,
                token.to_account_info().key,
                buyer_token.to_account_info().key,
                transfer_authority.key,
                &[],
                token_amount,
            )?,
            &[
                token.to_account_info(),
                buyer_token.to_account_info(),
                transfer_authority.clone(),
                token_program.to_account_info(),
            ],
            &[authority_seeds.as_ref()],
        )?;
        msg!("Buy");
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(price: u64, bump: u8, bump_authority: u8)]
pub struct Sell<'info> {
    #[account(mut, signer)]
    seller: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &token.owner == seller.key,
        constraint = &token.mint == mint.to_account_info().key,
        constraint = token.amount >= 10_u64.pow(mint.decimals as u32),
    )]
    token: Box<Account<'info, TokenAccount>>,
    mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        seeds=[PREFIX.as_bytes(), seller.key().as_ref(), mint.to_account_info().key().as_ref()],
        bump=bump,
        payer=seller,
        space=8+32+32+8+1+100,
    )]
    sale_info: ProgramAccount<'info, SaleInfo>,
    #[account(
        seeds=[PREFIX.as_bytes()],
        bump=bump_authority,
    )]
    transfer_authority: AccountInfo<'info>,
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(price: u64)]
pub struct LowerPrice<'info> {
    #[account(mut, signer)]
    seller: AccountInfo<'info>,
    mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds=[PREFIX.as_bytes(), seller.key().as_ref(), mint.to_account_info().key().as_ref()],
        bump=sale_info.bump,
    )]
    sale_info: ProgramAccount<'info, SaleInfo>,
    #[account(address = system_program::ID)]
    system_program: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(bump_authority: u8)]
pub struct Cancel<'info> {
    #[account(mut, signer)]
    seller: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &token.owner == seller.key,
        constraint = &token.mint == mint.to_account_info().key,
    )]
    token: Box<Account<'info, TokenAccount>>,
    mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        constraint=&sale_info.initializer_pubkey==seller.key,
        seeds=[PREFIX.as_bytes(), seller.key().as_ref(), mint.to_account_info().key().as_ref()],
        bump=sale_info.bump,
        close=seller,
    )]
    sale_info: ProgramAccount<'info, SaleInfo>,
    transfer_authority: AccountInfo<'info>,
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AuthorityCancel<'info> {
    #[account(
        mut,
        signer,
        constraint=&admin.key.to_string()==ADMIN_KEY,
    )]
    admin: AccountInfo<'info>,
    #[account(mut)]
    seller: AccountInfo<'info>,
    mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        constraint=&sale_info.initializer_pubkey==seller.key,
        seeds=[PREFIX.as_bytes(), seller.key().as_ref(), mint.to_account_info().key().as_ref()],
        bump=sale_info.bump,
        close=seller,
    )]
    sale_info: ProgramAccount<'info, SaleInfo>,
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(price: u64, bump_authority: u8)]
pub struct Buy<'info> {
    #[account(mut, signer)]
    buyer: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &buyer_token.owner == buyer.key,
        constraint = &buyer_token.mint == mint.to_account_info().key,
    )]
    buyer_token: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    seller: AccountInfo<'info>,
    #[account(
        mut,
        constraint = &token.owner == seller.key,
        constraint = &token.mint == mint.to_account_info().key,
        constraint = token.amount >= 10_u64.pow(mint.decimals as u32),
    )]
    token: Box<Account<'info, TokenAccount>>,
    mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        seeds=[PREFIX.as_bytes(), seller.key().as_ref(), mint.to_account_info().key().as_ref()],
        bump=sale_info.bump,
        close=seller,
    )]
    sale_info: ProgramAccount<'info, SaleInfo>,
    transfer_authority: AccountInfo<'info>,
    #[account(mut, constraint = sales_tax_recipient.key.to_string() == SALES_TAX_RECIPIENT_INTERNAL)]
    sales_tax_recipient: AccountInfo<'info>,
    metadata: AccountInfo<'info>,
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
}

#[account]
pub struct SaleInfo {
    pub initializer_pubkey: Pubkey,
    pub mint_pubkey: Pubkey,
    pub expected_amount: u64,
    pub bump: u8,
}

#[error]
pub enum ErrorCode {
    #[msg("Public key mismatch")]
    PublicKeyMismatch,
    #[msg("Cannot increase price")]
    HigherPrice,
    #[msg("Price mismatched")]
    PriceMismatch,
    #[msg("Metadata mismatched")]
    MetadataMismatch,
}
