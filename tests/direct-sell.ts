import * as anchor from "@project-serum/anchor";
import { Token, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction
} from "@solana/web3.js";
import assert from "assert";
import { expect } from "chai";
import { createMetadata, Creator, Data } from "./metadata/metadata";

const salesTaxRecipient = new PublicKey(
  "3iYf9hHQPciwgJ1TCjpRUp1A3QW4AfaK7J6vCmETRMuu"
);

const PRICE = 1000000;

describe("direct-sell", () => {
  const programId = new anchor.web3.PublicKey(
    "AeJoab5qttXUFNVABZVk8LtQRVDZtAm5oHgM99r1E4oZ"
  );
  const idl = JSON.parse(
    require("fs").readFileSync("./target/idl/direct_sell.json", "utf8")
  );

  const myWallet = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(
      JSON.parse(require("fs").readFileSync(process.env.MY_WALLET, "utf8"))
    )
  );

  const connection = new anchor.web3.Connection(
    "https://api.devnet.solana.com/",
    "confirmed"
  );

  const walletWrapper = new anchor.Wallet(myWallet);

  const provider = new anchor.Provider(connection, walletWrapper, {
    preflightCommitment: "recent",
  });
  const program = new anchor.Program(idl, programId, provider);

  const buyer = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(
      JSON.parse(require("fs").readFileSync("./tests/keys/bidder.json", "utf8"))
    )
  );

  const seller = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(
      JSON.parse(require("fs").readFileSync("./tests/keys/owner.json", "utf8"))
    )
  );

  const creator1 = anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(
      JSON.parse(
        require("fs").readFileSync("./tests/keys/creator1.json", "utf8")
      )
    )
  );

  const creator2 = anchor.web3.Keypair.generate();

  let transferAuthority: PublicKey;
  let bumpAuthority: number;
  let saleInfo: PublicKey;
  let bumpInfo: number;
  let mint: Token;
  let tokenPubkey: PublicKey;

  let metadata: PublicKey;

  it("Sell", async () => {
    mint = await Token.createMint(
      provider.connection,
      seller,
      seller.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    tokenPubkey = await mint.createAccount(seller.publicKey);
    await mint.mintTo(tokenPubkey, seller.publicKey, [seller], 1);

    [transferAuthority, bumpAuthority] = await PublicKey.findProgramAddress(
      [Buffer.from("directsell")],
      program.programId
    );

    [saleInfo, bumpInfo] = await PublicKey.findProgramAddress(
      [
        Buffer.from("directsell"),
        seller.publicKey.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.rpc.sell(new anchor.BN(PRICE * 2), bumpInfo, bumpAuthority, {
      accounts: {
        seller: seller.publicKey,
        token: tokenPubkey,
        mint: mint.publicKey,
        saleInfo,
        transferAuthority,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller],
    });

    const saleInfoAccount = await program.account.saleInfo.fetch(saleInfo);
    assert.ok(saleInfoAccount.initializerPubkey.equals(seller.publicKey));
    assert.ok(saleInfoAccount.mintPubkey.equals(mint.publicKey));
    assert.ok(saleInfoAccount.expectedAmount.toNumber() == PRICE * 2);
    assert.ok(saleInfoAccount.bump == bumpInfo);

    // const dest = await mint.createAccount(creator2.publicKey);
    // await mint.mintTo(dest, seller.publicKey, [seller], 1);
    // mint.transfer(tokenPubkey, dest, seller.publicKey, [seller], 1);
  });

  it("Lower Price", async () => {
    const txid = await program.rpc.lowerPrice(new anchor.BN(PRICE), {
      accounts: {
        seller: seller.publicKey,
        mint: mint.publicKey,
        saleInfo,
        systemProgram: anchor.web3.SystemProgram.programId,
      },
      signers: [seller],
    });
    console.log("lower price", txid);
    const saleInfoAccount = await program.account.saleInfo.fetch(saleInfo);
    assert.ok(saleInfoAccount.initializerPubkey.equals(seller.publicKey));
    assert.ok(saleInfoAccount.mintPubkey.equals(mint.publicKey));
    assert.ok(saleInfoAccount.expectedAmount.toNumber() == PRICE);
    assert.ok(saleInfoAccount.bump == bumpInfo);
  });

  it("Buy", async () => {
    const signers = [creator1, seller];
    let instructions = [];
    metadata = await createMetadata(
      new Data({
        name: "somename",
        symbol: "SOME",
        uri: "https://somelink.come/someid",
        sellerFeeBasisPoints: 500,
        creators: [
          new Creator({
            address: creator1.publicKey,
            verified: true,
            share: 80,
          }),
          new Creator({
            address: creator2.publicKey,
            verified: false,
            share: 20,
          }),
        ],
      }),
      creator1.publicKey, // update authority
      mint.publicKey,
      seller.publicKey, // mint authority
      instructions,
      creator1.publicKey
    );
    const transaction = new Transaction();
    instructions.forEach((instruction) => transaction.add(instruction));
    transaction.recentBlockhash = (
      await connection.getRecentBlockhash("singleGossip")
    ).blockhash;

    transaction.setSigners(...signers.map((s) => s.publicKey));
    // transaction.partialSign(...signers);

    await sendAndConfirmTransaction(connection, transaction, signers, {
      skipPreflight: true,
    });

    const buyerTokenPubkey = await mint.createAccount(buyer.publicKey);

    const buyerPreLamport = await getLamport(connection, buyer.publicKey);
    const sellerPreLamport = await getLamport(connection, seller.publicKey);
    const creator1PreLamport = await getLamport(connection, creator1.publicKey);
    const saleTaxPreLamport = await getLamport(connection, salesTaxRecipient);
    const txid = await program.rpc.buy(new anchor.BN(PRICE), bumpAuthority, {
      accounts: {
        buyer: buyer.publicKey,
        buyerToken: buyerTokenPubkey,
        seller: seller.publicKey,
        token: tokenPubkey,
        mint: mint.publicKey,
        saleInfo,
        transferAuthority,
        salesTaxRecipient,
        metadata,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts: [
        { pubkey: creator1.publicKey, isWritable: true, isSigner: false },
        { pubkey: creator2.publicKey, isWritable: true, isSigner: false },
      ],
      signers: [buyer],
    });

    console.log("buy", txid);

    assert.ok(
      (await mint.getAccountInfo(buyerTokenPubkey)).amount.toNumber() == 1
    );
    assert.ok((await mint.getAccountInfo(tokenPubkey)).amount.toNumber() == 0);

    const buyerPostLamport = await getLamport(connection, buyer.publicKey);
    const sellerPostLamport = await getLamport(connection, seller.publicKey);
    const creator1PostLamport = await getLamport(
      connection,
      creator1.publicKey
    );
    const saleTaxPostLamport = await getLamport(connection, salesTaxRecipient);

    console.log("buyer", buyerPostLamport - buyerPreLamport);
    console.log("creator", creator1PostLamport - creator1PreLamport);
    console.log("sale tax", saleTaxPostLamport - saleTaxPreLamport);
  });

  it("Cancel", async () => {
    const mint2 = await Token.createMint(
      provider.connection,
      seller,
      seller.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    const tokenPubkey2 = await mint2.createAccount(seller.publicKey);
    await mint2.mintTo(tokenPubkey2, seller.publicKey, [seller], 1);

    const [saleInfo2, bumpInfo2] = await PublicKey.findProgramAddress(
      [
        Buffer.from("directsell"),
        seller.publicKey.toBuffer(),
        mint2.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.rpc.sell(new anchor.BN(PRICE), bumpInfo2, bumpAuthority, {
      accounts: {
        seller: seller.publicKey,
        token: tokenPubkey2,
        mint: mint2.publicKey,
        saleInfo: saleInfo2,
        transferAuthority,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller],
    });
  });

  it("Buy with decimals", async () => {
    const decimals = 9;
    const expectedAmount = Math.pow(10, decimals);

    mint = await Token.createMint(
      provider.connection,
      seller,
      seller.publicKey,
      null,
      decimals,
      TOKEN_PROGRAM_ID
    );

    tokenPubkey = await mint.createAccount(seller.publicKey);
    await mint.mintTo(tokenPubkey, seller.publicKey, [seller], expectedAmount);

    [transferAuthority, bumpAuthority] = await PublicKey.findProgramAddress(
      [Buffer.from("directsell")],
      program.programId
    );

    [saleInfo, bumpInfo] = await PublicKey.findProgramAddress(
      [
        Buffer.from("directsell"),
        seller.publicKey.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.rpc.sell(new anchor.BN(PRICE), bumpInfo, bumpAuthority, {
      accounts: {
        seller: seller.publicKey,
        token: tokenPubkey,
        mint: mint.publicKey,
        saleInfo,
        transferAuthority,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller],
    });

    const signers = [creator1, seller];
    let instructions = [];
    metadata = await createMetadata(
      new Data({
        name: "somename",
        symbol: "SOME",
        uri: "https://somelink.come/someid",
        sellerFeeBasisPoints: 500,
        creators: [
          new Creator({
            address: creator1.publicKey,
            verified: true,
            share: 80,
          }),
          new Creator({
            address: creator2.publicKey,
            verified: false,
            share: 20,
          }),
        ],
      }),
      creator1.publicKey, // update authority
      mint.publicKey,
      seller.publicKey, // mint authority
      instructions,
      creator1.publicKey
    );
    const transaction = new Transaction();
    instructions.forEach((instruction) => transaction.add(instruction));
    transaction.recentBlockhash = (
      await connection.getRecentBlockhash("singleGossip")
    ).blockhash;

    transaction.setSigners(...signers.map((s) => s.publicKey));

    await sendAndConfirmTransaction(connection, transaction, signers, {
      skipPreflight: true,
    });

    const buyerTokenPubkey = await mint.createAccount(buyer.publicKey);

    const buyerPreLamport = await getLamport(connection, buyer.publicKey);
    const sellerPreLamport = await getLamport(connection, seller.publicKey);
    const creator1PreLamport = await getLamport(connection, creator1.publicKey);
    const saleTaxPreLamport = await getLamport(connection, salesTaxRecipient);
    const txid = await program.rpc.buy(new anchor.BN(PRICE), bumpAuthority, {
      accounts: {
        buyer: buyer.publicKey,
        buyerToken: buyerTokenPubkey,
        seller: seller.publicKey,
        token: tokenPubkey,
        mint: mint.publicKey,
        saleInfo,
        transferAuthority,
        salesTaxRecipient,
        metadata,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts: [
        { pubkey: creator1.publicKey, isWritable: true, isSigner: false },
        { pubkey: creator2.publicKey, isWritable: true, isSigner: false },
      ],
      signers: [buyer],
    });

    console.log("buy", txid);

    assert.equal(
      (await mint.getAccountInfo(buyerTokenPubkey)).amount.toNumber(),
      expectedAmount
    );
    assert.ok((await mint.getAccountInfo(tokenPubkey)).amount.toNumber() == 0);

    const buyerPostLamport = await getLamport(connection, buyer.publicKey);
    const sellerPostLamport = await getLamport(connection, seller.publicKey);
    const creator1PostLamport = await getLamport(
      connection,
      creator1.publicKey
    );
    const saleTaxPostLamport = await getLamport(connection, salesTaxRecipient);

    console.log("buyer", buyerPostLamport - buyerPreLamport);
    console.log("creator", creator1PostLamport - creator1PreLamport);
    console.log("sale tax", saleTaxPostLamport - saleTaxPreLamport);
  });

  it("Buy with decimals not enough balance throws", async () => {
    const decimals = 9;
    mint = await Token.createMint(
      provider.connection,
      seller,
      seller.publicKey,
      null,
      decimals,
      TOKEN_PROGRAM_ID
    );

    tokenPubkey = await mint.createAccount(seller.publicKey);
    await mint.mintTo(
      tokenPubkey,
      seller.publicKey,
      [seller],
      Math.pow(10, decimals)
    );

    [transferAuthority, bumpAuthority] = await PublicKey.findProgramAddress(
      [Buffer.from("directsell"), seller.publicKey.toBuffer()],
      program.programId
    );

    [saleInfo, bumpInfo] = await PublicKey.findProgramAddress(
      [
        Buffer.from("directsell"),
        seller.publicKey.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      program.programId
    );

    await expect(
      program.rpc.sell(new anchor.BN(PRICE), bumpInfo, bumpAuthority, {
        accounts: {
          seller: seller.publicKey,
          token: tokenPubkey,
          mint: mint.publicKey,
          saleInfo,
          transferAuthority,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [seller],
      })
    ).to.throw;
  });

  it("Admin Cancel", async () => {
    const homedir = require("os").homedir();

    [transferAuthority, bumpAuthority] = await PublicKey.findProgramAddress(
      [Buffer.from("directsell")],
      program.programId
    );

    const admin = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(
        JSON.parse(
          require("fs").readFileSync(
            homedir + "/.config/solana/admin.json",
            "utf8"
          )
        )
      )
    );

    const mint2 = await Token.createMint(
      provider.connection,
      seller,
      seller.publicKey,
      null,
      0,
      TOKEN_PROGRAM_ID
    );

    const tokenPubkey2 = await mint2.createAccount(seller.publicKey);
    await mint2.mintTo(tokenPubkey2, seller.publicKey, [seller], 1);

    const [saleInfo2, bumpInfo2] = await PublicKey.findProgramAddress(
      [
        Buffer.from("directsell"),
        seller.publicKey.toBuffer(),
        mint2.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.rpc.sell(new anchor.BN(PRICE), bumpInfo2, bumpAuthority, {
      accounts: {
        seller: seller.publicKey,
        token: tokenPubkey2,
        mint: mint2.publicKey,
        saleInfo: saleInfo2,
        transferAuthority,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller],
    });

    const txid = await program.rpc.cancelWithAuthority({
      accounts: {
        admin: admin.publicKey,
        seller: seller.publicKey,
        mint: mint2.publicKey,
        saleInfo: saleInfo2,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [admin],
    });

    console.log("admin cancel", txid);
  });

  it("Buy old PDA", async () => {
    const decimals = 0;
    const expectedAmount = Math.pow(10, decimals);

    mint = await Token.createMint(
      provider.connection,
      seller,
      seller.publicKey,
      null,
      decimals,
      TOKEN_PROGRAM_ID
    );

    tokenPubkey = await mint.createAccount(seller.publicKey);
    await mint.mintTo(tokenPubkey, seller.publicKey, [seller], expectedAmount);

    [transferAuthority, bumpAuthority] = await PublicKey.findProgramAddress(
      [Buffer.from("directsell")],
      program.programId
    );

    [saleInfo, bumpInfo] = await PublicKey.findProgramAddress(
      [
        Buffer.from("directsell"),
        seller.publicKey.toBuffer(),
        mint.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.rpc.sell(new anchor.BN(PRICE), bumpInfo, bumpAuthority, {
      accounts: {
        seller: seller.publicKey,
        token: tokenPubkey,
        mint: mint.publicKey,
        saleInfo,
        transferAuthority,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      signers: [seller],
    });

    const signers = [creator1, seller];
    let instructions = [];
    metadata = await createMetadata(
      new Data({
        name: "somename",
        symbol: "SOME",
        uri: "https://somelink.come/someid",
        sellerFeeBasisPoints: 500,
        creators: [
          new Creator({
            address: creator1.publicKey,
            verified: true,
            share: 80,
          }),
          new Creator({
            address: creator2.publicKey,
            verified: false,
            share: 20,
          }),
        ],
      }),
      creator1.publicKey, // update authority
      mint.publicKey,
      seller.publicKey, // mint authority
      instructions,
      creator1.publicKey
    );
    const transaction = new Transaction();
    instructions.forEach((instruction) => transaction.add(instruction));
    transaction.recentBlockhash = (
      await connection.getRecentBlockhash("singleGossip")
    ).blockhash;

    transaction.setSigners(...signers.map((s) => s.publicKey));

    await sendAndConfirmTransaction(connection, transaction, signers, {
      skipPreflight: true,
    });

    const [oldTransferAuthority, oldBumpAuthority] = await PublicKey.findProgramAddress(
      [Buffer.from("directsell"), seller.publicKey.toBuffer()],
      program.programId
    );

    const { blockhash, feeCalculator } = await connection.getRecentBlockhash();

    let tx = new Transaction();
    tx.instructions = [Token.createApproveInstruction(TOKEN_PROGRAM_ID, tokenPubkey, oldTransferAuthority, seller.publicKey, [seller], 1)]
    tx.recentBlockhash = blockhash;
    tx.sign(seller);

    await sendAndConfirmTransaction(connection, tx, [seller]);


    const buyerTokenPubkey = await mint.createAccount(buyer.publicKey);

    const buyerPreLamport = await getLamport(connection, buyer.publicKey);
    const sellerPreLamport = await getLamport(connection, seller.publicKey);
    const creator1PreLamport = await getLamport(connection, creator1.publicKey);
    const saleTaxPreLamport = await getLamport(connection, salesTaxRecipient);
    const txid = await program.rpc.buy(new anchor.BN(PRICE), oldBumpAuthority, {
      accounts: {
        buyer: buyer.publicKey,
        buyerToken: buyerTokenPubkey,
        seller: seller.publicKey,
        token: tokenPubkey,
        mint: mint.publicKey,
        saleInfo,
        transferAuthority: oldTransferAuthority,
        salesTaxRecipient,
        metadata,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      remainingAccounts: [
        { pubkey: creator1.publicKey, isWritable: true, isSigner: false },
        { pubkey: creator2.publicKey, isWritable: true, isSigner: false },
      ],
      signers: [buyer],
    });

    console.log("buy", txid);

    assert.equal(
      (await mint.getAccountInfo(buyerTokenPubkey)).amount.toNumber(),
      expectedAmount
    );
    assert.ok((await mint.getAccountInfo(tokenPubkey)).amount.toNumber() == 0);

    const buyerPostLamport = await getLamport(connection, buyer.publicKey);
    const sellerPostLamport = await getLamport(connection, seller.publicKey);
    const creator1PostLamport = await getLamport(
      connection,
      creator1.publicKey
    );
    const saleTaxPostLamport = await getLamport(connection, salesTaxRecipient);

    console.log("buyer", buyerPostLamport - buyerPreLamport);
    console.log("creator", creator1PostLamport - creator1PreLamport);
    console.log("sale tax", saleTaxPostLamport - saleTaxPreLamport);
  });
});

async function getLamport(
  connection: Connection,
  pkey: PublicKey
): Promise<number> {
  const account = await connection.getAccountInfo(pkey);
  return account.lamports;
}
