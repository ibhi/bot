import { Contract, providers, utils, Wallet, BigNumber } from "ethers";
import { env } from "process";
import * as constants from "./constants";
import { EthersLiquity } from "@liquity/lib-ethers";
import { Decimal } from "@liquity/lib-base";
import { getUniswapOut } from "./util";

async function main() {
    if (!env.INFURA_KEY) {
        console.log("Please provide a key for Infura.");
        return;
    }
    const provider = new providers.InfuraProvider("kovan", env.INFURA_KEY as string);

    if (!env.ETHEREUM_PRIVATE_KEY) {
        console.log("Please provide a private key environment variable as ETHEREUM_PRIVATE_KEY.");
        return;
    }

    const wallet = new Wallet(env.ETHEREUM_PRIVATE_KEY as string, provider);
    const walletAddress = await wallet.getAddress();
    const liquity = await EthersLiquity.connect(wallet);
    const chainlinkProxy = new Contract(constants.CHAINLINK_ADDRESS, constants.CHAINLINK_ABI, provider);
    const uniswapPool = new Contract(constants.UNISWAP_PAIR_ADDRESS, constants.UNISWAP_PAIR_ABI, provider);
    const arbitrageContract = new Contract(constants.ARBITRAGE_CONTRACT_ADDRESS, constants.ARBITRAGE_CONTRACT_ABI, provider);
    const liquityTroveManager = new Contract(constants.LIQUITY_TROVE_MANAGER_ADDRESS, constants.LIQUITY_TROVE_MANAGER_ABI);
    const profitTxData = new Map();

    provider.on("block", async (_) => {
        // make chainlink price have 18 decimals
        const chainlinkPrice = (await chainlinkProxy.functions.latestRoundData()).answer.mul(BigNumber.from(10).pow(18 - constants.CHAINLINK_DECIMALS));
        const chainlinkDollarPrice = chainlinkPrice.div(BigNumber.from(10).pow(18));
        console.log(`Chainlink ETH price in USD: ${chainlinkDollarPrice.toString()}`);

        const uniswapReserves = await uniswapPool.functions.getReserves();
        if (!uniswapReserves["_reserve0"] || !uniswapReserves["_reserve1"]) {
            console.log("Received invalid reserves data from Uniswap");
            return;
        }
        const uniswapPrice = uniswapReserves["_reserve1"].div(uniswapReserves["_reserve0"]);
        console.log(`Uniswap ETH price in LUSD: ${uniswapPrice.toString()}`);

        profitTxData.clear();

        // if we get more lusd per eth on uniswap
        if (uniswapPrice.gt(chainlinkDollarPrice)) {
            const [fees, total] = await Promise.all([liquity.getFees(), liquity.getTotal()]);

            var greatestProfit: BigNumber = BigNumber.from(0);

            await Promise.all(
                constants.SWAP_AMOUNTS.map(async (ethStartAmount: BigNumber) => {
                    const attemptedAmountLUSD = Decimal.fromBigNumberString(getUniswapOut(uniswapReserves["_reserve0"], uniswapReserves["_reserve1"], ethStartAmount).toString());

                    const uniswapResult = await uniswapPool.populateTransaction.swap(BigNumber.from(0), attemptedAmountLUSD.bigNumber, constants.ARBITRAGE_CONTRACT_ADDRESS, [], { gasLimit: 700000 });

                    // calcualte redemption fee
                    const defaultMaxRedemptionRate = (amount: Decimal) => Decimal.min(fees.redemptionRate(amount.div(total.debt)).add(constants.LIQUITY_DEFAULT_SLIPPAGE_TOLERANCE), Decimal.ONE);
                    const redemptionFeeLUSD = attemptedAmountLUSD.mul(defaultMaxRedemptionRate(attemptedAmountLUSD));
                    const redeemedNetLUSD = attemptedAmountLUSD.sub(redemptionFeeLUSD);
                    const redeemedNetETH = attemptedAmountLUSD.div(Decimal.fromBigNumberString(chainlinkPrice.toString()));
                    const profit = BigNumber.from(redeemedNetETH.bigNumber).sub(ethStartAmount);
                    console.log(`Initial: ${utils.formatEther(ethStartAmount)} ETH; Uniswap Output: ${attemptedAmountLUSD} LUSD; Redeemed LUSD After Fee: ${redeemedNetLUSD}; Redeemed ETH: ${redeemedNetETH}; Profit ETH: ${utils.formatEther(profit)} ETH`);

                    if (profit.gt(greatestProfit)) {
                        greatestProfit = profit;
                        // may fail if amount is too low so just silently error because it is not critical
                        try {
                            const redeemResult: any = await liquity.populate.redeemLUSD(attemptedAmountLUSD, undefined, { gasLimit: 700000 });
                            profitTxData.set(profit.toString(), await arbitrageContract.populateTransaction.MakeCalls(ethStartAmount, [uniswapResult["data"], redeemResult["rawPopulatedTransaction"]["data"]], { gasLimit: 700000 }));
                        } catch {
                            return;
                        }
                    }
                }),
            );
            // at 15 gwei an arbitrage costs approximately (15/1e9) * 600000 = 0.01 eth.  we require profit to be at least 0.02 eth because sometimes our fee calculations slightly underestimate the fee
            if (greatestProfit.gt(constants.PROFITABILITY_MINIMUM) && profitTxData.get(greatestProfit.toString())) {
                console.log("Submitted Transaction!\nHash: " + (await wallet.sendTransaction(profitTxData.get(greatestProfit.toString()))).hash);
            } else {
                console.log("No profitable opportunities found");
            }
        } else {
            console.log("No arbitrage opportunity found.");
        }
        // separator
        console.log("");
    });
}

main();