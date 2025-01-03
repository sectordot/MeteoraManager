import { sendAndConfirmTransaction, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import pkg from "@meteora-ag/dlmm";
const { default: DLMM, StrategyType } = pkg;
import { Wallet } from '@project-serum/anchor';
import bs58 from 'bs58';
import BN from 'bn.js';
import { modifyPriorityFeeIx } from './utils.service.js';
import { getPositions, getFullPosition } from '../utils/GetPosition.js';
import { sellAllTokens, buyToken } from './jupiter.service.js';
import { TOTAL_RANGE_INTERVAL, getConnection, TOKEN_PROGRAM_ID, MAX_PRIORITY_FEE_REMOVE_LIQUIDITY, MAX_PRIORITY_FEE_CREATE_POSITION, TRANSACTION_MODE } from '../config/index.js';
import { getTokenBalance } from '../utils/getBalance.js';
import { displayLogo } from '../utils/logger.js';
import { displayPositionsTable } from "./wallet.service.js";

export async function createPosition(poolAddress, user, amountInLamports, strategy = '2') {
    try {
        const conn = await getConnection();
        const dlmmPool = await DLMM.create(conn, poolAddress);
        
        const activeBin = await dlmmPool.getActiveBin();
        const totalXAmount = new BN(0);
        const totalYAmount = new BN(amountInLamports);
        
        const minBinId = activeBin.binId - TOTAL_RANGE_INTERVAL;
        const maxBinId = activeBin.binId;
        const newOneSidePosition = Keypair.generate();

        const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: newOneSidePosition.publicKey,
            user: user.publicKey,
            totalXAmount,
            totalYAmount,
            strategy: {
                maxBinId,
                minBinId,
                strategyType: strategy === '1' ? StrategyType.SpotImBalanced : StrategyType.BidAskImBalanced,
            },
        });

        modifyPriorityFeeIx(createPositionTx, MAX_PRIORITY_FEE_CREATE_POSITION);

        try {
            if (TRANSACTION_MODE === 1) {
                // Деген мод - не ждем подтверждения
                conn.sendTransaction(
                    createPositionTx,
                    [user, newOneSidePosition],
                    { skipPreflight: true, preflightCommitment: "processed" }
                );
            } else {
                // Безопасный мод - ждем подтверждения
                await sendAndConfirmTransaction(
                    conn,
                    createPositionTx,
                    [user, newOneSidePosition],
                    { skipPreflight: false, preflightCommitment: "confirmed" }
                );
            }
            console.log(`\x1b[36m[${new Date().toLocaleTimeString()}] | SUCCESS | [${user.publicKey.toString().slice(0, 4)}...] Транзакция добавления ликвидности отправлена\x1b[0m`);
        } catch {} // Игнорируем ошибку
        
    } catch (error) {
        console.error("\x1b[31m~~~ [!] | ERROR | Ошибка в createPosition\x1b[0m");
    }
}

export async function removeLiquidity(poolAddress, user) {
    try {
        const conn = await getConnection();
        const dlmmPool = await DLMM.create(conn, poolAddress);
        const position = await getFullPosition(user, poolAddress);
        
        if (!position) {
            console.log(`\x1b[31m~~~ [!] | ALERT | [${user.publicKey.toString().slice(0, 4)}...] Позиция не найдена для пула: ${poolAddress.toString()}\x1b[0m`);
            return;
        }

        const positionData = position.lbPairPositionsData[0];
        
        if (!positionData) {
            console.log(`\x1b[31m~~~ [!] | ALERT | [${user.publicKey.toString().slice(0, 4)}...] positionData отсутствует\x1b[0m`);
            return;
        }

        const positionPublicKey = positionData.publicKey;
        
        if (!positionPublicKey) {
            console.error(`\x1b[31m~~~ [!] | ALERT | [${user.publicKey.toString().slice(0, 4)}...] publicKey отсутствует в positionData\x1b[0m`);
            return;
        }

        const binIdsToRemove = positionData.positionData.positionBinData.map(
            bin => bin.binId
        );
        
        const removeLiquidityTx = await dlmmPool.removeLiquidity({
            position: positionPublicKey,
            user: user.publicKey,
            binIds: binIdsToRemove,
            bps: new BN(100 * 100),
            shouldClaimAndClose: true,
        });

        modifyPriorityFeeIx(removeLiquidityTx, MAX_PRIORITY_FEE_REMOVE_LIQUIDITY);

        try {
            if (TRANSACTION_MODE === 1) {
                // Деген мод - не ждем подтверждения
                conn.sendTransaction(
                    removeLiquidityTx,
                    [user],
                    { skipPreflight: true, preflightCommitment: "processed" }
                );
            } else {
                // Безопасный мод - ждем подтверждения
                await sendAndConfirmTransaction(
                    conn,
                    removeLiquidityTx,
                    [user],
                    { skipPreflight: false, preflightCommitment: "confirmed" }
                );
            }
            console.log(`\x1b[36m[${new Date().toLocaleTimeString()}] | SUCCESS | [${user.publicKey.toString().slice(0, 4)}...] Транзакция удаления ликвидности отправлена\x1b[0m`);
        } catch {} // Игнорируем ошибку
        
    } catch (error) {
        console.error("\x1b[31m~~~ [!] | ERROR | Ошибка в removeLiquidity\x1b[0m");
        throw error;
    }
}

async function sellTokensWithRetries(wallet, tokenAddress, maxAttempts = 3) {
    let attempt = 0;
    let hasTokens = true;
    const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(wallet.privateKey)));

    while (hasTokens && attempt < maxAttempts) {
        attempt++;
        if (attempt > 1) {
            console.log(`\n\x1b[36m[⌛] | WAITING | Попытка №${attempt} продажи токенов...\x1b[0m`);
        }

        try {
            await processSellAllTokens(wallet, tokenAddress);
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Проверяем, остались ли токены
            const conn = await getConnection();
            const accounts = await conn.getParsedTokenAccountsByOwner(
                user.publicKey,
                { programId: TOKEN_PROGRAM_ID }
            );
            hasTokens = accounts.value.some(acc => 
                acc.account.data.parsed.info.tokenAmount.uiAmount > 5 && 
                acc.account.data.parsed.info.mint === tokenAddress
            );
            
            if (hasTokens) {
                console.log(`\x1b[31m~~~ [!] | ALERT | [${wallet.description.slice(0, 4)}...] Остались токены после продажи\x1b[0m`);
            }
        } catch (error) {
            console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Ошибка продажи: ${error.message}\x1b[0m`);
        }
    }

    return hasTokens;
}

export async function autoCheckPositions(wallets, action, poolAddress, strategy = '2') {    
    let validPoolAddress;
    let tokenAddress = null;
    await displayLogo();
    try {
        validPoolAddress = new PublicKey(poolAddress.trim());
    } catch (error) {
        throw new Error(`\x1b[31m~~~ [!] | ERROR | Некорректный адрес пула: ${error.message}\x1b[0m`);
    }
    
    process.on('SIGINT', () => {
        console.log(`\n\n\x1b[36m${new Date().toLocaleTimeString()} | Мониторинг остановлен\x1b[0m\n\n`);
        process.exit(0);
    });

    while (true) {
        try {
            const poolsToClose = new Set();
            const walletsWithPositions = new Map();
            const positionsInfo = []; // Создаем массив для всех позиций

            // Проверяем позиции всех кошельков
            const promises = wallets.map(async wallet => {
                await new Promise(resolve => { setTimeout(resolve, 1000 + Math.random() * 1000) });
                const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(wallet.privateKey)));
                const positions = await getPositions(user);
                
                if (positions && positions.length > 0) {
                    const position = positions.find(p => p.poolAddress === poolAddress);
                    
                    if (position) {
                        const tokenName = position.poolInfo.name;
                        tokenAddress = position.poolInfo.x_mint;
                        const positionSolValue = position.amounts.positionToken2;
                        const activeBinID = position.binID.current;
                        
                        // Добавляем информацию о позиции в общий массив
                        positionsInfo.push({
                            'Кошелек': wallet.description.slice(0, 4) + '...',
                            'SOL value': positionSolValue,
                            'Текущий bin': position.binID.current,
                            'Нижний bin': position.binID.lower
                        });
                        
                        if (positionSolValue === 0 || position.binID.current === position.binID.lower) {
                            await displayLogo();
                            await console.log("\n\x1b[36m[!] | INFO | Для остановки мониторинга нажмите Ctrl+C\x1b[0m\n");
                            console.log(`\n\x1b[33m• Позиция требует закрытия:\x1b[0m`);
                            console.log(`  └─ \x1b[90mКошелек:\x1b[0m ${wallet.description.slice(0, 4)}...`);
                            console.log(`  └─ \x1b[90mТокен:\x1b[0m ${tokenName}`);
                            console.log(`  └─ \x1b[90mАдрес токена:\x1b[0m ${tokenAddress}`);
                            console.log(`  └─ \x1b[90mSOL value:\x1b[0m ${positionSolValue}`);
                            console.log(`  └─ \x1b[90mТекущий bin:\x1b[0m ${position.binID.current}`);
                            console.log(`  └─ \x1b[90mНижний bin:\x1b[0m ${position.binID.lower}`);
                            
                            poolsToClose.add(position.poolAddress);
                            if (!walletsWithPositions.has(position.poolAddress)) {
                                walletsWithPositions.set(position.poolAddress, []);
                            }
                            walletsWithPositions.get(position.poolAddress).push(wallet);
                        } else {
                            await displayLogo();
                            await console.log("\n\x1b[36m[!] | INFO | Для остановки мониторинга нажмите Ctrl+C\x1b[0m\n");
                            console.table(positionsInfo);
                        }
                    }
                }
            });
            await Promise.all(promises);
            
            // Выводим информацию о всех позициях
            if (positionsInfo.length > 0) {
                await displayLogo();
                await console.log("\n\x1b[36m[!] | INFO | Для остановки мониторинга нажмите Ctrl+C\x1b[0m\n");
                console.table(positionsInfo);
            }

            if (poolsToClose.size > 0) {
                for (const poolAddress of poolsToClose) {
                    const affectedWallets = walletsWithPositions.get(poolAddress);
                    
                    if (action === "1") {
                        // Закрытие, консолидация и продажа
                        console.log(`\n\x1b[36m[⌛] | WAITING | Закрытие позиций для ${affectedWallets.length} кошельков...\x1b[0m`);
                        
                        // Закрываем позиции
                        let remainingWallets = [];
                        for (let attempts = 0; attempts < 3; attempts++) {
                            if (attempts > 0) {
                                console.log(`\n\x1b[36m[⌛] | WAITING | Попытка ${attempts + 1} закрытия позиций...\x1b[0m`);
                            }
                            
                            const promises = affectedWallets.map(async (wallet) => {
                                const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(wallet.privateKey)));
                                try {
                                    await new Promise(resolve => { setTimeout(resolve, 1000 + Math.random() * 1000) });
                                    console.log(`\n\x1b[36m[⌛] | WAITING | [${user.publicKey.toString().slice(0, 4)}...] Отправка транзакции на закрытие позиции\x1b[0m`);
                                    await processRemoveLiquidity(wallet, poolAddress);  
                                    await new Promise(resolve => { setTimeout(resolve, 2000 + Math.random() * 1000) });
                                    // Проверяем, закрылась ли позиция
                                    const position = await getFullPosition(user, new PublicKey(poolAddress));
                                    
                                    if (position) {
                                        console.log(`\x1b[31m~~~ [!] | ALERT | [${user.publicKey.toString().slice(0, 4)}...] Позиция не закрылась, повторная попытка\x1b[0m`);
                                        console.log(position);
                                        remainingWallets.push(wallet);
                                    } else {
                                        console.log(`\x1b[32m${new Date().toLocaleTimeString()} | SUCCESS | [${user.publicKey.toString().slice(0, 4)}...] Позиция успешно закрыта\x1b[0m`);
                                    }
                                } catch (error) {
                                    console.error(`\x1b[31m~~~ [!] | ERROR | [${user.publicKey.toString().slice(0, 4)}...] Ошибка при закрытии: ${error.message}\x1b[0m`);
                                    remainingWallets.push(wallet);
                                }
                            });
                            await Promise.all(promises);
                            
                            if (remainingWallets.length === 0) break;
                            affectedWallets = remainingWallets;
                            remainingWallets = [];
                        }

                        // Консолидация и продажа только если все позиции закрыты
                        if (remainingWallets.length === 0) {
                            console.log(`\n\x1b[36m[⌛] | WAITING | Переходим к продаже токенов\x1b[0m`);
                            // Продаем токены с каждого кошелька
                            const sellPromises = affectedWallets.map(async (wallet) => {
                                await sellTokensWithRetries(wallet, tokenAddress);
                                await new Promise(resolve => setTimeout(resolve, 2000));
                            });
                            await Promise.all(sellPromises);
                        } else {
                            console.log(`\x1b[31m~~~ [!] | ERROR | Не удалось закрыть все позиции, попробуйте вручную (Через главное меню)\x1b[0m`);
                            process.exit(0);
                        }
                        
                    } else if (action === "2") {
                        // Кейс 2: Закрытие и открытие в токенах
                        const promises = affectedWallets.map(async (wallet) => {
                            await new Promise(resolve => { setTimeout(resolve, 1000 + Math.random() * 1000) });
                            let isPositionClosed = false;
                            let isPositionOpened = false;
                            let attempts = 0;
                            const maxAttempts = 3;
                            
                            // Закрываем позицию
                            while (!isPositionClosed && attempts < maxAttempts) {
                                attempts++;
                                if (attempts > 1) {
                                    console.log(`\n\x1b[36m[⌛] | WAITING | Попытка ${attempts} закрытия позиции для [${wallet.description.slice(0, 4)}...]\x1b[0m`);
                                }
                                
                                try {
                                    console.log(`\n\x1b[36m[⌛] | WAITING | [${wallet.description.slice(0, 4)}...] Отправка транзакции на закрытие позиции\x1b[0m`);
                                    await processRemoveLiquidity(wallet, poolAddress);                                    
                                    // Проверяем, закрылась ли позиция
                                    const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(wallet.privateKey)));
                                    const position = await getFullPosition(user, new PublicKey(poolAddress));
                                    
                                    if (position) {
                                        console.log(`\x1b[31m~~~ [!] | ALERT | [${user.publicKey.toString().slice(0, 4)}...] Позиция не закрылась\x1b[0m`);
                                        continue;
                                    }
                                    
                                    isPositionClosed = true;
                                    console.log(`\x1b[32m[${new Date().toLocaleTimeString()}] | SUCCESS | [${user.publicKey.toString().slice(0, 4)}...] Позиция успешно закрыта\x1b[0m`);
                                    
                                } catch (error) {
                                    console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Ошибка при закрытии: ${error.message}\x1b[0m`);
                                }
                            }

                            if (!isPositionClosed) {
                                console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Не удалось закрыть позицию после ${maxAttempts} попыток\x1b[0m`);
                            }

                            // Открываем новую позицию
                            attempts = 0;
                            while (!isPositionOpened && attempts < maxAttempts) {
                                
                                attempts++;
                                if (attempts > 1) {
                                    console.log(`\n\x1b[36m[⌛] | WAITING | Попытка ${attempts} открытия позиции для [${wallet.description.slice(0, 4)}...]\x1b[0m`);
                                }
                                
                                try {
                                    const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(wallet.privateKey)));
                                    let position = await getFullPosition(user, new PublicKey(poolAddress));
                                    if (!position) {
                                        console.log(`\n\x1b[36m[⌛] | WAITING | [${wallet.description.slice(0, 4)}...] Отправка транзакции на открытие позиции в токенах\x1b[0m`);
                                        await processCreateTokenPosition(wallet, poolAddress, strategy);
                                    }
                                    // Проверяем, открылась ли позиция
                                    position = await getFullPosition(user, new PublicKey(poolAddress));
                                    if (!position) {
                                        console.log(`\x1b[31m~~~ [!] | ALERT | [${wallet.description.slice(0, 4)}...] Позиция не открылась\x1b[0m`);
                                        continue;
                                    }
                                    
                                    isPositionOpened = true;
                                    console.log(`\x1b[32m[${new Date().toLocaleTimeString()}] | SUCCESS | [${wallet.description.slice(0, 4)}...] Позиция успешно открыта\x1b[0m`);
                                    
                                } catch (error) {
                                    console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Ошибка при открытии: ${error.message}\x1b[0m`);
                                }
                            }

                            if (!isPositionOpened) {
                                console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Не удалось открыть позицию после ${maxAttempts} попыток\x1b[0m`);
                            }
                        });
                        await Promise.all(promises);

                        // Начинаем мониторинг binDifference для успешно переоткрытых позиций
                        while (true) {
                            console.log("\n\x1b[36m[⌛] | WAITING | Следующая проверка ренжа через 30 секунд...\x1b[0m");
                            await new Promise(resolve => setTimeout(resolve, 30000));
                            const promises = affectedWallets.map(async (wallet) => {
                                let isPositionClosed = false;
                                let isPositionOpened = false;
                                let attempts = 0;
                                const maxAttempts = 3;

                                try {
                                    const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(wallet.privateKey)));
                                    const positions = await getPositions(user);
                                    const position = positions.find(p => p.poolAddress === poolAddress);

                                    if (position) {
                                        const binDifference = position.binID.current - position.binID.lower;
                                        
                                        if (binDifference > 5) {
                                            console.log(`\n\x1b[33m• Требуется переоткрытие позиции:\x1b[0m`);
                                            console.log(`  └─ \x1b[90mКошелек:\x1b[0m [${wallet.description.slice(0, 4)}...]`);
                                            console.log(`  └─ \x1b[90mРазница binID:\x1b[0m ${binDifference}`);
                                            
                                            // Закрываем позицию
                                            while (!isPositionClosed && attempts < maxAttempts) {
                                                attempts++;
                                                if (attempts > 1) {
                                                    console.log(`\n\x1b[36m[⌛] | WAITING | Попытка ${attempts} закрытия позиции для [${wallet.description.slice(0, 4)}...]\x1b[0m`);
                                                }
                                                
                                                try {
                                                    let fullPosition = await getFullPosition(user, new PublicKey(poolAddress));
                                                    if (!fullPosition) {
                                                        console.log(`\n\x1b[36m[⌛] | WAITING | [${wallet.description.slice(0, 4)}...] Отправка транзакции на закрытие позиции\x1b[0m`);
                                                        await processRemoveLiquidity(wallet, poolAddress);
                                                        await new Promise(resolve => { setTimeout(resolve, 2000 + Math.random() * 1000) });
                                                    }
                                                    fullPosition = await getFullPosition(user, new PublicKey(poolAddress));
                                                    if (fullPosition) {
                                                        console.log(`\x1b[31m~~~ [!] | ALERT | [${wallet.description.slice(0, 4)}...] Позиция не закрылась\x1b[0m`);
                                                        continue;
                                                    }
                                                    
                                                    isPositionClosed = true;
                                                    console.log(`\x1b[32m[${new Date().toLocaleTimeString()}] | SUCCESS | [${wallet.description.slice(0, 4)}...] Позиция успешно закрыта\x1b[0m`);
                                                    
                                                } catch (error) {
                                                    console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Ошибка при закрытии: ${error.message}\x1b[0m`);
                                                }
                                            }

                                            if (!isPositionClosed) {
                                                console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Не удалось закрыть позицию после ${maxAttempts} попыток\x1b[0m`);
                                            }

                                            // Открываем новую позицию
                                            attempts = 0;
                                            while (!isPositionOpened && attempts < maxAttempts) {
                                                attempts++;
                                                if (attempts > 1) {
                                                    console.log(`\n\x1b[36m[⌛] | WAITING | Попытка ${attempts} открытия позиции для [${wallet.description.slice(0, 4)}...]\x1b[0m`);
                                                }
                                                
                                                try {
                                                    let fullPosition = await getFullPosition(user, new PublicKey(poolAddress));
                                                    if (!fullPosition) {
                                                        console.log(`\n\x1b[36m[⌛] | WAITING | [${wallet.description.slice(0, 4)}...] Отправка транзакции на открытие позиции в токенах\x1b[0m`);
                                                        await processCreateTokenPosition(wallet, poolAddress, strategy);
                                                        await new Promise(resolve => { setTimeout(resolve, 2000 + Math.random() * 1000) });
                                                    }
                                                    fullPosition = await getFullPosition(user, new PublicKey(poolAddress));
                                                    if (!fullPosition) {
                                                        console.log(`\x1b[31m~~~ [!] | ALERT | [${wallet.description.slice(0, 4)}...] Позиция не открылась\x1b[0m`);
                                                        continue;
                                                    }
                                                    
                                                    isPositionOpened = true;
                                                    console.log(`\x1b[32m[${new Date().toLocaleTimeString()}] | SUCCESS | [${wallet.description.slice(0, 4)}...] Позиция успешно переоткрыта\x1b[0m`);
                                                    
                                                } catch (error) {
                                                    console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Ошибка при открытии: ${error.message}\x1b[0m`);
                                                }
                                            }

                                            if (!isPositionOpened) {
                                                console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Не удалось открыть позицию после ${maxAttempts} попыток\x1b[0m`);
                                            }
                                        }
                                    }
                                } catch (error) {
                                    console.error(`\x1b[31m~~~ [!] | ERROR | [${wallet.description.slice(0, 4)}...] Ошибка при проверке/переоткрытии: ${error.message}\x1b[0m`);
                                }
                            });
                            await Promise.all(promises);
                        }
                    }
                }
            } else {
                if (positionsInfo.length === 0) {
                    console.log(`\n\x1b[32m[${new Date().toLocaleTimeString()}] | SUCCESS | Позиций не найдено\x1b[0m\n`);
                    process.exit(0);
                }
                console.log(`\n\x1b[32m[${new Date().toLocaleTimeString()}] | SUCCESS | Все позиции в норме\x1b[0m\n`);
            }
            console.log(`\n\x1b[36m[⌛] | WAITING | Следующая проверка через 20 секунд...\x1b[0m`);
            await new Promise(resolve => setTimeout(resolve, 20000));
            
        } catch (error) {
            console.error(`\x1b[31m~~~ [!] | ERROR | Ошибка при проверке позицийx1b[0m`);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
}

export async function processWallet(walletData, poolAddress, solAmount, strategy = '2') {
    try {
        await new Promise(resolve => { setTimeout(resolve, 1000 + Math.random() * 1000) });
        const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(walletData.privateKey)));
        const amountInLamports = parseFloat(solAmount) * LAMPORTS_PER_SOL;  
        await createPosition(new PublicKey(poolAddress), user, amountInLamports, strategy);
    } catch (error) {
        console.error(`\x1b[31m~~~ [!] | ERROR | ${walletData.description.slice(0, 4)}... Ошибка при открытии позиции: ${error.message}\x1b[0m`);
    }
}

export async function processRemoveLiquidity(walletData, poolAddress) {
    try {
        await new Promise(resolve => { setTimeout(resolve, 1000 + Math.random() * 1000) });
        const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(walletData.privateKey)));        
        await removeLiquidity(
            new PublicKey(poolAddress),
            user
        );
    } catch (error) {
        console.error(`\x1b[31m~~~ [!] | ERROR | ${walletData.description.slice(0, 4)}... Ошибка при удалении ликвидности\x1b[0m`);
        throw error;
    }
}

export async function processSellAllTokens(walletData, tokenAddress = null) {
    try {
        await new Promise(resolve => { setTimeout(resolve, 1000 + Math.random() * 1000) });
        const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(walletData.privateKey)));
        const wallet = new Wallet(user);
        await sellAllTokens(wallet, tokenAddress);
    } catch (error) {
        console.error(`\x1b[31m~~~ [!] | ERROR | ${walletData.description.slice(0, 4)}... Ошибка при продаже токенов\x1b[0m`);
    }
}

export async function processBuyToken(walletData, tokenAddress, solAmount) {
    try {
        await new Promise(resolve => { setTimeout(resolve, 1000 + Math.random() * 1000) });
        const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(walletData.privateKey)));
        const wallet = new Wallet(user);
        await buyToken(wallet, tokenAddress, solAmount);
    } catch (error) {
        console.error(`\x1b[31m~~~ [!] | ERROR | ${walletData.description.slice(0, 4)}... Ошибка при покупке токенов: ${error.message}\x1b[0m`);
    }
}

export async function claimAllRewards(user, poolAddress) {
    try {
        await new Promise(resolve => { setTimeout(resolve, 1000 + Math.random() * 1000) });
        const position = await getFullPosition(user, poolAddress);
        
        if (!position) {
            console.log(`\x1b[31m~~~ [!] | ERROR | ${wallet.description.slice(0, 4)}... Позиции не найдены\x1b[0m`);
            return;
        }

        const conn = await getConnection();
        const dlmmPool = await DLMM.create(conn, poolAddress);
        
        const positionData = position.lbPairPositionsData[0];
        if (!positionData) {
            console.log(`\x1b[31m~~~ [!] | ERROR | ${wallet.description.slice(0, 4)}... positionData отсутствует\x1b[0m`);
            return;
        }

        if (positionData.positionData.feeX.isZero() && positionData.positionData.feeY.isZero()) {
            console.log(`\x1b[31m~~~ [!] | ERROR | ${wallet.description.slice(0, 4)}... Нет доступных фисов для клейма\x1b[0m`);
            return;
        }

        const claimRewardsTxs = await dlmmPool.claimAllRewards({
            owner: user.publicKey,
            positions: [positionData]
        });

        if (!claimRewardsTxs || claimRewardsTxs.length === 0) {
            console.log(`\x1b[31m~~~ [!] | ERROR | ${wallet.description.slice(0, 4)}... Не сформировались транзакции для клейма\x1b[0m`);
            return;
        }
        
        for (let i = 0; i < claimRewardsTxs.length; i++) {
            const tx = claimRewardsTxs[i];            
            modifyPriorityFeeIx(tx, 150000);
            
            try {
                if (TRANSACTION_MODE === 1) {
                    sendAndConfirmTransaction(
                        conn,
                        tx,
                        [user],
                        { skipPreflight: true, preflightCommitment: "processed" }
                    );
                    console.log(`\x1b[36m[${new Date().toLocaleTimeString()}] | SUCCESS | Транзакция клейма фисов отправлена (деген мод)\x1b[0m`);
                } else {
                    // Безопасный мод - ждем подтверждения
                    const txHash = await sendAndConfirmTransaction(
                        conn,
                        tx,
                        [user],
                        { skipPreflight: false, preflightCommitment: "confirmed" }
                    );
                    console.log(`\x1b[36m[${new Date().toLocaleTimeString()}] | SUCCESS | Хэш транзакции клейма фисов: ${txHash}\x1b[0m`);
                }
                
                if (i < claimRewardsTxs.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (error) {
                console.error(`\x1b[31m~~~ [!] | ERROR | ${wallet.description.slice(0, 4)}... Ошибка при отправке транзакции клейма фисов: ${error.message}\x1b[0m`);
            }
        }
    } catch (error) {
        console.error(`\x1b[31m~~~ [!] | ERROR | Ошибка в claimAllRewards: ${error.message}\x1b[0m`);
        throw error;
    }
}

export async function processClaimRewards(wallets, poolAddress, showPositionsTable = true) {
    try {
        console.log(`\n\x1b[36m[⌛] | WAITING | Начало клейма фисов для ${wallets.length} кошельков...\x1b[0m`);
        
        const claimRewardsPromises = wallets.map(async wallet => {
            try {
                const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(wallet.privateKey)));
                await claimAllRewards(user, new PublicKey(poolAddress));
            } catch (error) {
                console.error(`\x1b[31m~~~ [!] | ERROR | ${wallet.description.slice(0, 4)}... Ошибка при клейме фисов\x1b[0m`);
            }
        });
        
        await Promise.all(claimRewardsPromises);
        
        console.log(`\n\x1b[36m[${new Date().toLocaleTimeString()}] | SUCCESS | Клейм фисов завершен\x1b[0m`);

        if (showPositionsTable) {
            await displayPositionsTable(wallets, true);
        }
    } catch (error) {
        console.error(`\x1b[31m~~~ [!] | ERROR | Ошибка при клейме фисов: ${error.message}\x1b[0m`);
    }
}

export async function createTokenPosition(poolAddress, user, strategy = '2') {
    try {
        const conn = await getConnection();
        const dlmmPool = await DLMM.create(conn, poolAddress);
        // Получаем информацию о пуле из API Meteora
        const meteoraResponse = await fetch(`https://app.meteora.ag/clmm-api/pair/${poolAddress.toString()}`);
        const meteoraData = await meteoraResponse.json();
        const tokenMint = meteoraData.mint_x;
        
        // Получаем баланс токена
        const tokenBalance = await getTokenBalance(user.publicKey, tokenMint);
        if (tokenBalance <= 0) {
            console.error(`\x1b[31m~~~ [!] | ERROR | ${user.publicKey.toString().slice(0, 4)}.. Нет токенов для создания позиции\x1b[0m`);
            return;
        }

        const activeBin = await dlmmPool.getActiveBin();
        const totalXAmount = new BN(tokenBalance);
        const totalYAmount = new BN(0);
        
        const minBinId = activeBin.binId;
        const maxBinId = activeBin.binId + TOTAL_RANGE_INTERVAL;
        const newOneSidePosition = Keypair.generate();

        const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: newOneSidePosition.publicKey,
            user: user.publicKey,
            totalXAmount,
            totalYAmount,
            strategy: {
                maxBinId,
                minBinId,
                strategyType: strategy === '1' ? StrategyType.SpotImBalanced : StrategyType.BidAskImBalanced,
            },
        });

        modifyPriorityFeeIx(createPositionTx, 1000000);

        try {
            const createPositionTxHash = await sendAndConfirmTransaction(
                conn,
                createPositionTx,
                [user, newOneSidePosition],
                { skipPreflight: false, preflightCommitment: "confirmed" }
            );
            console.log(`\x1b[36m[${new Date().toLocaleTimeString()}] | SUCCESS | ${user.publicKey.toString().slice(0, 4)}.. Хэш транзакции добавления ликвидности: ${createPositionTxHash}\x1b[0m`);
        } catch (error) {
            console.error("\x1b[31m~~~ [!] | ERROR | Ошибка при отправке транзакции \x1b[0m");
        }
    } catch (error) {
        console.error("\x1b[31m~~~ [!] | ERROR | Ошибка в createTokenPosition\x1b[0m");
    }
}

export async function processCreateTokenPosition(walletData, poolAddress, strategy = '2') {
    try {
        await new Promise(resolve => { setTimeout(resolve, 1000 + Math.random() * 1000) });
        const user = Keypair.fromSecretKey(new Uint8Array(bs58.decode(walletData.privateKey)));        
        await createTokenPosition(new PublicKey(poolAddress), user, strategy);
    } catch (error) {
        console.error(`\x1b[31m~~~ [!] | ERROR | ${walletData.description.slice(0, 4)}... Ошибка при открытии токен позиции: ${error.message}\x1b[0m`);
        throw error;
    }
}