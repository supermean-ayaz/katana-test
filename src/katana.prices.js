const { BN } = require('@project-serum/anchor');
const { TokenListProvider } = require('@solana/spl-token-registry')
const { clusterApiUrl, Keypair, PublicKey } = require('@solana/web3.js');
const { BasicIdentityContext, structuredIdl } = require('@katana-hq/sdk');
const { findPricePerShareAddress, findStateAddress } = require('@katana-hq/sdk/dist/pda');
const { ROUNDS_PER_PAGE, TOKENS, STRUCTURED_ID } = require('@katana-hq/sdk/dist/utils/constants');

const { createProgram, createReadonlyWallet, sleep } = require('./utils');

class KatanaPrices {
    constructor(rpcUrl, walletAddress) {
        this.rpcUrl = rpcUrl || clusterApiUrl("mainnet-beta");
        this.wallet = createReadonlyWallet(walletAddress || Keypair.generate().publicKey);
        this.program = createProgram(this.rpcUrl, this.wallet, STRUCTURED_ID, structuredIdl);
    }

    async getPriceByUnderlingMint(underlyingMintAddress) {
        try {
            const identityContext = new BasicIdentityContext(new PublicKey(underlyingMintAddress));

            //get state
            const [stateAddress] = await findStateAddress(identityContext, STRUCTURED_ID);
            //console.log('stateAddress:', stateAddress.toString());

            //get round
            const state = await this.program.account.state.fetch(stateAddress);
            const { round, decimals, underlyingTokenMint, derivativeTokenMint, quoteTokenMint } = state;

            //page index
            const pageIndex = new BN(round).div(new BN(ROUNDS_PER_PAGE)).toNumber();
            //console.log('pageIndex:', pageIndex); // pageIndex: 0

            //find the address
            const [pricePerShareAddress] = await findPricePerShareAddress(identityContext, pageIndex, this.program.programId);

            //console.log('pricePerShareAddress:', pricePerShareAddress.toString());

            //get prices
            const pricePerShares = await this.program.account.pricePerSharePage.fetch(pricePerShareAddress);
            const currentPrice = pricePerShares.prices[round - 1].toNumber() / Math.pow(10, decimals)

            return {
                price: currentPrice,
                round: round.toNumber(),
                mint: underlyingTokenMint.toString(),
                lpMint: derivativeTokenMint.toString(),
                //currency: quoteTokenMint.toString()
            };
        } catch (error) {
            throw error;
        }
    }

    async getCoveredCallPriceList(withDelay = false) {
        try {
            //get tokenlist
            const tokenAddresses = Object.values(TOKENS).map(x => x.toString());
            let [tokensInfo, lpTokens] = await new Promise((resolve) => {
                const tokenProvider = new TokenListProvider();
                tokenProvider.resolve().then((tokens) => {
                    const list = tokens.getList();
                    const tokenList = list.filter(x => tokenAddresses.includes(x.address)).map(x => {
                        return {
                            symbol: x.symbol,
                            address: x.address,
                            coingecko: x.extensions?.coingeckoId
                        }
                    });
                    const katanaLPs = tokens.filterByTag('Katana').getList().filter(x => x.symbol.startsWith('kc')).map(x => {
                        return {
                            symbol: x.symbol,
                            address: x.address
                        }
                    });
                    resolve([[...new Set(tokenList)], [...new Set(katanaLPs)]]); //Return unique results
                });
            });

            const priceList = [];
            for (let i = 0; i < tokensInfo.length; i++) {
                const token = tokensInfo[i];
                if (priceList.findIndex(x => x.mint === token.address) >= 0) {
                    //repeated result
                    continue;
                }
                console.log(`Getting info for ${token.symbol}: ${token.address.toString()}`);

                try {
                    const priceInfo = await this.getPriceByUnderlingMint(token.address);
                    const lpInfo = lpTokens.find(x => x.address === priceInfo.lpMint);
                    if (lpInfo) {
                        const tokenPrice = {
                            ...lpInfo,
                            price: priceInfo.price,
                            mint: token.address.toString(),
                            coingecko: token.coingecko
                        };

                        priceList.push(tokenPrice);
                    }
                    else {
                        console.warn("LP token didn't match for ", token);
                    }
                } catch (error) {
                    console.error(error);
                }

                if (withDelay) await sleep(0.3);
            }
            return priceList;
        } catch (error) {
            throw error;
        }
    }
}

module.exports = KatanaPrices;