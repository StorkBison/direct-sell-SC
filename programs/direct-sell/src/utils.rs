use crate::ErrorCode;

use anchor_lang::{
    prelude::*,
    solana_program::{
        program::{invoke, invoke_signed},
        system_instruction, system_program,
    },
};
use metaplex_token_metadata::state::Metadata;
use std::slice::Iter;

pub fn pay_creator_fees<'a>(
    buyer: &AccountInfo<'a>,
    remaining_accounts: &mut Iter<AccountInfo<'a>>,
    metadata_account: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    price: u64,
) -> Result<u64, ProgramError> {
    let metadata = Metadata::from_account_info(metadata_account)?;
    let seller_fee = metadata.data.seller_fee_basis_points;
    let total_fee = (price as u128) * (seller_fee as u128) / 10000;

    match metadata.data.creators {
        Some(creators) => {
            for creator in creators {
                let share = creator.share as u128;
                let creator_fee = (share * total_fee / 100) as u64;
                let current_creator_account = next_account_info(remaining_accounts)?;
                assert_keys_equal(creator.address, *current_creator_account.key)?;
                if creator_fee > 0 {
                    invoke(
                        &system_instruction::transfer(
                            buyer.key,
                            current_creator_account.key,
                            creator_fee,
                        ),
                        &[
                            buyer.clone(),
                            current_creator_account.clone(),
                            system_program.clone(),
                        ],
                    )?;
                }
            }
        }
        None => {
            msg!("No creators found in metadata");
        }
    };

    Ok(total_fee as u64)
}

pub fn assert_keys_equal(key1: Pubkey, key2: Pubkey) -> ProgramResult {
    if key1 != key2 {
        Err(ErrorCode::PublicKeyMismatch.into())
    } else {
        Ok(())
    }
}
