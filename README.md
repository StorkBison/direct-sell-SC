# direct-sell-contract
This is the contract for direct sell transactions on the marketplace

## test
- `npm i`
- `npm run test`

## deploy to prod

`anchor build`  
`anchor deploy --provider.cluster mainnet`  
first time idl init:  
`anchor idl init -f ./target/idl/direct_sell.json 7t8zVJtPCFAqog1DcnB6Ku1AVKtWfHkCiPi1cAvcJyVF --provider.cluster mainnet`  
subsequent idl update:  
`anchor idl upgrade -f ./target/idl/direct_sell.json 7t8zVJtPCFAqog1DcnB6Ku1AVKtWfHkCiPi1cAvcJyVF --provider.cluster mainnet`  
